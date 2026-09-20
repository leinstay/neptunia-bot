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
import { channelActivity, renderChannel } from '../memory/channels.js';
import { selectPictures, mediaProxyUrl } from '../discord/media.js';

const TAG_OVERHEAD = 60;

function block(tag, body) {
  return body ? `<${tag}>\n${body}\n</${tag}>` : '';
}

/**
 * One person's memory as prompt text; '' when nothing has been learned yet.
 * When `relationships` is on and the profile carries a non-neutral (non-zero
 * score or non-empty reason) affinity, an attitude line is inserted right
 * after the heading — even when it ends up being the profile's only content,
 * since the persona's attitude toward someone is useful on its own.
 */
export function renderProfile(profile, labels, { interlocutor = false, relationships = false } = {}) {
  if (!profile) return '';
  const p = labels.profile;
  const name = profile.names?.[0] ?? profile.id;
  const lines = [];

  const affinity = profile.affinity;
  const hasAffinity = relationships && affinity && (affinity.score !== 0 || Boolean(affinity.reason));
  if (hasAffinity) {
    lines.push(
      fill(p.affinity, { score: affinity.score, band: labels.affinity?.bands?.[affinityBand(affinity.score)], reason: affinity.reason }),
    );
  }

  if (profile.names?.length > 1) lines.push(fill(p.formerNames, { names: profile.names.slice(1).join(', ') }));
  if (profile.character) lines.push(fill(p.character, { text: profile.character }));
  if (profile.interests) lines.push(fill(p.interests, { text: profile.interests }));
  if (profile.style) lines.push(fill(p.style, { text: profile.style }));
  if (profile.details?.length) lines.push(fill(p.details, { text: profile.details.join('; ') }));
  if (profile.relationship) lines.push(fill(p.relationship, { text: profile.relationship }));
  if (lines.length === 0 && !interlocutor) return '';
  if (lines.length === 0) lines.push(p.unknown);
  if (profile.messageCount) lines.push(fill(p.messageCount, { count: profile.messageCount }));
  const mark = interlocutor ? p.interlocutorMark : '';
  return `## ${name}${mark}\n${lines.join('\n')}`;
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

  const { kept, stats, used } = fitSections(
    [
      { name: 'fixed', required: true, items: [system, task, formatNow(now, timezone, labels.locale), sensesText, tempoText] },
      {
        name: 'interlocutor',
        cap: caps.interlocutor,
        items: [renderProfile(input.interlocutor, labels, { interlocutor: true, relationships })].filter(Boolean),
      },
      { name: 'aboutChat', cap: caps.aboutChat, items: aboutChatItems(input.guildMemory, labels) },
      { name: 'self', cap: caps.aboutChat, items: (input.guildMemory?.self ?? []).map((fact) => `- ${fact}`) },
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
  const user = [
    block('now', formatNow(now, timezone, labels.locale)),
    block('senses', sensesText),
    block('about_chat', kept.aboutChat.join('\n')),
    block('server', kept.server.join('\n\n')),
    block('self_facts', kept.self.join('\n')),
    block('people', [...kept.interlocutor, ...kept.people].join('\n\n')),
    block('other_channels', kept.neighbors.join('\n\n')),
    block('chat', renderTranscript(keptChat, timezone, labels)),
    block('tempo', tempoText),
    block('task', task),
  ]
    .filter(Boolean)
    .join('\n\n');

  const content = pictures.length
    ? [
        { type: 'text', text: user },
        ...pictures.map((picture) => ({
          type: 'image_url',
          image_url: { url: mediaProxyUrl(picture.url, { width: visionCfg.imageSize, height: visionCfg.imageSize, format: 'webp' }) },
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
  };
}
