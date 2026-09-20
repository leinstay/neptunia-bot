// Assembles one LLM request for a turn. Pure: takes already-fetched data and
// the live prompts/config, returns chat-completions messages. The token budget
// is spent in this priority order (see src/llm/budget.js):
//   1. system prompt (persona + live rules + output format), task, clock, tempo — never cut
//   2. memory about the person the persona is talking to
//   3. how this server talks + what the persona has said about itself
//   4. the map of the server's channels
//   5. the channel transcript, newest messages first
//   6. memory about other people present in the transcript
//   7. neighbouring channels
// The rendered order is different: reference material first, the chat and the
// task last, where the model attends best.

import { fitSections } from '../llm/budget.js';
import { estimateTokens } from '../llm/tokens.js';
import { computeTempo, fill, formatNow, formatTranscript, renderTempo, renderTranscript } from '../discord/format.js';
import { affinityBand } from '../memory/affinity.js';
import { sortEpisodesForDisplay } from '../memory/episodes.js';
import { matchLore } from '../memory/lore.js';
import { channelActivity, renderChannel } from '../memory/channels.js';
import { selectPictures, mediaProxyUrl } from '../discord/media.js';

const TAG_OVERHEAD = 60;

function block(tag, body) {
  return body ? `<${tag}>\n${body}\n</${tag}>` : '';
}

/**
 * The caller's remembered episodes as `[heading, ...oneLinePerEpisode]`,
 * heaviest weight first then newest (see sortEpisodesForDisplay). `[]` when
 * there is nothing to show, or when `labels.profile` lacks any of
 * `episodes`/`episode`/`episodeNoQuote` — an older labels.json simply never
 * renders this, see .claude/docs/prompt-contract.md.
 */
function episodeLines(episodes, labels) {
  const p = labels.profile;
  if (!Array.isArray(episodes) || episodes.length === 0) return [];
  if (!p.episodes || !p.episode || !p.episodeNoQuote) return [];
  const lines = sortEpisodesForDisplay(episodes).map((ep) =>
    fill(ep.quote ? p.episode : p.episodeNoQuote, { date: ep.date, what: ep.what, quote: ep.quote, feeling: ep.feeling }),
  );
  return [p.episodes, ...lines];
}

/**
 * Keep `lines[0]` (the episodes heading) plus as many of the following lines
 * (already ordered heaviest-first) as fit `remaining` tokens on top of
 * `restCost` (the rest of the profile) -- the lightest ones are dropped first
 * simply because they sort last. `[]` when even the heading does not fit.
 */
function fitEpisodeLines(lines, remaining, cost) {
  if (lines.length === 0) return [];
  const [heading, ...rest] = lines;
  const headingCost = cost(heading);
  if (headingCost > remaining) return [];
  const kept = [heading];
  let used = headingCost;
  for (const line of rest) {
    const price = cost(line);
    if (used + price > remaining) break;
    kept.push(line);
    used += price;
  }
  return kept;
}

/**
 * One person's memory as prompt text; '' when nothing has been learned yet.
 * When `relationships` is on and the profile carries a non-neutral (non-zero
 * score or non-empty reason) affinity, an attitude line is inserted right
 * after the heading — even when it ends up being the profile's only content,
 * since the persona's attitude toward someone is useful on its own.
 *
 * For the interlocutor (`interlocutor: true`), right after the attitude line
 * (or right after the heading, if there is none), `opts.episodes.enabled`
 * additionally renders the caller's remembered episodes -- see
 * .claude/docs/prompt-contract.md, "<people>". `opts.episodes.cap`/`.cost`
 * (when given) trim the episode list, heaviest-first, to fit that token
 * budget on top of the rest of the profile; without them every episode
 * renders.
 */
export function renderProfile(profile, labels, { interlocutor = false, relationships = false, episodes } = {}) {
  if (!profile) return '';
  const p = labels.profile;
  const name = profile.names?.[0] ?? profile.id;

  const attitudeLines = [];
  const affinity = profile.affinity;
  const hasAffinity = relationships && affinity && (affinity.score !== 0 || Boolean(affinity.reason));
  if (hasAffinity) {
    attitudeLines.push(
      fill(p.affinity, { score: affinity.score, band: labels.affinity?.bands?.[affinityBand(affinity.score)], reason: affinity.reason }),
    );
  }

  const restLines = [];
  if (profile.names?.length > 1) restLines.push(fill(p.formerNames, { names: profile.names.slice(1).join(', ') }));
  if (profile.character) restLines.push(fill(p.character, { text: profile.character }));
  if (profile.interests) restLines.push(fill(p.interests, { text: profile.interests }));
  if (profile.style) restLines.push(fill(p.style, { text: profile.style }));
  if (profile.details?.length) restLines.push(fill(p.details, { text: profile.details.join('; ') }));
  if (profile.relationship) restLines.push(fill(p.relationship, { text: profile.relationship }));
  const hasContent = attitudeLines.length > 0 || restLines.length > 0;
  if (!hasContent && !interlocutor) return '';
  if (!hasContent) restLines.push(p.unknown);
  if (profile.messageCount) restLines.push(fill(p.messageCount, { count: profile.messageCount }));

  const mark = interlocutor ? p.interlocutorMark : '';
  const heading = `## ${name}${mark}`;

  let renderedEpisodes = interlocutor && episodes?.enabled ? episodeLines(profile.episodes, labels) : [];
  if (renderedEpisodes.length && typeof episodes.cap === 'number' && typeof episodes.cost === 'function') {
    const restText = [heading, ...attitudeLines, ...restLines].join('\n');
    renderedEpisodes = fitEpisodeLines(renderedEpisodes, episodes.cap - episodes.cost(restText), episodes.cost);
  }

  return [heading, ...attitudeLines, ...renderedEpisodes, ...restLines].join('\n');
}

/**
 * Render the <server> block: the current channel first (marked via
 * `labels.server.currentMark`), then the rest by `lastMessageAt` descending —
 * a channel never seen yet sorts last. See .claude/docs/prompt-contract.md,
 * "Server memory (the channel map)".
 */
function serverItems(channels, currentChannelId, now, activityCfg, labels) {
  const current = channels.find((channel) => channel.id === currentChannelId);
  const rest = channels
    .filter((channel) => channel.id !== currentChannelId)
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  const ordered = current ? [current, ...rest] : rest;
  return ordered.map((channel) =>
    renderChannel(channel, labels, {
      current: channel.id === currentChannelId,
      activity: channelActivity(channel, now, activityCfg),
    }),
  );
}

function aboutChatItems(guildMemory, labels) {
  const a = labels.aboutChat;
  const items = [];
  if (guildMemory?.patterns) items.push(fill(a.patterns, { text: guildMemory.patterns }));
  if (guildMemory?.starters) items.push(fill(a.starters, { text: guildMemory.starters }));
  if (guildMemory?.injokes?.length) items.push(fill(a.injokes, { text: guildMemory.injokes.join('; ') }));
  return items;
}

/**
 * Render the `<lore>` block's entries: whatever `matchLore` (src/memory/lore.js)
 * surfaces from the last `lore.scanMessages` transcript messages plus the
 * trigger, via `labels.lore.entry`. `[]` when there is no stored lore, no
 * match, or `labels.lore.entry` is missing (an older labels.json never
 * breaks -- the block is simply omitted).
 */
function loreItems(loreEntries, history, trigger, labels, loreCfg) {
  const entry = labels.lore?.entry;
  if (!entry) return [];
  const entries = Array.isArray(loreEntries) ? loreEntries : [];
  if (entries.length === 0) return [];

  const scan = Math.max(0, loreCfg?.scanMessages ?? 30);
  const recentTexts = history.slice(-scan).map((m) => m.content ?? '').filter(Boolean);
  if (trigger?.content) recentTexts.push(trigger.content);

  const matched = matchLore(entries, recentTexts, { maxMatches: loreCfg?.maxMatches ?? Infinity });
  return matched.map((lore) => fill(entry, { title: lore.title, text: lore.text }));
}

/**
 * Assemble the `<now>…<task>` user-message text from already-rendered parts.
 * Factored out so a fallback rendering (see `textFallback` below) can reuse
 * every block untouched except `<chat>`, which is the only one that can ever
 * carry an `imageAttached`/`frameAttached` tag.
 */
function assembleUser({ now, timezone, labels, sensesText, kept, tempoText, task, chatItems }) {
  return [
    block('now', formatNow(now, timezone, labels.locale)),
    block('senses', sensesText),
    block('about_chat', kept.aboutChat.join('\n')),
    block('server', kept.server.join('\n\n')),
    block('lore', kept.lore.join('\n\n')),
    block('self_facts', kept.self.join('\n')),
    block('people', [...kept.interlocutor, ...kept.people].join('\n\n')),
    block('other_channels', kept.neighbors.join('\n\n')),
    block('chat', renderTranscript(chatItems, timezone, labels)),
    block('tempo', tempoText),
    block('task', task),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function fillTemplate(template, values) {
  return (template ?? '').replace(/\{\{(\w+)\}\}/g, (all, key) => values[key] ?? all);
}

/** A deployment with no/broken labels.json must fail loudly, not send a broken prompt. */
function requireLabels(prompts) {
  const labels = prompts?.labels;
  if (!labels || !labels.transcript) {
    throw new Error('prompts.labels is missing or incomplete: labels.transcript is required');
  }
  return labels;
}

/**
 * Render the `<senses>` block from `labels.senses`: which lines are true
 * under the live config (see .claude/docs/prompt-contract.md, "`<senses>`").
 * Returns '' when `labels.senses` is missing entirely, so an older
 * deployment's labels.json never breaks — the block is simply omitted.
 */
function renderSenses(config, labels) {
  const senses = labels.senses;
  if (!senses) return '';
  const visionOn = config.features?.vision !== false;
  const describedOn = config.features?.mediaDescriptions === true;
  const lines = [];
  if (visionOn) lines.push(senses.imageSee);
  lines.push(describedOn ? senses.imageDescribed : senses.imageBlind);
  lines.push(describedOn ? senses.gifDescribed : senses.gifBlind);
  lines.push(describedOn ? senses.videoDescribed : senses.videoBlind);

  // Stickers get their own lines (a picture-format one behaves like an
  // image); senses.lottie only shows up alongside them -- an animated
  // built-in (Lottie) sticker is never a picture, name only, regardless of
  // vision/mediaDescriptions.
  const stickerLines = [];
  if (visionOn) stickerLines.push(senses.stickerSee);
  stickerLines.push(describedOn ? senses.stickerDescribed : senses.stickerBlind);
  const shownStickerLines = stickerLines.filter(Boolean);
  lines.push(...shownStickerLines);
  if (shownStickerLines.length > 0) lines.push(senses.lottie);

  lines.push(senses.voice, senses.links, senses.files);
  return lines.filter(Boolean).join('\n');
}

/**
 * @param {object} input
 * @param {object} input.config            Live config.
 * @param {object} input.prompts           Live prompts keyed by file name.
 * @param {object} input.calibrator
 * @param {'reply'|'interject'|'initiate'} input.mode
 * @param {number} input.now
 * @param {string} input.selfName
 * @param {object[]} input.history         Normalized channel messages, oldest first.
 * @param {{channelName: string, messages: object[]}[]} input.neighbors
 * @param {object|null} input.trigger      Normalized message that called the persona (reply mode).
 * @param {string|null} input.triggerKind
 * @param {object} input.guildMemory
 * @param {object|null} input.interlocutor Profile of the trigger's author.
 * @param {object[]} input.otherProfiles   Profiles of other people in the transcript, most relevant first.
 * @param {object[]} [input.channels]      The server's channel map (store.listChannels), [] when memory is off.
 * @param {object[]} [input.loreEntries]   The guild's stored lorebook (store.getLore), [] when memory is off.
 * @param {string|null} [input.currentChannelId]  Id of the channel this turn happens in.
 * @param {Map<string, string>} [input.descriptions]  Item id -> describer caption, for pictures
 *   NOT selected to be attached (see src/behavior/turn.js, src/memory/describe.js).
 * @returns {{ messages: object[], stats: object, idByIndex: Map<number, string>, tempo: object }}
 */
export function buildRequest(input) {
  const { config, prompts, calibrator, mode, now, selfName, history, neighbors, trigger, triggerKind, channels = [], currentChannelId = null, descriptions } = input;
  const labels = requireLabels(prompts);
  const { timezone } = config.bot;
  const relationships = config.features?.relationships !== false;
  const episodesOn = config.features?.episodes !== false;
  const loreOn = config.features?.lore !== false;
  const visionCfg = config.context.vision ?? {};
  const visionOn = config.features?.vision !== false;
  const pictures = visionOn ? selectPictures({ trigger, history, visionCfg, now }) : [];
  const attachedIndex = new Map(pictures.map((picture, i) => [picture.itemId, i + 1]));
  const formatOptions = {
    timezone,
    gapMinutes: config.context.gapMarkerMinutes,
    maxChars: config.context.maxMessageChars,
    selfName,
    labels,
    attachedIndex,
    descriptions,
  };

  const nameFill = (text) => fillTemplate(text, { name: selfName });
  const system = [prompts['system-prompt'], prompts['character-card'], prompts.rules, prompts.format]
    .map(nameFill)
    .filter(Boolean)
    .join('\n\n');
  const chatItems = formatTranscript(history, formatOptions);
  const idByIndex = new Map(chatItems.map((item) => [item.index, item.id]));
  const tempo = computeTempo(history, now, trigger);
  const tempoText = renderTempo(tempo, labels, config.context.tempo);

  const triggerItem = trigger ? chatItems.find((item) => item.id === trigger.id) : null;
  const task = fillTemplate(prompts[mode] ?? '', {
    name: selfName,
    author: trigger?.authorName ?? '',
    trigger: labels.triggers?.[triggerKind] ?? '',
    target: triggerItem ? `#${triggerItem.index}` : '',
  });

  const sensesText = renderSenses(config, labels);

  const neighborItems = neighbors.map(
    ({ channelName, messages }) =>
      `# ${channelName}\n${formatTranscript(messages, { ...formatOptions, maxChars: 300 })
        .map((item) => item.text.replace(/^#\d+ /gm, ''))
        .join('\n')}`,
  );

  const caps = config.context.caps;
  const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
  const limit =
    Math.floor(config.llm.maxRequestTokens * config.llm.safetyMargin) -
    pictures.length * (visionCfg.tokensPerImage ?? 0) -
    TAG_OVERHEAD;

  const episodesOpt = { enabled: episodesOn, cap: caps.interlocutor, cost };
  const { kept, stats, used } = fitSections(
    [
      { name: 'fixed', required: true, items: [system, task, formatNow(now, timezone, labels.locale), sensesText, tempoText] },
      {
        name: 'interlocutor',
        cap: caps.interlocutor,
        items: [renderProfile(input.interlocutor, labels, { interlocutor: true, relationships, episodes: episodesOpt })].filter(Boolean),
      },
      { name: 'aboutChat', cap: caps.aboutChat, items: aboutChatItems(input.guildMemory, labels) },
      { name: 'self', cap: caps.aboutChat, items: (input.guildMemory?.self ?? []).map((fact) => `- ${fact}`) },
      {
        name: 'lore',
        cap: caps.lore,
        keep: 'first',
        items: loreOn ? loreItems(input.loreEntries, history, trigger, labels, config.lore) : [],
      },
      {
        name: 'server',
        cap: caps.server ?? 2500,
        keep: 'first',
        items: serverItems(channels, currentChannelId, now, config.context.channelActivity, labels),
      },
      { name: 'chat', keep: 'newest', items: chatItems.map((item) => item.text) },
      {
        name: 'people',
        cap: caps.people,
        items: input.otherProfiles.map((profile) => renderProfile(profile, labels, { relationships })).filter(Boolean),
      },
      { name: 'neighbors', cap: caps.neighbors, items: neighborItems },
    ],
    limit,
    cost,
  );

  const keptChat = chatItems.slice(chatItems.length - kept.chat.length);
  const user = assembleUser({ now, timezone, labels, sensesText, kept, tempoText, task, chatItems: keptChat });

  // A provider that rejects the images (see src/behavior/turn.js's 4xx
  // retry) must never resend a <chat> claiming a picture is attached with
  // nothing actually attached: `textFallback` re-renders the SAME kept
  // messages with attachedIndex dropped, so imageAttached/frameAttached fall
  // back to their blind/described forms. Every other block is identical
  // (none of them ever depend on attachedIndex), so it is computed only when
  // there is anything to fall back from.
  let textFallback = null;
  if (pictures.length) {
    const chatItemsBlind = formatTranscript(history, { ...formatOptions, attachedIndex: undefined });
    const keptChatBlind = chatItemsBlind.slice(chatItemsBlind.length - kept.chat.length);
    textFallback = assembleUser({ now, timezone, labels, sensesText, kept, tempoText, task, chatItems: keptChatBlind });
  }

  // A sticker's URL is already fully sized (see src/discord/media.js
  // stickerUrl: `size=`, not width/height/format) -- the media proxy must
  // never touch it again.
  const pictureUrl = (picture) =>
    picture.kind === 'sticker'
      ? picture.url
      : mediaProxyUrl(picture.url, { width: visionCfg.imageSize, height: visionCfg.imageSize, format: 'webp' });

  const content = pictures.length
    ? [
        { type: 'text', text: user },
        ...pictures.map((picture) => ({
          type: 'image_url',
          image_url: { url: pictureUrl(picture) },
        })),
      ]
    : user;

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
    stats: { ...stats, used, limit, images: pictures.length },
    idByIndex,
    tempo,
    pictures,
    textFallback,
  };
}
