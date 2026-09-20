// One "turn": collect context → build the request under the token cap → ask
// the model → act in Discord like a person would (pause, typing indicator
// proportional to the text, several short messages in a row, reactions).
// Used for answering a call ('reply') and for spontaneous turns
// ('interject' / 'initiate').

import { fetchHistory, fetchNeighbors } from '../discord/collect.js';
import { buildRequest } from './prompt.js';
import { parseOutput } from '../llm/parse.js';
import { DailyCapError, TokenLimitError } from '../llm/openrouter.js';
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

export function createTurnRunner({ hot, store, llm, calibrator, client, rng = Math.random }) {
  const busy = new Set();
  const lastPostAt = new Map(); // channelId -> ts of the persona's last message

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
  async function dryAct(channel, parsed, idByIndex, history, mode) {
    const channelName = channel.name ?? null;
    const dryRunChannelId = hot.config.bot?.dryRunChannelId || '';

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
      const replyId = message.replyTo !== null ? idByIndex.get(message.replyTo) : null;
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

  async function act(channel, parsed, idByIndex, history) {
    const cfg = hot.config.typing;
    const typingOn = hot.config.features?.typingSimulation !== false;

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

      const replyId = message.replyTo !== null ? idByIndex.get(message.replyTo) : null;
      await channel.send({
        content: text,
        reply: replyId ? { messageReference: replyId, failIfNotExists: false } : undefined,
        allowedMentions: { parse: [], users: userIds, repliedUser: true },
      });
      lastPostAt.set(channel.id, Date.now());
    }
  }

  /**
   * @param {object} params
   * @param {import('discord.js').TextBasedChannel} params.channel
   * @param {'reply'|'interject'|'initiate'|'auto'} params.mode  'auto' lets `chooseMode` pick
   *   between interject/initiate/nothing once the history is known (spontaneous turns).
   * @param {object} [params.trigger]      Normalized message that called the persona.
   * @param {string} [params.triggerKind]
   * @param {(history: object[], now: number) => string|null} [params.chooseMode]
   * @returns {Promise<{ outcome: string, mode?: string }>}
   */
  async function runTurn({ channel, mode, trigger = null, triggerKind = null, chooseMode = null }) {
    if (busy.has(channel.id)) return { outcome: 'busy' };
    busy.add(channel.id);
    try {
      const config = hot.config;
      const features = config.features ?? {};
      const memoryOn = features.memory !== false;
      const selfId = client.user.id;
      const guildId = channel.guild.id;
      const now = Date.now();

      const history = await fetchHistory(channel, config.context.channelMessages, selfId);

      let finalMode = mode;
      if (mode === 'auto') {
        finalMode = chooseMode(history, now);
        if (!finalMode) return { outcome: 'not-now' };
      }

      const neighbors = await fetchNeighbors(channel, config, selfId, now);
      const request = buildRequest({
        config,
        prompts: hot.prompts,
        calibrator,
        mode: finalMode,
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
        channels: memoryOn ? store.listChannels(guildId) : [],
        currentChannelId: channel.id,
      });

      let completion;
      try {
        completion = await llm.complete(request.messages);
      } catch (err) {
        // A Discord CDN image the provider cannot fetch must not cost the persona the reply.
        if (request.stats.images > 0 && err.statusCode >= 400 && err.statusCode < 500) {
          const textOnly = request.messages.map((m) =>
            Array.isArray(m.content) ? { ...m, content: m.content.find((part) => part.type === 'text').text } : m,
          );
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
        await dryAct(channel, parsed, request.idByIndex, history, finalMode);
        return { outcome: 'spoke', mode: finalMode, dryRun: true };
      }
      await act(channel, parsed, request.idByIndex, history);
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
    }
  }

  return {
    runTurn,
    isBusy: (channelId) => busy.has(channelId),
    lastPostAt: (channelId) => lastPostAt.get(channelId) ?? 0,
    notePost: (channelId, ts) => lastPostAt.set(channelId, ts),
  };
}
