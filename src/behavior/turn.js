// One "turn": collect context → build the request under the token cap → ask
// the model → act in Discord like a person would (pause, typing indicator
// proportional to the text, several short messages in a row, reactions).
// Used for answering a call ('reply') and for spontaneous turns
// ('interject' / 'initiate').

import { fetchHistory, fetchNeighbors, withTextPreviews } from '../discord/collect.js';
import { buildRequest } from './prompt.js';
import { parseOutput } from '../llm/parse.js';
import { DailyCapError, TokenLimitError } from '../llm/openrouter.js';
import { collectPictures, collectEmojiItems, collectVideos, isDescribable, selectPictures } from '../discord/media.js';
import { createImageFetcher } from '../discord/fetch-image.js';
import { log } from '../log.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Uniform random number inside a `[min, max]` config pair. */
export function between([min, max], rng) {
  return min + (max - min) * rng();
}

/** How long a person would type `text`, per config.typing. */
export function typingMs(text, cfg, rng) {
  const ms = text.length * between(cfg.msPerChar, rng);
  return Math.round(Math.min(cfg.maxMs, Math.max(cfg.minMs, ms)));
}

/** Turn `@nick` written by the model into real mentions for people seen in the transcript. */
export function resolveMentions(text, history) {
  const people = new Map();
  for (const message of history) {
    if (!message.self && !message.bot && message.authorName) people.set(message.authorName, message.authorId);
  }
  const names = [...people.keys()].sort((a, b) => b.length - a.length);
  const userIds = new Set();
  let resolved = text;
  for (const name of names) {
    if (!resolved.includes(`@${name}`)) continue;
    resolved = resolved.replaceAll(`@${name}`, `<@${people.get(name)}>`);
    userIds.add(people.get(name));
  }
  return { text: resolved, userIds: [...userIds] };
}

/** Profiles of the people most recently active in the transcript, excluding `exceptId`. */
function pickOtherProfiles(store, guildId, history, exceptId, count) {
  const seen = new Set();
  const profiles = [];
  for (const message of [...history].reverse()) {
    if (message.self || message.bot || message.authorId === exceptId || seen.has(message.authorId)) continue;
    seen.add(message.authorId);
    const profile = store.getUser(guildId, message.authorId);
    if (profile) profiles.push(profile);
    if (profiles.length >= count) break;
  }
  return profiles;
}

/** Display name of the author of `messageId` in `history`, or null when the message is not there. */
function authorNameFor(history, messageId) {
  const message = history.find((m) => m.id === messageId);
  return message?.authorName ?? null;
}

const REWATCH_QUESTION_CHARS = 300;
const REWATCH_SUMMARY_CHARS = 200;
const REWATCH_CLASSIFIER_MAX_TOKENS = 120;
// Protocol tokens of the re-watch classifier (docs/en/prompt-contract.md), not wording:
// the status column of a `<videos>` line and the answer that asks for a retry.
const REWATCH_STATUS_WATCHED = 'watched';
const REWATCH_STATUS_NOT_LOADED = 'not loaded';
const REWATCH_RETRY = /^retry$/i;

/**
 * Parse the re-watch classifier's answer (prompts/rewatch.md): ONE line,
 * `none` or `<id> | <question>` (`<id> | retry` asks to try a video that did
 * not load again). Only the first non-empty line counts; `none` (any case),
 * anything unparsable, an id that is not exactly one of `candidateIds` or an
 * empty question -> null. The question is trimmed and cut to 300 characters;
 * `retry` is true when it is exactly `retry` (any case).
 * @param {string} raw
 * @param {string[]} candidateIds
 * @returns {{ id: string, question: string, retry: boolean }|null}
 */
export function parseRewatchPick(raw, candidateIds) {
  return parseRewatchPickDetailed(raw, candidateIds).pick;
}

/**
 * parseRewatchPick with the reason for its result, a code safe to log:
 * `none` (the model answered none), `empty` (no non-empty line), `no-bar`,
 * `unknown-id` (an id not among the candidates), `no-question` or `ok`.
 * @param {string} raw
 * @param {string[]} candidateIds
 * @returns {{ pick: { id: string, question: string, retry: boolean }|null,
 *   reason: 'none'|'empty'|'no-bar'|'unknown-id'|'no-question'|'ok' }}
 */
export function parseRewatchPickDetailed(raw, candidateIds) {
  const line = String(raw ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return { pick: null, reason: 'empty' };
  if (/^none$/i.test(line)) return { pick: null, reason: 'none' };
  const bar = line.indexOf('|');
  if (bar === -1) return { pick: null, reason: 'no-bar' };
  const id = line.slice(0, bar).trim();
  const question = [...line.slice(bar + 1).trim()].slice(0, REWATCH_QUESTION_CHARS).join('').trim();
  if (!id || !candidateIds.includes(id)) return { pick: null, reason: 'unknown-id' };
  if (!question) return { pick: null, reason: 'no-question' };
  return { pick: { id, question, retry: REWATCH_RETRY.test(question) }, reason: 'ok' };
}

/** Fill the `{{name}}` placeholder of a prompt file with the persona's display name (as src/behavior/prompt.js does). */
function fillName(template, name) {
  return String(template ?? '').replace(/\{\{name\}\}/g, () => String(name ?? ''));
}

/** Collapse whitespace so a name or summary stays on its one `<videos>` line. */
function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Describable pictures (image/gif/video/sticker/link-thumbnail, plus custom
 * emoji — see src/discord/media.js#isDescribable) of `history` that are NOT
 * among `pickedIds` (the ones already attached as image_url parts), newest
 * message first — so a per-turn cap spends its budget on what the persona
 * just saw. Pictures (collectPictures) come before that message's emoji.
 */
function describableCandidates(history, pickedIds) {
  const out = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    for (const item of [...collectPictures(history[i]), ...collectEmojiItems(history[i])]) {
      if (pickedIds.has(item.itemId) || !isDescribable(item)) continue;
      out.push(item);
    }
  }
  return out;
}

/**
 * `describer` (src/memory/describe.js#createDescriber) is optional: when
 * absent, or `features.mediaDescriptions` is off, no description request is
 * ever made — buildRequest simply renders every un-attached picture blind.
 * Likewise, videos are only watched when `features.mediaDescriptions` AND
 * `features.videoDescriptions` (a missing key counts as on) are on and the describer has
 * `describeVideos`; otherwise they render as before.
 */
export function createTurnRunner({
  hot,
  store,
  llm,
  calibrator,
  client,
  rng = Math.random,
  describer,
  fetchImpl = fetch,
  imageFetcher = createImageFetcher(),
}) {
  const busy = new Set();
  const lastPostAt = new Map(); // channelId -> ts of the persona's last message
  let onIdle = null; // set via setOnIdle(); see the finally block of runTurn below
  let idleWaiters = []; // resolvers for waitIdle() (/nep pause), notified once busy.size hits 0

  /**
   * Post one readable mirror of a would-be action into `dryRunChannelId`, when
   * one is configured. Never throws: a fetch or send failure is logged and
   * swallowed, so a misconfigured mirror channel never costs the persona (or
   * the turn) anything. The channel is fetched fresh every time -- nothing is
   * cached long-lived, so pointing the mirror elsewhere needs no restart.
   */
  async function mirrorDryRun(dryRunChannelId, header, body) {
    if (!dryRunChannelId) return;
    try {
      const mirror = await client.channels.fetch(dryRunChannelId);
      if (!mirror) return;
      await mirror.send({ content: `${header}\n${body}`, allowedMentions: { parse: [] } });
    } catch (err) {
      log.warn('turn: dry-run mirror failed', { dryRunChannelId, error: err });
    }
  }

  /**
   * Dry-run stand-in for `act()`: does everything `act()` would have decided
   * to do, but never touches the target channel -- no sendTyping, no send, no
   * react, no artificial timing. Logs one line per would-be action and, when
   * `bot.dryRunChannelId` is configured, mirrors it there in plain language.
   */
  async function dryAct(channel, parsed, idByIndex, history, mode, triggerKind = null) {
    const channelName = channel.name ?? null;
    const dryRunChannelId = hot.config.bot?.dryRunChannelId || '';
    // A follow-up turn never posts as a Discord reply, in this mirror
    // either -- the model's reply="#n" is ignored the same as in act() below.
    const isFollowUp = triggerKind === 'followUp';

    for (const reaction of parsed.reactions) {
      const targetId = idByIndex.get(reaction.to);
      if (!targetId) continue;
      const authorName = authorNameFor(history, targetId) ?? '—';
      // The ONE deliberate exception to "never log message contents": this is
      // the persona's own output, not a user's, and only while dry-run is on.
      log.info('dry-run: would react', { channel: channel.id, channelName, to: targetId, emoji: reaction.emoji });
      await mirrorDryRun(
        dryRunChannelId,
        `[dry-run] #${channelName} · ${mode} · reply to ${authorName}`,
        `reacts with ${reaction.emoji} to ${authorName}`,
      );
      lastPostAt.set(channel.id, Date.now());
    }

    for (const message of parsed.messages) {
      const replyId = !isFollowUp && message.replyTo !== null ? idByIndex.get(message.replyTo) : null;
      const authorName = replyId ? (authorNameFor(history, replyId) ?? '—') : '—';
      // Same deliberate exception as above: the persona's own output, dry-run only.
      const { text } = resolveMentions(message.text, history);
      log.info('dry-run: would send', { channel: channel.id, channelName, mode, replyTo: replyId ?? null, text });
      // The mirror shows @name as the model wrote it: resolving it to a real
      // mention here would ping someone in a channel meant to be invisible to them.
      await mirrorDryRun(
        dryRunChannelId,
        `[dry-run] #${channelName} · ${mode} · reply to ${authorName}`,
        message.text,
      );
      lastPostAt.set(channel.id, Date.now());
    }
  }

  async function act(channel, parsed, idByIndex, history, startedAt = Date.now(), triggerKind = null) {
    const cfg = hot.config.typing;
    const typingOn = hot.config.features?.typingSimulation !== false;
    // A follow-up turn (triggerKind: 'followUp') is its own trigger kind
    // and never posts as a Discord reply -- the model's reply="#n" (if any)
    // is ignored, plain messages only.
    const isFollowUp = triggerKind === 'followUp';

    for (const reaction of parsed.reactions) {
      const targetId = idByIndex.get(reaction.to);
      if (!targetId) continue;
      if (typingOn) await sleep(between(cfg.reactionDelayMs, rng));
      try {
        const target = await channel.messages.fetch(targetId);
        await target.react(reaction.emoji);
      } catch (err) {
        log.warn('turn: reaction failed', { emoji: reaction.emoji, error: err });
      }
    }

    let first = true;
    for (const message of parsed.messages) {
      if (!first && typingOn) await sleep(between(cfg.betweenMessagesMs, rng));
      first = false;

      const { text, userIds } = resolveMentions(message.text, history);
      if (typingOn) {
        await channel.sendTyping().catch(() => {});
        await sleep(typingMs(text, cfg, rng));
      }

      const replyId = !isFollowUp && message.replyTo !== null ? idByIndex.get(message.replyTo) : null;
      await channel.send({
        content: text,
        reply: replyId ? { messageReference: replyId, failIfNotExists: false } : undefined,
        allowedMentions: { parse: [], users: userIds, repliedUser: true },
      });
      lastPostAt.set(channel.id, Date.now());
      log.info('turn: sent', {
        channel: channel.id,
        chars: text.length,
        secondsSinceTrigger: Math.round((Date.now() - startedAt) / 100) / 10,
        ...(isFollowUp ? { followUp: true } : {}),
      });
    }
  }

  /**
   * The re-watch on a question (features.videoRewatch): when the trigger
   * asks about a video watched in the last `media.video.rewatch.recentMessages`
   * messages (at most `media.video.rewatch.maxCandidates` of them, newest
   * first), one cheap classifier call (prompts.rewatch) picks the video and
   * the question, then the describer looks at it again
   * (describer.rewatchVideo) and the answer joins that video's state as
   * `answer: { question, text }` -- mutating `videos` in place. Videos that
   * did not load (`error` state) are candidates too, while this turn still
   * has a `media.video.maxPerTurn` attempt left (`attemptsUsed` so far): the
   * classifier's `<id> | retry` watches one again with `force`
   * (describer.describeVideo) and its new state replaces the old one. At
   * most one re-watch or retry per turn. Never throws: any failure leaves
   * `videos` as it was. The question and the answer are data: never logged;
   * every early stop logs `rewatch: skipped` with its reason.
   */
  async function maybeRewatch({ config, guildId, channelId, selfName, history, trigger, videos, candidates, attemptsUsed = 0 }) {
    const prompt = hot.prompts?.rewatch;
    if (!prompt) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-prompt' });
      return;
    }
    const system = fillName(prompt, selfName);
    const mediaCfg = config.media ?? {};
    const rewatchCfg = mediaCfg.video?.rewatch ?? {};
    const recent = Math.max(0, Math.floor(rewatchCfg.recentMessages ?? 60));
    if (recent === 0) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-window' });
      return;
    }
    // `candidates` is already newest first, so the cap keeps the newest videos.
    const maxCandidates = Math.max(1, Math.floor(rewatchCfg.maxCandidates ?? 6));
    // A retry is a fetch attempt: offered only while this turn has one left.
    const canRetry =
      typeof describer.describeVideo === 'function' && attemptsUsed < (mediaCfg.video?.maxPerTurn ?? 1);
    const recentIds = new Set(history.slice(-recent).map((m) => m.id));
    const seen = new Set();
    const watched = [];
    for (const item of candidates) {
      if (watched.length >= maxCandidates) break;
      if (seen.has(item.itemId) || !recentIds.has(item.messageId)) continue;
      const state = videos.get(item.itemId)?.state;
      if (state !== 'watched' && !(state === 'error' && canRetry)) continue;
      seen.add(item.itemId);
      watched.push(item);
    }
    if (watched.length === 0) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-watched', watched: 0, recent });
      return;
    }

    const lines = watched.map((item) => {
      const video = videos.get(item.itemId);
      const status = video.state === 'watched' ? REWATCH_STATUS_WATCHED : REWATCH_STATUS_NOT_LOADED;
      const summary = video.state === 'watched' ? [...oneLine(video.text)].slice(0, REWATCH_SUMMARY_CHARS).join('') : '';
      return `${item.itemId} | ${oneLine(item.name)} | ${status} | ${summary}`.trimEnd();
    });
    const triggerText = [...String(trigger.content ?? '')].slice(0, config.context?.maxMessageChars ?? 800).join('');
    const user = `<videos>\n${lines.join('\n')}\n</videos>\n<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`;

    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        {
          model: rewatchCfg.model || config.mention?.followUpModel || mediaCfg.model,
          maxOutputTokens: REWATCH_CLASSIFIER_MAX_TOKENS,
          timeoutMs: config.llm?.timeoutMs,
          countAgainstDailyCap: true,
          skipCalibration: true,
        },
      );
    } catch (err) {
      log.warn('rewatch: classifier failed', { channel: channelId, status: err.statusCode ?? null, name: err.name });
      return;
    }
    const { pick, reason } = parseRewatchPickDetailed(completion.text, watched.map((item) => item.itemId));
    const item = pick ? watched.find((candidate) => candidate.itemId === pick.id) : null;
    const loaded = item ? videos.get(item.itemId).state === 'watched' : false;
    // A retry is for a video that did not load, a question for a watched one; anything else is ignored.
    const usable = Boolean(item) && pick.retry !== loaded;
    const watchedCount = watched.filter((candidate) => videos.get(candidate.itemId).state === 'watched').length;
    // Codes and counts only, never the question: an answer outside the format hints at a prompt mismatch.
    const level = reason === 'unknown-id' || reason === 'no-bar' ? 'warn' : 'info';
    log[level]('rewatch: classified', {
      channel: channelId,
      candidates: watched.length,
      offered: { watched: watchedCount, notLoaded: watched.length - watchedCount },
      retryAllowed: canRetry,
      parse: reason,
      kind: pick ? (pick.retry ? 'retry' : 'question') : null,
      picked: usable,
    });
    if (!usable) return;

    if (pick.retry) {
      const retried = await describer.describeVideo(guildId, item, { force: true });
      if (retried) videos.set(item.itemId, retried);
      return;
    }
    const answer = await describer.rewatchVideo(guildId, item, pick.question);
    if (answer) videos.set(item.itemId, { ...videos.get(item.itemId), answer });
  }

  /**
   * @param {object} params
   * @param {import('discord.js').TextBasedChannel} params.channel
   * @param {'reply'|'interject'|'initiate'|'auto'} params.mode  'auto' lets `chooseMode` pick
   *   between interject/initiate/nothing once the history is known (spontaneous turns).
   * @param {object} [params.trigger]      Normalized message that called the persona.
   * @param {string} [params.triggerKind]
   * @param {(history: object[], now: number) => string|null} [params.chooseMode]
   * @param {boolean} [params.forced]  True for an owner-forced turn (`/nep interject`, `/nep
   *   initiate`) -- passed straight through to buildRequest, which appends prompts.forced (when
   *   present) to the task text so the model knows `<skip/>` is not the expected outcome this time.
   * @returns {Promise<{ outcome: string, mode?: string }>}
   */
  async function runTurn({ channel, mode, trigger = null, triggerKind = null, chooseMode = null, forced = false }) {
    // /nep pause: the owner is editing data/ by hand -- no new turn may
    // start (a reply, an interject, an initiate, an eavesdrop, or a forced turn)
    // until /nep resume. A turn already in flight when the pause is
    // requested is left to finish naturally; admin.js's pause handler waits
    // for it via waitIdle() below instead of aborting it here.
    if (store.state.data.paused) return { outcome: 'paused' };
    if (busy.has(channel.id)) return { outcome: 'busy' };
    // One attention (config.mention.oneAtATime, default on): while a turn is
    // running anywhere else, nothing else may start. src/discord/events.js
    // is the only caller that turns a direct ping caught by this into a
    // pending one instead of just dropping it -- this rail applies to every
    // caller (a reply, an interject, an initiate, an eavesdrop) alike.
    const oneAtATime = hot.config.mention?.oneAtATime !== false;
    if (oneAtATime && busy.size > 0) return { outcome: 'busy' };
    busy.add(channel.id);
    try {
      const config = hot.config;
      const features = config.features ?? {};
      const memoryOn = features.memory !== false;
      const selfId = client.user.id;
      const guildId = channel.guild.id;
      const now = Date.now();
      const startedAt = now;

      let history = await fetchHistory(
        channel,
        config.context.channelMessages,
        selfId,
        config.media?.embedTextChars,
        config.media?.video?.sites,
      );

      let finalMode = mode;
      if (mode === 'auto') {
        finalMode = chooseMode(history, now);
        if (!finalMode) return { outcome: 'not-now' };
      }

      // Lazy, request-time only (see fetchTextPreview's header comment):
      // never fetched during plain normalization or while just buffered.
      history = await withTextPreviews(history, config.media?.filePreviewChars ?? 500, fetchImpl);

      // Pictures NOT selected to be attached as image_url may still get a
      // helper's caption, newest first, capped at media.maxPerTurn; cached
      // captions are free (see src/memory/describe.js).
      let descriptions;
      if (hot.config.features?.mediaDescriptions === true && describer) {
        const visionCfg = config.context.vision ?? {};
        const picked = features.vision !== false ? selectPictures({ trigger, history, visionCfg, now }) : [];
        const pickedIds = new Set(picked.map((p) => p.itemId));
        const candidates = describableCandidates(history, pickedIds);
        const described = await describer.describeMany(guildId, candidates, {
          maxNew: config.media?.maxPerTurn ?? Infinity,
          countAgainstDailyCap: true,
        });
        descriptions = described.descriptions;
      }

      // Videos (attached, or linked from a known video site) may be watched
      // by the video describer, newest first, at most media.video.maxPerTurn
      // NEW ones per turn; cached results and limit/error states are free.
      let videos;
      // Both switches, like the senses line (src/behavior/prompt.js#renderSenses); a missing
      // videoDescriptions counts as on.
      const videoOn = features.mediaDescriptions === true && features.videoDescriptions !== false;
      if (videoOn && typeof describer?.describeVideos === 'function') {
        const videoCfg = config.media?.video ?? {};
        const candidates = [];
        for (let i = history.length - 1; i >= 0; i -= 1) {
          candidates.push(...collectVideos(history[i], { sites: videoCfg.sites }));
        }
        const watched = await describer.describeVideos(guildId, candidates, {
          maxNew: videoCfg.maxPerTurn ?? 1,
          countAgainstDailyCap: true,
        });
        videos = watched.videos;

        // A second look when the trigger asks about a watched video: a
        // direct address only (never a spontaneous turn), switch
        // features.videoRewatch (a missing key counts as on).
        if (trigger && features.videoRewatch !== false && typeof describer.rewatchVideo === 'function') {
          try {
            const selfName = channel.guild.members.me?.displayName ?? client.user.username;
            await maybeRewatch({
              config,
              guildId,
              channelId: channel.id,
              selfName,
              history,
              trigger,
              videos,
              candidates,
              attemptsUsed: watched.newCount ?? 0,
            });
          } catch (err) {
            log.warn('rewatch: failed', { channel: channel.id, error: err });
          }
        }
      }

      const neighbors = await fetchNeighbors(channel, config, selfId, now);
      const request = buildRequest({
        config,
        prompts: hot.prompts,
        calibrator,
        mode: finalMode,
        forced,
        now,
        selfName: channel.guild.members.me?.displayName ?? client.user.username,
        history,
        neighbors,
        trigger,
        triggerKind,
        guildMemory: memoryOn ? store.getGuild(guildId) : {},
        interlocutor: memoryOn && trigger ? store.getUser(guildId, trigger.authorId) : null,
        otherProfiles: memoryOn
          ? pickOtherProfiles(store, guildId, history, trigger?.authorId, config.context.otherProfiles)
          : [],
        candidateProfiles: memoryOn ? store.listUserProfiles(guildId) : [],
        nameOf: memoryOn ? (id) => store.getUser(guildId, id)?.names?.[0] ?? null : undefined,
        channels: memoryOn ? store.listChannels(guildId) : [],
        loreEntries: memoryOn ? store.getLore(guildId) : [],
        currentChannelId: channel.id,
        descriptions,
        videos,
      });

      // A Discord CDN image the provider cannot fetch must not cost the
      // persona the reply -- the provider's own fetcher gets a 403 from
      // Discord on some CDN hosts, so every image_url part is downloaded HERE
      // and replaced by its data: URL before the model ever sees a Discord
      // URL. Because the transcript text refers to attached pictures by
      // number, a turn where ANY download failed is sent with
      // request.textFallback and NO pictures at all -- simple and always
      // consistent, rather than renumbering around a gap.
      let messages = request.messages;
      const userMessage = messages[1];
      if (Array.isArray(userMessage?.content)) {
        const visionCfg = config.context.vision ?? {};
        let allDownloaded = true;
        const resolvedContent = await Promise.all(
          userMessage.content.map(async (part) => {
            if (part.type !== 'image_url') return part;
            const downloaded = await imageFetcher.fetchAsDataUrl(part.image_url.url, {
              maxBytes: visionCfg.maxBytes,
              timeoutMs: visionCfg.fetchTimeoutMs,
            });
            if (!downloaded) {
              allDownloaded = false;
              return part;
            }
            return { type: 'image_url', image_url: { url: downloaded.dataUrl } };
          }),
        );
        messages = [messages[0], { ...userMessage, content: allDownloaded ? resolvedContent : request.textFallback }];
      }

      let completion;
      try {
        completion = await llm.complete(messages);
      } catch (err) {
        // Second line of defence: the picture downloaded fine on our end but
        // the provider still rejects the request for some 4xx reason.
        // request.textFallback is a full re-render of the same user message
        // with every imageAttached/frameAttached tag dropped back to its
        // blind/described form -- resending the ORIGINAL text (still
        // claiming a picture is attached) alongside no actual image would be
        // worse than the error itself.
        if (Array.isArray(messages[1]?.content) && err.statusCode >= 400 && err.statusCode < 500) {
          const textOnly = messages.map((m) => (Array.isArray(m.content) ? { ...m, content: request.textFallback } : m));
          completion = await llm.complete(textOnly);
        } else {
          throw err;
        }
      }

      const parsed = parseOutput(completion.text);
      // Feature switches drop parts of the model's output before it is acted on.
      if (features.reactions === false) parsed.reactions = [];
      if (features.multiMessage === false) parsed.messages = parsed.messages.slice(0, 1);
      const nothingToDo = parsed.messages.length === 0 && parsed.reactions.length === 0;

      log.info('turn: model answered', {
        mode: finalMode,
        secondsToAnswer: Math.round((Date.now() - startedAt) / 100) / 10,
        channel: channel.id,
        estimated: completion.estimated,
        usage: completion.usage,
        calibration: Number(calibrator.ratio.toFixed(3)),
        budget: request.stats,
        think: parsed.think,
        skip: parsed.skip || nothingToDo,
        messages: parsed.messages.length,
        reactions: parsed.reactions.length,
      });
      store.state.data.calibration = calibrator.ratio;
      store.state.markDirty();

      if (parsed.skip || nothingToDo) return { outcome: 'skip', mode: finalMode };

      // Read fresh right here, not from the `features` snapshot taken at the
      // top of this turn: unlike the other switches this one defaults to OFF,
      // and whether to actually post is the very last decision of a turn.
      if (hot.config.features?.dryRun === true) {
        await dryAct(channel, parsed, request.idByIndex, history, finalMode, triggerKind);
        return { outcome: 'spoke', mode: finalMode, dryRun: true };
      }
      await act(channel, parsed, request.idByIndex, history, startedAt, triggerKind);
      return { outcome: 'spoke', mode: finalMode };
    } catch (err) {
      if (err instanceof DailyCapError || err instanceof TokenLimitError) {
        log.warn('turn: refused by a safety rail', { error: err });
        return { outcome: 'refused' };
      }
      log.error('turn: failed', { channel: channel.id, error: err });
      return { outcome: 'error' };
    } finally {
      busy.delete(channel.id);
      // Fire-and-forget, same as the caller of runTurn itself: whatever
      // wants to run next (src/discord/events.js's pending-ping drain, wired
      // in src/index.js) must never hold up -- or throw into -- the turn
      // that just freed the channel.
      if (onIdle) {
        Promise.resolve()
          .then(() => onIdle())
          .catch((err) => log.warn('turn: onIdle failed', { error: err }));
      }
      if (busy.size === 0 && idleWaiters.length > 0) {
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  return {
    runTurn,
    isBusy: (channelId) => busy.has(channelId),
    isAnyBusy: () => busy.size > 0,
    lastPostAt: (channelId) => lastPostAt.get(channelId) ?? 0,
    notePost: (channelId, ts) => lastPostAt.set(channelId, ts),
    /**
     * Resolves once no turn is in flight anywhere -- immediately if that is
     * already true. Used by admin.js's `/nep pause` to wait out a turn
     * that was already running when the pause was requested, instead of
     * aborting it.
     * @returns {Promise<void>}
     */
    waitIdle: () => (busy.size === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve))),
    /** Called (never awaited by runTurn) every time a turn finishes anywhere, once the channel is freed. */
    setOnIdle: (fn) => {
      onIdle = fn;
    },
  };
}
