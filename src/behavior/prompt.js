// Assembles one LLM request for a turn. Pure: takes already-fetched data and
// the live prompts/config, returns chat-completions messages. The token budget
// is spent in this priority order (see src/llm/budget.js):
//   1. system prompt (persona + live rules + output format), task, clock, tempo — never cut
//   2. memory about the trigger's author (the person the persona is talking to, or the one overheard)
//   2b. what the persona looked up this turn (`<lookup>`, one piece: online,
//       in the server's own history, or both)
//   3. how this server talks + what the persona has said about itself
//   3b. lorebook entries matched by the transcript (`<lore>`)
//   4. the map of the server's channels
//   5. the channel transcript, newest messages first
//   5b. another channel pulled into this turn (`<channel_view>`, newest lines
//       first); on a routed turn -- a call from a channel the persona cannot
//       write in, answered here -- it goes right BEFORE the chat instead,
//       since the call itself lives in it
//   5c. the last `memory.recentHours` (`<recent>`): the recent lines this
//       channel's audience may read, then members' moments of those hours that
//       `<people>` does not show, capped by `context.caps.recent`, ranked by who
//       the turn is about
//   6. memory about other people present in the transcript
//   6b. the devices the persona has worn out in its own recent lines (`<worn>`, one piece)
//   7. neighbouring channels
//   8. the server's custom emoji (`<emoji>`)
//   9. the GIF library (`<gifs>`)
// The rendered order is different: reference material first, the chat and the
// task last, where the model attends best. A private chat (`privateChat`)
// drops the server map, the neighbouring channels and any pulled channel and
// sees its partner through the public and private profiles merged
// (src/behavior/private.js). Pictures of another channel are shown as
// captions only: nothing outside the turn's own channel is ever attached.

import { fitSections, requestTokenLimit, sectionCost } from '../llm/budget.js';
import {
  computeTempo,
  fill,
  formatClock,
  formatDate,
  formatDuration,
  formatNow,
  formatTranscript,
  renderTempo,
  renderTranscript,
} from '../discord/format.js';
import { zonedDay } from '../time.js';
import { affinityBand, roundScore } from '../memory/affinity.js';
import { isConfirmed, isStale } from '../memory/interests.js';
import { topByRank } from '../memory/ranking.js';
import { rankEmojiUsage } from '../memory/emoji-usage.js';
import { gifHandleMap, normalizeGifs, rankGifs } from '../memory/gifs.js';
import { clampText } from '../memory/clamp.js';
import { sortEpisodesForDisplay, topEpisodes } from '../memory/episodes.js';
import { RECENT_EPISODES_PER_MEMBER, episodeKey, memberIdOf, recentSettings, recentView } from '../memory/recent.js';
import { matchLore } from '../memory/lore.js';
import { channelActivity, renderChannel } from '../memory/channels.js';
import { selectPictures, mediaProxyUrl } from '../discord/media.js';
import { ID_DIGITS, fromTokens, isWordChar, occursAsWholeWord } from '../memory/mentions.js';
import { mergeProfiles } from './private.js';
import { renderWorn } from './variety.js';
import { gifWatchBlocker } from '../memory/gif-watch.js';

const TAG_OVERHEAD = 60;

/**
 * `body` wrapped in `<tag>` ... `</tag>` on lines of their own; '' for an
 * empty body, so a block with nothing to say drops out of a request. The one
 * copy: every request builder (chat, analyzer, warm-up, mentor) uses it.
 * @param {string} tag
 * @param {string} body
 * @returns {string}
 */
export function block(tag, body) {
  return body ? `<${tag}>\n${body}\n</${tag}>` : '';
}

/** `fromTokens(text, nameOf, 'chat')`, tolerating a non-string `text` and a
 * missing `nameOf` (an unresolved `<@id>` token is then left exactly as
 * stored) -- see docs/prompt-contract.md, "Members are referred to
 * by id, never by nickname". */
function resolveChatText(text, nameOf) {
  if (typeof text !== 'string') return text;
  return fromTokens(text, typeof nameOf === 'function' ? nameOf : () => null, 'chat');
}

/**
 * A member's remembered episodes (the interlocutor's, or the top few of a
 * member asked about) as `[heading, ...oneLinePerEpisode]`,
 * heaviest weight first then newest (see sortEpisodesForDisplay). `[]` when
 * there is nothing to show, or when `labels.profile` lacks any of
 * `episodes`/`episode`/`episodeNoQuote` — an older labels.json simply never
 * renders this, see docs/prompt-contract.md.
 */
function episodeLines(episodes, labels, nameOf) {
  const p = labels.profile;
  if (!Array.isArray(episodes) || episodes.length === 0) return [];
  if (!p.episodes || !p.episode || !p.episodeNoQuote) return [];
  const lines = sortEpisodesForDisplay(episodes).map((ep) =>
    fill(ep.quote ? p.episode : p.episodeNoQuote, {
      date: ep.date,
      what: resolveChatText(ep.what, nameOf),
      quote: ep.quote,
      feeling: resolveChatText(ep.feeling, nameOf),
    }),
  );
  return [p.episodes, ...lines];
}

/**
 * Keep `lines[0]` (the episodes heading) plus as many of the following lines
 * (already ordered heaviest-first) as fit `remaining` tokens, each priced by
 * `cost` -- the lightest ones are dropped first simply because they sort
 * last. `[]` when even the heading does not fit.
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
 * Append `labels.profile.unsureMark`/`staleMark` to `text` per
 * docs/prompt-contract.md, "Confirmation"/"Dates come from the
 * messages": the unsure mark when `item` is below `marks.confirmAfter`, then
 * the stale mark when `item` is older than `marks.staleDays` (skipped
 * entirely for `marks.stale === false`, since details never go stale). Both
 * marks are OPT IN: `marks.confirmAfter`/`marks.staleDays` being anything
 * other than a plain number (i.e. omitted -- the direct-call/older-caller
 * case) never marks anything, so such a caller renders the text with no
 * mark at all. A missing label appends nothing.
 * @param {string} text
 * @param {{ weight?: number, lastSeen?: string|null }} item
 * @param {object} p  `labels.profile`.
 * @param {{ confirmAfter?: number, staleDays?: number, now?: number, stale?: boolean }} [marks]
 */
function markConfirmation(text, item, p, marks) {
  let out = text;
  if (typeof marks?.confirmAfter === 'number' && !isConfirmed(item, marks.confirmAfter) && p.unsureMark) {
    out += p.unsureMark;
  }
  if (marks?.stale !== false && typeof marks?.staleDays === 'number' && isStale(item, marks.now ?? Date.now(), marks.staleDays) && p.staleMark) {
    out += p.staleMark;
  }
  return out;
}

/**
 * One remembered interest as prompt text: `labels.profile.interestItem`
 * (`{topic}`/`{note}`) when the note is non-empty and the label exists,
 * `interestItemNoNote` (`{topic}`) when there is no note and that label
 * exists; otherwise the built-in `topic (note)` / bare `topic` form -- so an
 * older labels.json without these optional keys never breaks. Then
 * `markConfirmation` appends the unsure/stale marks, see above.
 */
function renderInterestItem(item, p, marks) {
  const note = resolveChatText(item.note, marks?.nameOf);
  const text = note
    ? p.interestItem
      ? fill(p.interestItem, { topic: item.topic, note })
      : `${item.topic} (${note})`
    : p.interestItemNoNote
      ? fill(p.interestItemNoNote, { topic: item.topic })
      : item.topic;
  return markConfirmation(text, item, p, marks);
}

/**
 * The `labels.profile.interests` line's `{text}`: the top `maxInterests`
 * stored interests (topic/note atomic items, see src/memory/interests.js) by
 * RANK (src/memory/ranking.js#topByRank, decayed with `marks.interestHalfLifeDays`),
 * in rank order -- see docs/prompt-contract.md, "More is stored than
 * shown, and rank decays with age". `''` when there is nothing to show.
 * `maxInterests` not an integer -> every stored interest renders (a stored
 * profile can hold more than a lowered live cap until the next analyzer
 * update evicts). `marks` (see `markConfirmation`) controls the unsure/stale
 * marks on each item; without `marks.interestHalfLifeDays` the rank is pure
 * weight (no decay).
 */
function interestsText(interests, labels, maxInterests, marks) {
  if (!Array.isArray(interests) || interests.length === 0) return '';
  const ordered = topByRank(interests, maxInterests, marks?.interestHalfLifeDays);
  return ordered.map((item) => renderInterestItem(item, labels.profile, marks)).join('; ');
}

/**
 * The `labels.profile.details` line's `{text}`: the top `maxDetails` stored
 * detail items (`{ id, text, weight, firstSeen, lastSeen }`, see
 * src/memory/details.js) by RANK (decayed with `marks.detailHalfLifeDays`),
 * in rank order, each with the unsure mark appended when unconfirmed -- never
 * the stale mark, details do not go stale (see
 * docs/prompt-contract.md, "Dates come from the messages"). `''` when
 * there is nothing to show. `maxDetails` not an integer -> every stored
 * detail renders.
 */
function detailsText(details, labels, maxDetails, marks) {
  if (!Array.isArray(details) || details.length === 0) return '';
  const p = labels.profile;
  const ordered = topByRank(details, maxDetails, marks?.detailHalfLifeDays);
  return ordered
    .map((item) => markConfirmation(resolveChatText(item.text, marks?.nameOf) ?? '', item, p, { ...marks, stale: false }))
    .join('; ');
}

/**
 * The compact `<people>` interests line's `{text}`: just the top 5
 * stored interests BY RANK (see `interestsText` above), bare topics only --
 * no note, no unsure/stale marks. `''` when there is nothing to show. The 5
 * cap is fixed in code, not `maxInterests` -- a compact profile is meant to
 * cost a fraction of a full one regardless of how many interests are
 * configured to show for the interlocutor.
 */
function compactInterestsText(interests, labels, halfLifeDays) {
  if (!Array.isArray(interests) || interests.length === 0) return '';
  return topByRank(interests, 5, halfLifeDays)
    .map((item) => item.topic)
    .join('; ');
}

/**
 * The `labels.profile.aliases` line's `{text}`: the top `maxAliases` stored
 * alias names (see src/memory/aliases.js) by RANK (decayed with
 * `aliasHalfLifeDays`), comma-separated -- see docs/prompt-contract.md,
 * "Aliases". `''` when there is nothing to show, or when
 * `labels.profile.aliases` is missing (an older labels.json never renders
 * this line). Alias names are never token-resolved -- they are literal
 * nicknames, not a reference to someone else.
 */
function aliasesText(aliases, labels, maxAliases, aliasHalfLifeDays) {
  if (!labels.profile?.aliases) return '';
  if (!Array.isArray(aliases) || aliases.length === 0) return '';
  return topByRank(aliases, maxAliases, aliasHalfLifeDays)
    .map((item) => item.name)
    .join(', ');
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
 * docs/prompt-contract.md, "<people>". Anyone else (a member the persona is
 * asked about) gets them in the same place only with `opts.episodes.max` a
 * positive integer, and then only the top `max` (src/memory/episodes.js#topEpisodes,
 * heaviest then newest); `max` never caps the interlocutor. Such a profile
 * with nothing else learned is shown by its episodes alone (no
 * `labels.profile.unknown` line). `opts.episodes.cap`/`.cost`
 * (when given) trim the episode list, heaviest-first, to fit that token
 * budget on top of the rest of the profile (for anyone but the interlocutor,
 * down to no heading at all when not one episode fits); without them every
 * episode renders. `opts.maxInterests`/`opts.maxDetails` cap how many interests/details
 * render, keeping the top-ranked ones (see `interestsText`/`detailsText`
 * above); omitted -> every stored item renders. `opts.interestHalfLifeDays`/
 * `opts.detailHalfLifeDays` (from `memory.interestHalfLifeDays`/
 * `memory.detailHalfLifeDays`) drive that rank's decay; omitted -> no decay,
 * ranked by weight alone. `opts.confirmAfter`/`opts.staleDays`/`opts.now`
 * (from `memory.confirmAfter`/`memory.interestStaleDays`, read by the caller
 * at the moment of use, and the injectable clock) drive the unsure/stale
 * marks on interests and details -- see `markConfirmation`; omitted, nothing
 * is ever marked.
 *
 * `opts.compact` renders the SHORT form used for `<people>` priority
 * (c), the other recent participants: current name, aliases, `character`
 * (as stored), the attitude line, and the top 5 interests (bare topics, no
 * note) -- no former names, no `style`, no `details`, no `relationship`, no
 * message count, no episodes even for the interlocutor. Never passed
 * alongside `interlocutor: true` in practice (the interlocutor is always
 * rendered in full), but `compact` wins over `interlocutor` for episodes
 * either way.
 *
 * `opts.mark` (default true) puts `labels.profile.interlocutorMark` on the
 * interlocutor's heading; false leaves the heading bare and changes nothing
 * else -- the author of an overheard line is rendered in full but is not
 * talking to the persona.
 * @param {object|null} profile
 * @param {object} labels
 * @param {object} [opts]  The options above.
 * @returns {string}
 */
export function renderProfile(profile, labels, opts) {
  return renderProfileShown(profile, labels, opts).text;
}

/**
 * `renderProfile`'s text (`text`) and how many of the member's episodes it
 * shows (`episodes`): always the first that many in display order
 * (src/memory/episodes.js#topEpisodes), since a cap only ever drops the
 * lightest. 0 when none renders -- none stored, none fits, or an older labels
 * file without the episode labels -- so a block that must not repeat them
 * knows exactly which ones the request shows.
 * @returns {{ text: string, episodes: number }}
 */
function renderProfileShown(
  profile,
  labels,
  {
    interlocutor = false,
    mark: markInterlocutor = true,
    compact = false,
    relationships = false,
    episodes,
    maxInterests,
    maxDetails,
    maxAliases,
    aliasHalfLifeDays,
    interestHalfLifeDays,
    detailHalfLifeDays,
    confirmAfter,
    staleDays,
    now,
    nameOf,
  } = {},
) {
  if (!profile) return { text: '', episodes: 0 };
  const p = labels.profile;
  const name = profile.names?.[0] ?? profile.id;
  const marks = { confirmAfter, staleDays, now, interestHalfLifeDays, detailHalfLifeDays, nameOf };

  const attitudeLines = [];
  const affinity = profile.affinity;
  const hasAffinity = relationships && affinity && (affinity.score !== 0 || Boolean(affinity.reason));
  if (hasAffinity) {
    attitudeLines.push(
      fill(p.affinity, {
        score: roundScore(affinity.score),
        band: labels.affinity?.bands?.[affinityBand(affinity.score)],
        reason: resolveChatText(affinity.reason, nameOf),
      }),
    );
  }

  const restLines = [];
  if (!compact && profile.names?.length > 1) restLines.push(fill(p.formerNames, { names: profile.names.slice(1).join(', ') }));
  const aliasesLine = aliasesText(profile.aliases, labels, maxAliases, aliasHalfLifeDays);
  if (aliasesLine) restLines.push(fill(p.aliases, { text: aliasesLine }));
  if (profile.character) restLines.push(fill(p.character, { text: resolveChatText(profile.character, nameOf) }));
  const interestsLine = compact
    ? compactInterestsText(profile.interests, labels, interestHalfLifeDays)
    : interestsText(profile.interests, labels, maxInterests, marks);
  if (interestsLine) restLines.push(fill(p.interests, { text: interestsLine }));
  if (!compact && profile.style) restLines.push(fill(p.style, { text: resolveChatText(profile.style, nameOf) }));
  const detailsLine = compact ? '' : detailsText(profile.details, labels, maxDetails, marks);
  if (detailsLine) restLines.push(fill(p.details, { text: detailsLine }));
  if (!compact && profile.relationship) restLines.push(fill(p.relationship, { text: resolveChatText(profile.relationship, nameOf) }));
  const hasContent = attitudeLines.length > 0 || restLines.length > 0;
  // Every episode for the interlocutor; the top `episodes.max` for a member asked about.
  const showEpisodes = !compact && episodes?.enabled && (interlocutor || (Number.isInteger(episodes.max) && episodes.max > 0));
  let renderedEpisodes = showEpisodes
    ? episodeLines(interlocutor ? profile.episodes : topEpisodes(profile.episodes, episodes.max), labels, nameOf)
    : [];
  if (!hasContent && interlocutor) restLines.push(p.unknown);
  if (!compact && profile.messageCount) restLines.push(fill(p.messageCount, { count: profile.messageCount }));

  const mark = interlocutor && markInterlocutor ? p.interlocutorMark : '';
  const heading = `## ${name}${mark}`;

  if (renderedEpisodes.length && typeof episodes.cap === 'number' && typeof episodes.cost === 'function') {
    const restText = [heading, ...attitudeLines, ...restLines].join('\n');
    renderedEpisodes = fitEpisodeLines(renderedEpisodes, episodes.cap - episodes.cost(restText), episodes.cost);
    // A member asked about never shows the episodes heading with no episode under it.
    if (!interlocutor && renderedEpisodes.length < 2) renderedEpisodes = [];
  }
  // Anyone but the interlocutor with nothing learned and no moment shown (none, or none fit): nothing to show.
  if (!hasContent && !interlocutor && renderedEpisodes.length === 0) return { text: '', episodes: 0 };

  // The episodes heading, then one line per episode.
  return { text: [heading, ...attitudeLines, ...renderedEpisodes, ...restLines].join('\n'), episodes: Math.max(0, renderedEpisodes.length - 1) };
}

/**
 * A stand-in channel entry for `serverItems` when the current channel has no
 * stored note yet (see below): Discord facts (name/category/topic) read off
 * whichever `history` message actually belongs to `currentChannelId` (every
 * message `buildRequest` is given for `<chat>` comes from that one channel,
 * see src/discord/collect.js#normalizeMessage) -- so the persona still knows
 * where it is even before the analyzer has touched this channel once. `null`
 * when no message carries a usable channel name (nothing to render then; a
 * channel with counters but no name never happens in practice).
 */
function currentChannelFallback(currentChannelId, history) {
  if (!currentChannelId) return null;
  const source = [...history].reverse().find((m) => m.channelId === currentChannelId && m.channelName);
  if (!source) return null;
  return {
    id: currentChannelId,
    name: source.channelName,
    category: source.channelCategory ?? null,
    topic: source.channelTopic ?? null,
    purpose: '',
    topics: '',
    tone: '',
    days: {},
    lastMessageAt: null,
    topWriters: [],
  };
}

/**
 * Render the `<server>` block: ONLY the channels that matter for this turn --
 * the current channel first, marked via `labels.server.currentMark` (its
 * stored note in full, or -- when nothing is stored for it yet, see
 * `currentChannelFallback` above -- just its Discord facts and activity), then
 * the neighbour channels that actually contributed messages to
 * `<other_channels>` this turn, `neighborChannelIds` (matched by id, never by
 * name -- a rename or a same-named channel elsewhere must never cross-wire
 * two entries), each in full too. Every other stored channel note is left
 * out on purpose: on a large server most of them are irrelevant to this
 * reply and would eat most of the block's budget for nothing. A neighbour
 * id with no stored note is skipped, not synthesized -- unlike the current
 * channel, a neighbour the persona is not replying in does not need a
 * where-am-I fallback. A pulled channel (`<channel_view>`) joins the list
 * the same way: the caller puts its id ahead of the neighbours'. An entry
 * whose id is in `readOnlyIds` (a channel the bot can read but not write in)
 * carries `labels.server.readOnly` (src/memory/channels.js#renderChannel,
 * never on the current channel).
 */
function serverItems(channels, currentChannelId, neighborChannelIds, history, now, activityCfg, labels, nameOf, readOnlyIds = new Set()) {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const current = byId.get(currentChannelId) ?? currentChannelFallback(currentChannelId, history);
  const neighborEntries = [...new Set(neighborChannelIds)]
    .filter((id) => id !== currentChannelId)
    .map((id) => byId.get(id))
    .filter(Boolean);
  const ordered = current ? [current, ...neighborEntries] : neighborEntries;
  return ordered.map((channel) =>
    renderChannel(
      {
        ...channel,
        purpose: resolveChatText(channel.purpose, nameOf),
        topics: resolveChatText(channel.topics, nameOf),
        tone: resolveChatText(channel.tone, nameOf),
      },
      labels,
      {
        current: channel.id === currentChannelId,
        activity: channelActivity(channel, now, activityCfg),
        now,
        nameOf,
        readOnly: readOnlyIds.has(channel.id),
      },
    ),
  );
}

/** A stored `from`: a `<@id>`/`<@!id>` token or a bare id, in the shared id range. */
const TEACHER_ID_RE = new RegExp(`^(?:<@!?(${ID_DIGITS})>|(${ID_DIGITS}))$`);

/** The member id inside a stored `from` (`<@id>`/`<@!id>`, or a bare id), or null. */
function teacherId(from) {
  if (typeof from !== 'string') return null;
  const match = TEACHER_ID_RE.exec(from.trim());
  return match ? (match[1] ?? match[2]) : null;
}

/**
 * The `learnedCfg` of `learnedText` read from the live config at the moment
 * of use: `memory.maxLearned` (default 20), `memory.learnedHalfLifeDays`
 * (default 720), `memory.confirmAfter` (unset when absent).
 * @param {object} config  The live config.
 * @returns {{ max: number, halfLifeDays: number, confirmAfter: number|undefined }}
 */
export function learnedConfig(config) {
  return {
    max: Number.isInteger(config.memory?.maxLearned) ? config.memory.maxLearned : 20,
    halfLifeDays: typeof config.memory?.learnedHalfLifeDays === 'number' ? config.memory.learnedHalfLifeDays : 720,
    confirmAfter: typeof config.memory?.confirmAfter === 'number' ? config.memory.confirmAfter : undefined,
  };
}

/**
 * The `labels.aboutChat.learned` line's `{text}`: the top `learnedCfg.max`
 * stored guild items (`{ id, text, from?, weight, firstSeen, lastSeen }`, the
 * same atomic items as a member's details) by RANK (decayed with
 * `learnedCfg.halfLifeDays`), in rank order, joined with `'; '`. Each item is
 * `aboutChat.learnedItem` (`{text}`/`{who}`) when its `from` resolves through
 * `nameOf` to a name, else `aboutChat.learnedItemNoFrom` (`{text}`); a missing
 * item label falls back to the next simpler form, then to the bare text. An
 * item below `learnedCfg.confirmAfter` gets `aboutChat.unsureMark` appended
 * when that label exists. `''` when there is nothing to show.
 * Exported for the mentor (src/mentor/mentor.js), which shows its judge the
 * learned items exactly as the persona sees them.
 * @param {object[]} learned      `guild.learned`.
 * @param {object} a              `labels.aboutChat`.
 * @param {{ max?: number, halfLifeDays?: number, confirmAfter?: number }} learnedCfg  See `learnedConfig`.
 * @param {(id: string) => (string|null)} [nameOf]
 * @returns {string}
 */
export function learnedText(learned, a, learnedCfg, nameOf) {
  if (!Array.isArray(learned) || learned.length === 0) return '';
  return topByRank(learned, learnedCfg.max, learnedCfg.halfLifeDays)
    .map((item) => {
      const text = resolveChatText(item?.text, nameOf) ?? '';
      const id = teacherId(item?.from);
      const who = id && typeof nameOf === 'function' ? nameOf(id) : null;
      const noFrom = a.learnedItemNoFrom ? fill(a.learnedItemNoFrom, { text }) : text;
      const line = who && a.learnedItem ? fill(a.learnedItem, { text, who }) : noFrom;
      return !isConfirmed(item, learnedCfg.confirmAfter) && a.unsureMark ? line + a.unsureMark : line;
    })
    .join('; ');
}

/**
 * The `<about_chat>` lines: how this server talks (`patterns`), how people
 * start conversations (`starters`), the in-jokes, then what people taught the
 * persona (`guild.learned`, see `learnedText` above) -- the last one only when
 * `labels.aboutChat.learned` exists, so an older labels.json simply never
 * renders it. Every stored text is token-resolved via `nameOf`.
 * `learnedCfg` carries `max`/`halfLifeDays`/`confirmAfter`, read by the
 * caller from `memory.maxLearned`/`memory.learnedHalfLifeDays`/
 * `memory.confirmAfter` at the moment of use.
 */
function aboutChatItems(guildMemory, labels, nameOf, learnedCfg = {}) {
  const a = labels.aboutChat;
  const items = [];
  if (guildMemory?.patterns) items.push(fill(a.patterns, { text: resolveChatText(guildMemory.patterns, nameOf) }));
  if (guildMemory?.starters) items.push(fill(a.starters, { text: resolveChatText(guildMemory.starters, nameOf) }));
  if (guildMemory?.injokes?.length) {
    items.push(fill(a.injokes, { text: guildMemory.injokes.map((text) => resolveChatText(text, nameOf)).join('; ') }));
  }
  if (a?.learned) {
    const text = learnedText(guildMemory?.learned, a, learnedCfg, nameOf);
    if (text) items.push(fill(a.learned, { text }));
  }
  return items;
}

/**
 * Render the `<lore>` block's entries: whatever `matchLore` (src/memory/lore.js)
 * surfaces from the last `lore.scanMessages` transcript messages plus the
 * trigger, via `labels.lore.entry`. `[]` when there is no stored lore, no
 * match, or `labels.lore.entry` is missing (an older labels.json never
 * breaks -- the block is simply omitted). `text` is token-resolved via
 * `nameOf`; `title` never is (it is the lorebook's identity, not a mention).
 */
function loreItems(loreEntries, history, trigger, labels, loreCfg, nameOf) {
  const entry = labels.lore?.entry;
  if (!entry) return [];
  const entries = Array.isArray(loreEntries) ? loreEntries : [];
  if (entries.length === 0) return [];

  const scan = Math.max(0, loreCfg?.scanMessages ?? 30);
  const recentTexts = history.slice(-scan).map((m) => m.content ?? '').filter(Boolean);
  if (trigger?.content) recentTexts.push(trigger.content);

  const matched = matchLore(entries, recentTexts, { maxMatches: loreCfg?.maxMatches ?? 8 });
  return matched.map((lore) => fill(entry, { title: lore.title, text: resolveChatText(lore.text, nameOf) }));
}

/**
 * The `<emoji>` section's items: `labels.emoji.header` first, then one line
 * per custom emoji -- the top-ranked ids of `guild.emojiUsage` (see
 * src/memory/emoji-usage.js#rankEmojiUsage) that the index still has, topped
 * up with the rest of the index in its own order (a fresh install with no
 * ranking yet shows the first `max` of the index), at most `max` lines. The
 * name is the index's current one. A helper caption cached under
 * `emoji:<id>` (the describer's cache; a `miss` entry has no text) renders
 * through `labels.emoji.entry` (`{name}`/`{text}`), otherwise
 * `labels.emoji.entryNoText` (`{name}`). `[]` when the index is empty or
 * the labels lack `header`/`entryNoText` (an older labels.json).
 * @param {{ id: string, name: string }[]} index  The index's emoji (createEmojiIndex().list()).
 * @param {unknown} usage           `guild.emojiUsage`.
 * @param {object|null} mediaCache  The describer cache (store.getMediaCache), read only.
 * @param {object} labels
 * @param {{ max?: number, halfLifeDays?: number }} [emojiCfg]  `context.customEmoji`.
 * @returns {string[]}
 */
function emojiItems(index, usage, mediaCache, labels, emojiCfg) {
  const e = labels.emoji;
  if (!e?.header || !e.entryNoText) return [];
  const list = Array.isArray(index) ? index.filter((emoji) => emoji?.id && emoji.name) : [];
  if (list.length === 0) return [];
  const max = Number.isInteger(emojiCfg?.max) && emojiCfg.max >= 0 ? emojiCfg.max : 30;
  const byId = new Map(list.map((emoji) => [String(emoji.id), emoji]));
  const chosen = [];
  const taken = new Set();
  const take = (emoji) => {
    if (!emoji || taken.has(String(emoji.id)) || chosen.length >= max) return;
    taken.add(String(emoji.id));
    chosen.push(emoji);
  };
  for (const used of rankEmojiUsage(usage, emojiCfg?.halfLifeDays ?? 30)) take(byId.get(used.id));
  for (const emoji of list) take(emoji);
  if (chosen.length === 0) return [];
  const lines = chosen.map((emoji) => {
    const cached = mediaCache?.[`emoji:${emoji.id}`];
    const text = cached && !cached.miss && typeof cached.text === 'string' ? cached.text.trim() : '';
    return text && e.entry ? fill(e.entry, { name: emoji.name, text }) : fill(e.entryNoText, { name: emoji.name });
  });
  return [e.header, ...lines];
}

/**
 * The `<gifs>` section's items: `labels.gifs.header` first, then one line
 * per GIF of the library -- the top `gifsCfg.max` (default 40) by rank
 * (src/memory/gifs.js#rankGifs, `gifsCfg.halfLifeDays`, default 30). A helper
 * caption cached under the entry's `itemId` (the describer's cache; a `miss`
 * entry has no text) renders through `labels.gifs.entry` (`{id}`/`{text}`),
 * cut to `gifsCfg.listChars` (default 70; 0 = whole) at a word boundary
 * (src/memory/clamp.js#clampText, a hard limit) -- only here: the cached
 * caption stays whole -- otherwise `labels.gifs.entryNoText` (`{id}`). `[]`
 * when the library is empty or the labels lack `header`/`entryNoText` (an
 * older labels.json).
 * @param {unknown} gifs            The library (store.getGifs).
 * @param {object|null} mediaCache  The describer cache (store.getMediaCache), read only.
 * @param {object} labels
 * @param {{ max?: number, halfLifeDays?: number, listChars?: number }} [gifsCfg]  `config.gifs`.
 * @returns {string[]}
 */
function gifItems(gifs, mediaCache, labels, gifsCfg) {
  const g = labels.gifs;
  if (!g?.header || !g.entryNoText) return [];
  const max = Number.isInteger(gifsCfg?.max) && gifsCfg.max >= 0 ? gifsCfg.max : 40;
  const listChars = gifsCfg?.listChars ?? 70;
  const chosen = rankGifs(gifs, gifsCfg?.halfLifeDays ?? 30).slice(0, max);
  if (chosen.length === 0) return [];
  const lines = chosen.map((entry) => {
    const cached = mediaCache?.[entry.itemId];
    const text = cached && !cached.miss && typeof cached.text === 'string' ? clampText(cached.text, listChars, { tolerance: 1 }) : '';
    return text && g.entry ? fill(g.entry, { id: entry.id, text }) : fill(g.entryNoText, { id: entry.id });
  });
  return [g.header, ...lines];
}

/**
 * Assemble the `<now>…<task>` user-message text from already-rendered parts.
 * Factored out so a fallback rendering (see `textFallback` below) can reuse
 * every block untouched except `<chat>`. A pulled channel's lines never carry
 * an `imageAttached`/`frameAttached` tag (nothing of another channel is
 * attached); `<other_channels>` lines can, when they hold an item attached for
 * the chat (see `textFallback`).
 */
function assembleUser({ now, timezone, labels, sensesText, kept, tempoText, task, chatItems }) {
  return [
    block('now', formatNow(now, timezone, labels.locale)),
    block('senses', sensesText),
    block('about_chat', kept.aboutChat.join('\n')),
    block('emoji', (kept.emoji ?? []).join('\n')),
    block('gifs', (kept.gifs ?? []).join('\n')),
    block('server', kept.server.join('\n\n')),
    block('lore', kept.lore.join('\n\n')),
    block('self_facts', kept.self.join('\n')),
    // The last hours: one item, the header with the kept lines and moments, oldest first.
    block('recent', (kept.recent ?? []).join('\n')),
    block('people', [...kept.interlocutor, ...kept.people].join('\n\n')),
    block('other_channels', kept.neighbors.join('\n\n')),
    // Another channel pulled into this turn, one item per channel.
    block('channel_view', (kept.pulled ?? []).join('\n\n')),
    // The persona's own worn-out devices, just ahead of the chat where its own lines are.
    block('worn', (kept.worn ?? []).join('\n')),
    // Right before the chat it answers a question from.
    block('lookup', (kept.lookup ?? []).join('\n')),
    block('chat', renderTranscript(chatItems, timezone, labels)),
    block('tempo', tempoText),
    block('task', task),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Fill the double-brace `{{key}}` placeholders of a prompt file (the prompt
 * contract's form; labels.json uses single braces, see fill() in
 * src/discord/format.js). The one `{{key}}` filler of the codebase: a key
 * present in `values` (an own property) with a non-null value is replaced by
 * `String(value)`; a key that is absent, null or undefined leaves its
 * placeholder untouched. A missing template reads as ''.
 * @param {string|null|undefined} template
 * @param {object} [values]
 * @returns {string}
 */
export function fillPromptTemplate(template, values) {
  const source = values ?? {};
  return String(template ?? '').replace(/\{\{(\w+)\}\}/g, (all, key) =>
    Object.hasOwn(source, key) && source[key] != null ? String(source[key]) : all,
  );
}

/**
 * The transcript body of a helper classifier's `<transcript>` block (the
 * route classifier, src/behavior/route.js#routeContext; the re-watch and
 * lookup classifiers, src/behavior/turn.js#classifierContext): `messages`
 * (already chosen by the caller, oldest first) rendered as the chat renders
 * them (src/discord/format.js) under the live `config` -- `bot.timezone`,
 * `context.gapMarkerMinutes`, `context.maxMessageChars` (800, config.json's
 * value, when missing), `features.seeReactions`, `context.reactionsPerMessage`
 * -- with the media states the caller already has (`descriptions`, `videos`,
 * `reads`; each optional). The one copy of these options for the classifiers;
 * the caller wraps the body. Pure.
 * @param {object[]} messages
 * @param {{ config: object, selfName: string, labels: object, descriptions?: Map<string, unknown>,
 *   videos?: Map<string, unknown>, reads?: Map<string, unknown> }} params
 * @returns {string}
 */
export function classifierTranscript(messages, { config, selfName, labels, descriptions, videos, reads }) {
  const items = formatTranscript(messages, {
    timezone: config.bot?.timezone,
    gapMinutes: config.context?.gapMarkerMinutes,
    maxChars: config.context?.maxMessageChars ?? 800,
    selfName,
    labels,
    seeReactions: config.features?.seeReactions !== false,
    reactionsPerMessage: config.context?.reactionsPerMessage,
    descriptions,
    videos,
    reads,
  });
  return renderTranscript(items, config.bot?.timezone, labels);
}

/**
 * The drawing sub-process's prompt (prompts/draw.md): `{{name}}` and
 * `{{request}}` filled, `{{appearance}}` filled with prompts/appearance.md
 * (its own `{{name}}` filled) for a picture the persona is in, else blanked;
 * then runs of blank lines collapse to one and the result is trimmed.
 * `request` is expected already clamped to `image.maxPromptChars` by the
 * caller (src/behavior/turn.js).
 * @param {{ prompts: object, selfName: string, request: string, self: boolean }} args
 * @returns {string}
 */
export function buildDrawPrompt({ prompts, selfName, request, self }) {
  const appearance = self ? fillPromptTemplate(prompts?.appearance ?? '', { name: selfName }).trim() : '';
  return fillPromptTemplate(prompts?.draw ?? '', { name: selfName, appearance, request: request ?? '' })
    .replace(/(?:\r?\n){3,}/g, '\n\n')
    .trim();
}

/**
 * Whether `labels` (prompts.labels) can render a request at all: an object
 * with `transcript`. The startup check (src/index.js) and every request
 * builder use this one test.
 * @param {unknown} labels
 * @returns {boolean}
 */
export function hasRequiredLabels(labels) {
  return Boolean(labels) && typeof labels === 'object' && Boolean(labels.transcript);
}

// How the task labels list several items inline: `{others}` and `{added}` sit inside a sentence.
const TASK_ITEM_JOIN = '; ';

/** `texts` as `<n>. <text>` items, numbered from `first`. */
function numberedItems(texts, first) {
  return texts.map((text, i) => `${first + i}. ${text}`);
}

/**
 * The task labels for buildRequest's `input.tasks` (see there), joined by a
 * blank line: `labels.task.part` (or, without a usable part,
 * `labels.task.queued`), then `labels.task.queuedOthers`, then
 * `labels.task.added`. '' when nothing applies.
 * @param {{ part?: { index: number, total?: number, parts: string[] }|null, queued?: string[],
 *   queuedOthers?: { author: string, text: string }[], added?: string[] }|null|undefined} tasks
 * @param {object} labels
 * @returns {string}
 */
function renderTasks(tasks, labels) {
  if (!tasks) return '';
  const queued = Array.isArray(tasks.queued) ? tasks.queued : [];
  const added = Array.isArray(tasks.added) ? tasks.added : [];
  const texts = [];
  const part = tasks.part;
  const parts = Array.isArray(part?.parts) ? part.parts : [];
  const usablePart = Boolean(part) && Number.isInteger(part.index) && part.index >= 1 && part.index <= parts.length;
  if (usablePart && labels.task?.part) {
    const otherParts = numberedItems(parts, 1).filter((_, i) => i + 1 !== part.index);
    const others = [...otherParts, ...numberedItems(queued, parts.length + 1)].join(TASK_ITEM_JOIN);
    texts.push(fill(labels.task.part, { index: part.index, total: part.total ?? parts.length, part: parts[part.index - 1], others }));
  } else if (!usablePart && queued.length > 0 && labels.task?.queued) {
    texts.push(fill(labels.task.queued, { others: numberedItems(queued, 1).join(TASK_ITEM_JOIN) }));
  }
  const others = Array.isArray(tasks.queuedOthers) ? tasks.queuedOthers.filter((call) => call && call.text) : [];
  if (others.length > 0 && labels.task?.queuedOthers) {
    const items = numberedItems(others.map((call) => `${call.author ?? ''}: ${call.text}`), 1);
    texts.push(fill(labels.task.queuedOthers, { others: items.join(TASK_ITEM_JOIN) }));
  }
  if (added.length > 0 && labels.task?.added) texts.push(fill(labels.task.added, { added: added.join(TASK_ITEM_JOIN) }));
  return texts.join('\n\n');
}

/** A deployment with no/broken labels.json must fail loudly, not send a broken prompt. */
function requireLabels(prompts) {
  const labels = prompts?.labels;
  if (!hasRequiredLabels(labels)) {
    throw new Error('prompts.labels is missing or incomplete: labels.transcript is required');
  }
  return labels;
}

/** Hostname of `url` without a leading `www.`, or '' for an unparsable URL. */
function siteOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * The web part of `<lookup>`: what the persona looked up online this turn
 * (src/web/lookup.js#search) -- `labels.lookup.header` with the query, then
 * the condensed text and `labels.lookup.sources` with the distinct sites, or
 * `labels.lookup.none` when nothing useful came back. '' when an older
 * labels.json has no `labels.lookup.header`.
 * @param {{ query: string, text: string, sources?: { site?: string, url?: string }[] }} lookup
 * @param {object} labels
 */
function renderWebLookup(lookup, labels) {
  const l = labels.lookup;
  if (!l?.header) return '';
  const lines = [fill(l.header, { query: lookup.query ?? '' })];
  const text = String(lookup.text ?? '').trim();
  if (!text) {
    if (l.none) lines.push(l.none);
    return lines.join('\n');
  }
  lines.push(text);
  const sources = Array.isArray(lookup.sources) ? lookup.sources : [];
  const sites = [...new Set(sources.map((source) => source?.site || siteOf(source?.url)).filter(Boolean))];
  if (sites.length > 0 && l.sources) lines.push(fill(l.sources, { list: sites.join(', ') }));
  return lines.join('\n');
}

/**
 * The server part of `<lookup>`: what the search of the server's own history
 * found this turn (src/behavior/recall-run.js) -- `labels.lookup.serverHeader`,
 * then the summary text, then, when a stretch came back and the labels have
 * `labels.lookup.stretch`, that label with `{date}` (the day of the stretch's
 * first line as `YYYY-MM-DD` in `timezone`: with its year, a stretch may be
 * years old) and `{channel}` (its channel's
 * name), followed by the stretch's lines as they are. '' when there is no
 * server part, nothing to show, or an older labels.json has no
 * `labels.lookup.serverHeader`.
 * @param {{ text?: string|null, stretch?: { channelName?: string|null, startTs: number, lines: string }|null }|null|undefined} server
 * @param {object} labels
 * @param {string} timezone
 * @returns {string}
 */
function renderServerLookup(server, labels, timezone) {
  const l = labels.lookup;
  if (!server || !l?.serverHeader) return '';
  const lines = [];
  const text = String(server.text ?? '').trim();
  if (text) lines.push(text);
  const stretch = server.stretch;
  if (l.stretch && typeof stretch?.lines === 'string' && stretch.lines.trim() && Number.isFinite(stretch.startTs)) {
    lines.push(fill(l.stretch, { date: zonedDay(stretch.startTs, timezone), channel: String(stretch.channelName ?? '') }), stretch.lines);
  }
  return lines.length > 0 ? [l.serverHeader, ...lines].join('\n') : '';
}

/**
 * The `<lookup>` block body as candidates in order of preference, for the
 * budget to take the first that fits (all of them one piece, never split).
 * `lookup` is the turn's `lookup` input: the web search's result
 * (src/web/lookup.js#search) and, under `server`, the server search's
 * (renderServerLookup); either may be missing. The web part alone renders
 * exactly as it did before the server part existed (no part header); the
 * server part alone renders under its header. With both, the block is
 * `labels.lookup.bothNote` (when present), `labels.lookup.webHeader` (when
 * present) over the web part, then the server part -- followed by the web
 * part alone and the server part alone as smaller fallbacks. [] when there is
 * no lookup or the labels can render neither part.
 * @param {object|null} lookup
 * @param {object} labels
 * @param {string} timezone
 * @returns {string[]}
 */
function lookupCandidates(lookup, labels, timezone) {
  if (!lookup || typeof lookup !== 'object') return [];
  const { server, ...webPart } = lookup;
  const web = Object.keys(webPart).length > 0 ? renderWebLookup(webPart, labels) : '';
  const serverText = renderServerLookup(server, labels, timezone);
  if (!web || !serverText) return [web || serverText].filter(Boolean);
  const l = labels.lookup;
  const whole = [l.bothNote, l.webHeader, web, serverText].filter(Boolean).join('\n');
  return [whole, web, serverText];
}

/**
 * Render the `<senses>` block from `labels.senses`: which lines are true
 * under the live config (see docs/prompt-contract.md, "`<senses>`").
 * Returns '' when `labels.senses` is missing entirely, so an older
 * deployment's labels.json never breaks — the block is simply omitted.
 * `drawQuota` (`{ spent, userSpent }` from the image client's quota(), or
 * undefined when no image client is wired) picks the drawing line.
 * `privateChat` adds `senses.privateChat`; outside a private chat,
 * `features.privateMessages === true` adds `senses.privateAware` instead.
 * `recallAvailable` (outside a private chat) adds `senses.recall` right after the search line.
 * `customEmoji` (the `<emoji>` block is possible) adds `senses.customEmoji`;
 * `gifs` (features.gifs on and a non-empty library) adds `senses.gifs` right after it.
 * `gifWatching` (GIFs are watched now, src/memory/gif-watch.js#gifWatchBlocker)
 * swaps `senses.gifDescribed` for `senses.gifWatched` when the labels have it.
 * Outside a private chat, right after the files line: `senses.channels` (the
 * persona sees only the channels this request shows), then, with an
 * `elsewhereDestination` (`{ name }`, where a call from a read-only channel is
 * answered), `senses.elsewhere` with `{destination}`. A missing label adds
 * nothing.
 */
function renderSenses(
  config,
  labels,
  {
    searchAvailable = false,
    recallAvailable = false,
    drawQuota,
    privateChat = false,
    customEmoji = false,
    gifs = false,
    gifWatching = false,
    elsewhereDestination = null,
  } = {},
) {
  const senses = labels.senses;
  if (!senses) return '';
  const visionOn = config.features?.vision !== false;
  const describedOn = config.features?.mediaDescriptions === true;
  const lines = [];
  if (visionOn) lines.push(senses.imageSee);
  lines.push(describedOn ? senses.imageDescribed : senses.imageBlind);
  // A watched GIF (its animation, not one frame); an older labels.json
  // without the line keeps the one-frame one.
  const gifDescribedLine = gifWatching ? (senses.gifWatched ?? senses.gifDescribed) : senses.gifDescribed;
  lines.push(describedOn ? gifDescribedLine : senses.gifBlind);
  // Watching a video needs the describer on too; an older labels.json
  // without the video-watching lines falls back to the still-frame ones.
  const videoOn = describedOn && config.features?.videoDescriptions !== false;
  lines.push(videoOn ? (senses.videoWatch ?? senses.videoDescribed) : describedOn ? senses.videoDescribed : senses.videoBlind);
  // The second look on a question (features.videoRewatch, a missing key
  // counts as on); an older labels.json without the line shows nothing.
  if (videoOn && config.features?.videoRewatch !== false && senses.videoRewatch) lines.push(senses.videoRewatch);

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
  // The server's custom emoji (`customEmoji`: features.customEmoji on and a
  // non-empty index); an older labels.json without the line shows nothing.
  if (customEmoji && senses.customEmoji) lines.push(senses.customEmoji);
  // The GIF library (`gifs`: features.gifs on and a non-empty library); an
  // older labels.json without the line shows nothing.
  if (gifs && senses.gifs) lines.push(senses.gifs);

  // The web lookup (features.webLookup -- a missing key counts as OFF, it
  // costs money and needs a key): the links line stays as it is and the
  // read-excerpt line follows it; the search line follows only when a search
  // key is configured (`searchAvailable`). An older labels.json without
  // either line shows nothing extra.
  const webOn = config.features?.webLookup === true;
  const readOn = webOn && config.web?.links?.enabled !== false;
  const searchOn = webOn && config.web?.search?.enabled !== false && searchAvailable === true;
  lines.push(senses.voice, videoOn ? (senses.linksWatch ?? senses.links) : senses.links);
  if (readOn && senses.linksRead) lines.push(senses.linksRead);
  if (searchOn && senses.search) lines.push(senses.search);
  // The search of the server's own message history (`recallAvailable`: a server
  // turn where the runner is available; its own switch, not the web one); an
  // older labels.json without the line shows nothing.
  if (!privateChat && recallAvailable === true && senses.recall) lines.push(senses.recall);
  // Drawing (features.imageGeneration, a missing key counts as on) needs the
  // image client (`drawQuota` present): one line, the spent forms first. An
  // older labels.json without senses.draw shows nothing.
  if (drawQuota && config.features?.imageGeneration !== false && senses.draw) {
    lines.push(drawQuota.spent ? senses.drawSpent : drawQuota.userSpent ? senses.drawSpentUser : senses.draw);
  }
  lines.push(senses.files);
  // Which channels the persona sees, and where it answers a call from one it
  // cannot write in: a server turn only.
  if (!privateChat && senses.channels) lines.push(senses.channels);
  if (!privateChat && senses.elsewhere && typeof elsewhereDestination?.name === 'string' && elsewhereDestination.name) {
    lines.push(fill(senses.elsewhere, { destination: elsewhereDestination.name }));
  }
  // Private chat: the one line for this conversation, or -- on the server,
  // with the feature on -- the rule about what was said in private.
  if (privateChat) lines.push(senses.privateChat);
  else if (config.features?.privateMessages === true) lines.push(senses.privateAware);
  return lines.filter(Boolean).join('\n');
}

const ASKED_ABOUT_SCAN_MESSAGES = 5;

/**
 * Whether `nameLower` (already lower-cased) is "named" inside `haystackLower`
 * for the purpose of pulling someone into `<people>` -- see
 * docs/prompt-contract.md, "Aliases". A name of 4+ characters also
 * matches at the START of a longer word (a declined/compound form of a short
 * nickname, e.g. `vert` inside `vertexia`, still counts); a name of exactly
 * 3 characters (the caller's minimum, see `isAskedAbout` below) must match a
 * WHOLE word, so a short unrelated word is never swallowed as a false-positive
 * prefix (`max` must not match `maximum`).
 */
function nameOccurs(haystackLower, nameLower) {
  if (nameLower.length < 4) return occursAsWholeWord(haystackLower, nameLower);
  let from = 0;
  for (;;) {
    const at = haystackLower.indexOf(nameLower, from);
    if (at === -1) return false;
    if (!isWordChar(haystackLower[at - 1])) return true;
    from = at + 1;
  }
}

/** A profile's current name plus its top-ranked shown aliases -- everything it can be recognised by. */
function profileNames(profile, maxAliases, aliasHalfLifeDays) {
  const names = [];
  if (typeof profile?.names?.[0] === 'string') names.push(profile.names[0]);
  for (const alias of topByRank(Array.isArray(profile?.aliases) ? profile.aliases : [], maxAliases, aliasHalfLifeDays)) {
    if (typeof alias?.name === 'string') names.push(alias.name);
  }
  return names;
}

/**
 * The window that decides who the persona is being asked about (`<people>`
 * priority (b)): the trigger message plus the last `ASKED_ABOUT_SCAN_MESSAGES`
 * messages of `history` (trigger is usually already the newest of those, but
 * is added explicitly in case it is not). Real mention ids
 * (`normalizeMessage`'s `mentionedUserIds`, see src/discord/collect.js) are the
 * strongest signal; the plain lower-cased text is the fallback for a name/alias
 * match (`nameOccurs` above).
 * @param {object[]} history
 * @param {object|null} trigger
 * @returns {{ mentionedIds: Set<string>, scanTextLower: string }}
 */
function askedAboutWindow(history, trigger) {
  const recent = history.slice(-ASKED_ABOUT_SCAN_MESSAGES);
  const messages = trigger && !recent.some((m) => m.id === trigger.id) ? [...recent, trigger] : recent;
  const mentionedIds = new Set();
  const texts = [];
  for (const message of messages) {
    for (const id of Array.isArray(message?.mentionedUserIds) ? message.mentionedUserIds : []) mentionedIds.add(String(id));
    if (typeof message?.content === 'string' && message.content) texts.push(message.content);
  }
  return { mentionedIds, scanTextLower: texts.join('\n').toLowerCase() };
}

/** Whether `profile` is named/@mentioned in the asked-about window (see `askedAboutWindow`). */
function isAskedAbout(profile, mentionedIds, scanTextLower, maxAliases, aliasHalfLifeDays) {
  const id = profile?.id === undefined || profile?.id === null ? '' : String(profile.id);
  if (id && mentionedIds.has(id)) return true;
  return profileNames(profile, maxAliases, aliasHalfLifeDays).some(
    (name) => name.length >= 3 && nameOccurs(scanTextLower, name.toLowerCase()),
  );
}

/**
 * Split the people who may appear in `<people>` into `askedAbout` (priority
 * (b): rendered FULL, ahead of everyone else) and `participants` (priority
 * (c): the other active participants, rendered COMPACT) -- see
 * docs/prompt-contract.md, "<people>"/"Aliases".
 *
 * `otherProfiles` (the active participants, most relevant first) are checked
 * against the asked-about window first, in order; a match is promoted into
 * `askedAbout` (up to `maxAskedAbout`), everyone else lands in `participants`.
 * `candidateProfiles` (every known profile in the guild) are then checked for
 * a SILENT member who is named/@mentioned but never spoke -- only ever added
 * to `askedAbout`, never to `participants` (a candidate who neither spoke nor
 * was asked about has no place in this request at all). `excludeId` (the
 * interlocutor, already rendered separately in full) is skipped in both.
 * Last, the authors of the lines shown from another channel
 * (`pulledAuthorIds`, most relevant first) are asked-about candidates too,
 * after everyone the chat names and under the same cap: a participant among
 * them is promoted, a silent member is taken from `candidateProfiles`.
 * @param {object[]} otherProfiles
 * @param {object[]} candidateProfiles
 * @param {object[]} history
 * @param {object|null} trigger
 * @param {string|number|null|undefined} excludeId
 * @param {number} [maxAskedAbout]        Not a non-negative integer -> no cap.
 * @param {number} [maxAliases]
 * @param {number} [aliasHalfLifeDays]
 * @param {string[]} [pulledAuthorIds]
 * @returns {{ askedAbout: object[], participants: object[] }}
 */
function splitPeople(
  otherProfiles,
  candidateProfiles,
  history,
  trigger,
  excludeId,
  maxAskedAbout,
  maxAliases,
  aliasHalfLifeDays,
  pulledAuthorIds = [],
) {
  const { mentionedIds, scanTextLower } = askedAboutWindow(history, trigger);
  const cap = Number.isInteger(maxAskedAbout) && maxAskedAbout >= 0 ? maxAskedAbout : Infinity;
  const covered = new Set();
  if (excludeId !== undefined && excludeId !== null) covered.add(String(excludeId));

  const askedAbout = [];
  const participants = [];

  for (const profile of Array.isArray(otherProfiles) ? otherProfiles : []) {
    const id = profile?.id === undefined || profile?.id === null ? '' : String(profile.id);
    if (!id || covered.has(id)) continue;
    covered.add(id);
    if (askedAbout.length < cap && isAskedAbout(profile, mentionedIds, scanTextLower, maxAliases, aliasHalfLifeDays)) {
      askedAbout.push(profile);
    } else {
      participants.push(profile);
    }
  }

  for (const profile of Array.isArray(candidateProfiles) ? candidateProfiles : []) {
    if (askedAbout.length >= cap) break;
    const id = profile?.id === undefined || profile?.id === null ? '' : String(profile.id);
    if (!id || covered.has(id)) continue;
    if (isAskedAbout(profile, mentionedIds, scanTextLower, maxAliases, aliasHalfLifeDays)) {
      covered.add(id);
      askedAbout.push(profile);
    }
  }

  const idOf = (profile) => (profile?.id === undefined || profile?.id === null ? '' : String(profile.id));
  for (const authorId of pulledAuthorIds) {
    if (askedAbout.length >= cap) break;
    const id = String(authorId);
    if (excludeId !== undefined && excludeId !== null && id === String(excludeId)) continue;
    if (askedAbout.some((profile) => idOf(profile) === id)) continue;
    const at = participants.findIndex((profile) => idOf(profile) === id);
    if (at !== -1) {
      askedAbout.push(...participants.splice(at, 1));
      continue;
    }
    if (covered.has(id)) continue;
    const profile = (Array.isArray(candidateProfiles) ? candidateProfiles : []).find((candidate) => idOf(candidate) === id);
    if (profile) {
      covered.add(id);
      askedAbout.push(profile);
    }
  }

  return { askedAbout, participants };
}

/**
 * The `<recent>` items of a view (src/memory/recent.js#recentView), in its
 * order, each with its text and its time (`at`). A line renders through
 * `labels.recent.lineIn` (`{date}` `{time}` `{channel}` `{text}`) when it comes
 * from another channel whose name the channel map (`channels`) holds and the
 * label exists, else through `labels.recent.line` (`{date}` `{time}` `{text}`);
 * a moment through `labels.recent.episode` (`{date}` `{name}` `{what}`) --
 * the caller offers none without that label -- left out and counted
 * (`unnamed`) when the member has no name (`nameOf` gives none and the profile
 * stores none). A line's `{date}` and `{time}` are the transcript's own forms
 * of its time; a moment's `{date}` is its stored `YYYY-MM-DD` (the day it
 * happened) in the transcript's date form, never its `at` moved through a time
 * zone. Every stored `<@id>` token becomes the member's name (`nameOf`). No
 * quote and no feeling: a moment is named, not replayed.
 * @returns {{ entries: { kind: 'line'|'episode', at: number, text: string }[], unnamed: number }}
 */
function recentEntries(items, { labels, timezone, currentChannelId, channels, nameOf }) {
  const r = labels.recent;
  const channelNames = new Map(
    (Array.isArray(channels) ? channels : []).filter((channel) => channel?.id && channel.name).map((channel) => [channel.id, channel.name]),
  );
  const entries = [];
  let unnamed = 0;
  for (const item of items) {
    if (item.kind === 'line') {
      const date = formatDate(item.at, timezone, labels.locale);
      const text = resolveChatText(item.line.text, nameOf);
      const time = formatClock(item.at, timezone, labels.locale);
      const channel = item.line.channelId !== currentChannelId ? channelNames.get(item.line.channelId) : undefined;
      const rendered = channel && r.lineIn ? fill(r.lineIn, { date, time, channel, text }) : fill(r.line, { date, time, text });
      entries.push({ kind: 'line', at: item.at, text: rendered });
      continue;
    }
    if (!r.episode) continue;
    const name = nameOf(item.profileId) || item.name;
    if (!name) {
      unnamed += 1;
      continue;
    }
    const date = calendarDate(item.episode.date, labels.locale);
    entries.push({ kind: 'episode', at: item.at, text: fill(r.episode, { date, name, what: resolveChatText(item.episode.what, nameOf) }) });
  }
  return { entries, unnamed };
}

/** A stored `YYYY-MM-DD` in the transcript's date form (`formatDate`), read as that calendar day:
 * its noon formatted in UTC, so no zone moves it to a neighbouring day. */
function calendarDate(ymd, locale) {
  return formatDate(Date.parse(`${ymd}T12:00:00.000Z`), 'UTC', locale);
}

/**
 * Another channel shown to a turn: the record src/discord/pull-fetch.js#fetchPull
 * returns (the one definition), read here and never changed. This module reads
 * it a little more loosely than the producer writes it: `earlierPingIds` may
 * also be an array, `channelName` null falls back to the channel id, and a
 * missing `descriptions`, `olderNotShown`, `picturesNotSeen`, `earlierPingIds`
 * or `pingState` reads as empty.
 * @typedef {import('../discord/pull-fetch.js').PulledChannel} PulledChannel
 */

/** `{from}` / `{to}` of a pulled channel's header: the date and the clock of `ts`, joined as `<now>` joins them. */
function pulledMoment(ts, timezone, locale) {
  return `${formatDate(ts, timezone, locale)}, ${formatClock(ts, timezone, locale)}`;
}

/** Ids as strings, from a Set or an array; anything else is empty. */
function idSet(value) {
  const list = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  return new Set(list.map(String));
}

/** The state of message `id` in a pulled channel's `pingState` (a Map), or null. */
function pingStateOf(pingState, id) {
  const state = pingState instanceof Map ? pingState.get(String(id)) : null;
  return typeof state === 'string' ? state : null;
}

/**
 * The pulled channels a request can show: entries with a channel id and at
 * least one message with an id and a time, one per channel (the first wins),
 * never the turn's own channel; each message once, oldest first.
 * @param {PulledChannel[]|unknown} pulled
 * @param {string|null} currentChannelId
 * @returns {{ entry: PulledChannel, channelId: string, name: string, messages: object[] }[]}
 */
function usablePulled(pulled, currentChannelId) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(pulled) ? pulled : []) {
    const channelId = typeof entry?.channelId === 'string' ? entry.channelId : '';
    if (!channelId || seen.has(channelId) || channelId === currentChannelId) continue;
    const byId = new Map();
    for (const message of Array.isArray(entry.messages) ? entry.messages : []) {
      if (message?.id === undefined || message?.id === null || !Number.isFinite(message.ts)) continue;
      if (!byId.has(message.id)) byId.set(message.id, message);
    }
    if (byId.size === 0) continue;
    seen.add(channelId);
    const messages = [...byId.values()].sort((a, b) => a.ts - b.ts);
    out.push({ entry, channelId, name: entry.channelName || channelId, messages });
  }
  return out;
}

/**
 * Every pulled channel's transcript items: ordinary chat lines
 * (`formatOptions`, so `context.maxMessageChars`), numbered on from
 * `firstIndex` and on again after each earlier channel, with the channel's own
 * captions joined to the turn's and NO attachment marker (nothing of another
 * channel is attached). A line that called the persona gets
 * `labels.pull.pingAnswered` / `pingUnanswered` / `pingSkipped` after one
 * space, by its `pingState` -- never the turn's trigger, and a state without
 * its label gets no mark (a skipped call never reads as unanswered).
 */
function pulledTranscripts(pulledChannels, { formatOptions, descriptions, firstIndex, triggerId, labels }) {
  const marks = new Map([
    ['answered', labels.pull?.pingAnswered],
    ['unanswered', labels.pull?.pingUnanswered],
    ['skipped', labels.pull?.pingSkipped],
  ]);
  let offset = firstIndex;
  return pulledChannels.map((channel) => {
    const own = channel.entry.descriptions;
    const captions = own instanceof Map && own.size > 0 ? new Map([...own, ...(descriptions ?? [])]) : descriptions;
    const items = formatTranscript(channel.messages, { ...formatOptions, attachedIndex: undefined, descriptions: captions, indexOffset: offset });
    offset += channel.messages.length;
    for (const item of items) {
      if (triggerId !== null && item.id === triggerId) continue;
      const mark = marks.get(pingStateOf(channel.entry.pingState, item.id));
      if (mark) item.text = `${item.text} ${mark}`;
    }
    return { ...channel, items, earlierIds: idSet(channel.entry.earlierPingIds) };
  });
}

/**
 * One pulled channel as its `<channel_view>` item, cut to `budget` tokens.
 * The item: `labels.pull.header` (`{channel}`, `{from}` = the first window line
 * kept, `{to}` = the window's newest line, `{ago}` = how long before `now` that
 * one was written: the channel's real span and age, whatever is cut), then --
 * each when it applies and its label exists -- `labels.server.readOnly`,
 * `labels.pull.olderNotShown` (older messages exist, or window lines older
 * than the first one kept were cut here), `labels.pull.picturesNotSeen`
 * `{count}`; then the earlier calls under `labels.pull.earlierPings` (`{date}`
 * = the oldest one's date); then the window's lines, with
 * `labels.pull.olderNotShown` again between two kept lines whose lines in
 * between were cut (the trigger kept, newer lines cut, the newest ones kept).
 * What is kept: the trigger's line first, then the window's lines newest first
 * while they fit, then the earlier calls newest first. The trigger's line --
 * with the window's newest line when the trigger sits before the window, so
 * the header has a span -- may take up to `ceiling` even past `budget` (a call
 * is never lost to the share or the cap); then nothing else is kept. Null when
 * no window line fits: a header alone is never shown.
 * @returns {{ text: string, ids: Array<string|number>, newestId: string|number, newestTs: number }|null}
 */
function fitPulledChannel(channel, { budget, ceiling = budget, cost, labels, timezone, now, readOnly, triggerId }) {
  const p = labels.pull;
  const windowItems = channel.items.filter((item) => !channel.earlierIds.has(String(item.id)));
  const earlierItems = channel.items.filter((item) => channel.earlierIds.has(String(item.id)));
  if (windowItems.length === 0) return null;
  const notSeen = Number.isFinite(channel.entry.picturesNotSeen) ? Math.max(0, Math.floor(channel.entry.picturesNotSeen)) : 0;
  const newestWindow = windowItems.at(-1);
  const windowAt = new Map(windowItems.map((item, i) => [item.id, i]));

  const render = (keep) => {
    const keptWindow = windowItems.filter((item) => keep.has(item.id));
    if (keptWindow.length === 0) return null;
    const keptEarlier = earlierItems.filter((item) => keep.has(item.id));
    const lines = [
      fill(p.header, {
        channel: channel.name,
        from: pulledMoment(keptWindow[0].ts, timezone, labels.locale),
        to: pulledMoment(newestWindow.ts, timezone, labels.locale),
        ago: formatDuration(Math.max(0, now - newestWindow.ts), labels.units),
      }),
    ];
    if (readOnly && labels.server?.readOnly) lines.push(fill(labels.server.readOnly));
    const older = channel.entry.olderNotShown === true || keptWindow[0] !== windowItems[0];
    if (older && p.olderNotShown) lines.push(fill(p.olderNotShown));
    if (notSeen > 0 && p.picturesNotSeen) lines.push(fill(p.picturesNotSeen, { count: notSeen }));
    if (keptEarlier.length > 0) {
      if (p.earlierPings) lines.push(fill(p.earlierPings, { date: formatDate(keptEarlier[0].ts, timezone, labels.locale) }));
      lines.push(...keptEarlier.map((item) => item.text));
    }
    keptWindow.forEach((item, i) => {
      // Lines cut between two kept ones are not shown either.
      if (i > 0 && windowAt.get(item.id) - windowAt.get(keptWindow[i - 1].id) > 1 && p.olderNotShown) lines.push(fill(p.olderNotShown));
      lines.push(item.text);
    });
    return lines.join('\n');
  };
  const fitted = (keep) => {
    const kept = windowItems.filter((item) => keep.has(item.id));
    const newest = kept.at(-1);
    return {
      text: render(keep),
      ids: [...earlierItems, ...windowItems].filter((item) => keep.has(item.id)).map((item) => item.id),
      newestId: newest.id,
      newestTs: newest.ts,
    };
  };

  const keep = new Set();
  const pinned = triggerId !== null ? channel.items.find((item) => item.id === triggerId) : undefined;
  if (pinned) {
    const floor = new Set([pinned.id, ...(windowAt.has(pinned.id) ? [] : [newestWindow.id])]);
    const floorCost = cost(render(floor));
    if (floorCost <= ceiling) {
      if (floorCost > budget) return fitted(floor);
      for (const id of floor) keep.add(id);
    }
  }
  if (!(budget > 0)) return null;
  for (const group of [windowItems, earlierItems]) {
    for (let i = group.length - 1; i >= 0; i -= 1) {
      const { id } = group[i];
      if (keep.has(id)) continue;
      keep.add(id);
      const text = render(keep);
      if (text !== null && cost(text) <= budget) continue;
      keep.delete(id);
      break;
    }
  }
  const text = render(keep);
  if (text === null || cost(text) > budget) return null;
  return fitted(keep);
}

/**
 * The authors of the pulled lines kept (`fitPulledChannel`'s `ids` over each
 * channel's `messages`), newest line first, each once: members only, never the
 * persona and never a bot.
 * @param {{ ids: Array<string|number>, messages: object[] }[]} pulledFits
 * @returns {string[]}
 */
function pulledAuthors(pulledFits) {
  const out = [];
  for (const fit of pulledFits) {
    const byId = new Map(fit.messages.map((message) => [message.id, message]));
    for (const id of [...fit.ids].reverse()) {
      const message = byId.get(id);
      if (!message || message.self || message.bot || message.authorId === undefined || message.authorId === null) continue;
      const authorId = String(message.authorId);
      if (!out.includes(authorId)) out.push(authorId);
    }
  }
  return out;
}

/**
 * @param {object} input
 * @param {object} input.config            Live config.
 * @param {object} input.prompts           Live prompts keyed by file name.
 * @param {object} input.calibrator
 * @param {'reply'|'interject'|'initiate'|'elsewhere'} input.mode  `prompts[mode]` is the task
 *   text; `elsewhere` (a noticed comment on a read-only channel) takes `prompts.elsewhere`.
 * @param {boolean} [input.forced]  True for an owner-forced turn (`/nep interject`, `/nep
 *   initiate`): when `prompts.forced` is a non-empty string, its filled text is appended to the
 *   task text (same placeholders as `prompts[mode]`) so the model knows `<skip/>` is not the
 *   expected outcome this time. Missing `prompts.forced` -> the task text is left as it is.
 * @param {number} input.now
 * @param {string} input.selfName
 * @param {object[]} input.history         Normalized channel messages, oldest first.
 * @param {{channelId?: string, channelName: string, messages: object[]}[]} input.neighbors
 *   `channelId` (see src/discord/collect.js#fetchNeighbors) is how `<server>` tells which
 *   stored channel note, if any, belongs to a neighbour that contributed to `<other_channels>` --
 *   omitted (an older/direct caller) simply means that neighbour never gets its note shown.
 * @param {object|null} input.trigger      Normalized message the turn answers (reply mode): a call,
 *   or an overheard line.
 * @param {string|null} input.triggerKind  src/behavior/turn.js#TriggerKind, null on a spontaneous turn.
 *   Its `labels.triggers` entry fills `{{trigger}}`. `overheard` (a line about the persona, said to
 *   someone else or to the room) takes `prompts.overheard` as its task text instead of
 *   `prompts[mode]` when that file is a non-empty string, falls back to the `followUp` then the
 *   `reply` label, and renders the author's profile without `labels.profile.interlocutorMark`.
 * @param {object} input.guildMemory
 * @param {object|null} input.interlocutor Profile of the trigger's author (the public one).
 * @param {{ userId: string }|null} [input.privateChat]  Set for a private (DM) turn: the
 *   interlocutor renders as `mergeProfiles(interlocutor, privateProfile)`, `<server>` and
 *   `<other_channels>` are omitted, `prompts.private` (when present) is appended to the task
 *   text (same placeholders as `prompts[mode]`), and `<senses>` carries `senses.privateChat`.
 * @param {object|null} [input.privateProfile]  The DM partner's private layer
 *   (store.getPrivate); read only when `privateChat` is set.
 * @param {object[]} input.otherProfiles   Profiles of other people in the transcript, most relevant first.
 * @param {object[]} [input.candidateProfiles]  Every member profile known in the guild
 *   (store.listUserProfiles), scanned to pull a silent member into `<people>` by a
 *   real mention/name/alias in the trigger or the last few messages (see `splitPeople`
 *   above); [] or omitted -> nobody is pulled in.
 * @param {(id: string) => (string|null)} [input.nameOf]  Resolves a member id to their
 *   current stored name, for turning every `<@id>` token this request renders into
 *   display text -- see docs/prompt-contract.md, "Members are referred to by
 *   id, never by nickname". Omitted -> tokens render exactly as stored.
 * @param {object[]} [input.channels]      The server's channel map (store.listChannels), [] when memory is off.
 * @param {object[]} [input.loreEntries]   The guild's stored lorebook (store.getLore), [] when memory is off.
 * @param {string|null} [input.currentChannelId]  Id of the channel this turn happens in.
 * @param {Map<string, string>} [input.descriptions]  Item id -> describer caption, for pictures
 *   NOT selected to be attached, and for attached ones too with features.attachedDescriptions
 *   (see src/behavior/turn.js, src/memory/describe.js).
 * @param {Map<string, string>} [input.neighborDescriptions]  Item id -> the caption the
 *   describer's cache already held for a picture in a neighbour's lines
 *   (src/memory/describe.js#cachedDescriptions); used for `<other_channels>` only, alongside
 *   `descriptions`. Omitted -> a neighbour picture shows a caption only when `descriptions` has one.
 * @param {Map<string, object>} [input.videos]  Item id -> video state from the video describer
 *   (src/memory/describe.js#describeVideos), passed to formatTranscript.
 * @param {Map<string, string>} [input.reads]  Link id -> the excerpt the web lookup read from that
 *   page (src/web/lookup.js#readLinks), passed to formatTranscript.
 * @param {{ query?: string, text?: string, sources?: object[], cached?: boolean,
 *   server?: { text: string|null, stretch: { channelId: string, channelName: string|null, startTs: number,
 *   lines: string }|null, people: object[] } }|null} [input.lookup]  What was looked up this turn,
 *   rendered as `<lookup>` (see `lookupCandidates`): the web search's result
 *   (src/web/lookup.js#search) as it is, and under `server` what the search of the server's own
 *   history found (src/behavior/recall-run.js; src/behavior/turn.js adds the key only when it found
 *   something). A web result without `server` renders exactly as before the server part existed;
 *   the server part needs `labels.lookup.serverHeader`, its stretch `labels.lookup.stretch`.
 * @param {boolean} [input.searchAvailable]  Whether a web search key is configured
 *   (lookup.hasSearch()); `senses.search` renders only when it is true.
 * @param {boolean} [input.recallAvailable]  Whether the search of the server's own history could
 *   run this turn (src/behavior/turn.js#recallAvailable, never in a private chat); `senses.recall`
 *   renders, right after the web search line, only when it is true (and never in a private chat).
 * @param {{ spent: boolean, userSpent: boolean }} [input.drawQuota]  The image client's
 *   quota for this turn (src/llm/images.js#quota); omitted -> no drawing line in `<senses>`.
 * @param {string} [input.drawReason]  For `triggerKind: 'drawFailed'`: the failure reason,
 *   rendered through `labels.draw.reasons` into `labels.triggers.drawFailed`'s `{reason}`.
 * @param {{ id: string, name: string, animated?: boolean }[]} [input.customEmoji]  The served
 *   guild's custom emoji (src/discord/emoji.js#createEmojiIndex's `list()`). With
 *   `features.customEmoji` on (a missing key counts as on) and a non-empty list, `<emoji>`
 *   renders (ranked by `guildMemory.emojiUsage`, see `emojiItems`) and `<senses>` carries
 *   `senses.customEmoji`. Omitted or [] -> neither.
 * @param {object|null} [input.mediaCache]  The describer cache (store.getMediaCache), read only
 *   for the `emoji:<id>` captions of `<emoji>` and the GIF captions of `<gifs>`.
 * @param {object|null} [input.gifs]  The guild's GIF library (store.getGifs). With `features.gifs`
 *   on (a missing key counts as on) and at least one entry, `<gifs>` renders (see `gifItems`),
 *   `<senses>` carries `senses.gifs`, and a GIF of the library in the transcript carries its
 *   handle (`transcript.gifKnown`/`gifKnownNoText`). Omitted or empty -> none of it.
 * @param {{ shape: string, examples: string[] }[]|null} [input.worn]  What this turn's variety pass
 *   (src/behavior/variety-pass.js, or the mentor's sandbox) named in the persona's own recent
 *   lines; with `features.variety` on (a missing key counts as on) and `labels.variety.intro`
 *   present, rendered as `<worn>` (see src/behavior/variety.js#renderWorn). Omitted, null or
 *   empty -> no block.
 * @param {PulledChannel[]} [input.pulled]  Other channels pulled into this turn, rendered as
 *   `<channel_view>` (one item per channel, see `fitPulledChannel`) after `<other_channels>`:
 *   lines numbered on after the chat's (and after each earlier pulled channel), captions only
 *   (nothing of another channel is attached for vision), budget section `pulled` capped by
 *   `context.caps.pulled` (4000 when unset) and fitted right after the chat -- right before it
 *   on a routed turn. The block's room is shared evenly between the channels; a trigger that
 *   lives in a pulled channel (a routed call) keeps its line and the header past the share and
 *   the cap whenever the request has room for them. A pulled channel whose block is shown
 *   leaves `<other_channels>` (one dropped by the budget stays there); its stored note joins
 *   `<server>` right after the current channel either way; the authors of its kept lines are
 *   asked-about candidates for `<people>` (see `splitPeople`). No `labels.pull.header` -> no block.
 * @param {{ channelId: string, reason: 'routed'|'noticed' }|null} [input.source]  The channel a
 *   routed call or a noticed comment comes from (it is among `pulled`). It fills the task's
 *   `{{channel}}` (its name) and `{{destination}}` (this channel's name: the one the chat's
 *   messages carry, else `elsewhereDestination`'s, else the channel map's, else ''). `routed`:
 *   the trigger is looked up in the pulled lines; when its line is shown, its index fills
 *   `{{target}}` and `labels.elsewhere.called` (`{channel}` `{destination}`, left out while the
 *   destination has no name) follows the mode's task text -- when it is not, `{{target}}` is ''
 *   and no called text follows. The pulled block is fitted before the chat, and `<tempo>` is
 *   measured to `now` without saying that nobody answered the persona.
 * @param {object|null} [input.focus]  A message of the chat put to everyone present (a room
 *   question): `labels.room.focus` (`{author}` `{target}`) follows the task text when it is in
 *   the chat.
 * @param {{ part: { index: number, total: number, parts: string[] }|null, queued: string[],
 *   queuedOthers?: { author: string, text: string }[], added: string[] }|null} [input.tasks]  What else the trigger's author is waiting for, after
 *   the task text (src/behavior/turn.js). `part`: this turn answers one part of a message that
 *   holds several requests (src/behavior/split.js) -- `labels.task.part` with `{index}` (1-based),
 *   `{total}`, `{part}` (the part answered now) and `{others}` (every other part, then each of
 *   `queued`, as `<n>. <text>` items numbered on, joined by `; `). `queued`: the author's other
 *   calls still waiting for their own turns -- without a part, `labels.task.queued` with
 *   `{others}` (them, `<n>. <text>` items from 1, joined by `; `). `queuedOthers`: other members'
 *   calls waiting in this channel -- `labels.task.queuedOthers` with `{others}` (`<n>. <author>:
 *   <text>` items from 1, joined by `; `), on a part too. `added`: later messages of the
 *   author about this same call -- `labels.task.added` with `{added}` (their texts joined by `; `).
 *   A label missing (an older labels file) or a part outside its parts adds nothing for it.
 * @param {{ name: string }|null} [input.elsewhereDestination]  Where a call from a read-only
 *   channel is answered: `<senses>` gains `senses.elsewhere` with `{destination}`.
 * @param {Set<string>|string[]} [input.readOnlyIds]  Channels the bot can read but not write in:
 *   their `<server>` entries (never the current channel's) carry `labels.server.readOnly`, as do
 *   pulled channels whose record says `readOnly`. A private chat ignores `pulled`, `source`,
 *   `focus`, `elsewhereDestination` and `readOnlyIds`; with none of them given the request is
 *   the one built before pulled channels existed, save `senses.channels` on a server turn.
 * @param {object[]} [input.recentLines]  The guild's recent lines (store.getRecent(guildId).lines;
 *   an empty array for a store that holds none). With it an array, `features.recent` on (a
 *   missing key counts as on) and `labels.recent.header` and `labels.recent.line` present,
 *   `<recent>` renders after `<self_facts>` whenever the last `memory.recentHours` (72 when
 *   unset) hold an item this turn may show: `labels.recent.header` (`{hours}`), then the items
 *   kept, oldest first (see `recentEntries`). The items are chosen by
 *   src/memory/recent.js#recentView in its order -- the lines `recentAudience` accepts, the ones
 *   about the trigger's author, the interlocutor or a member asked about first; then up to
 *   two moments per member inside the window (src/memory/recent.js#RECENT_EPISODES_PER_MEMBER),
 *   those members first (none without `labels.recent.episode`) -- under `context.caps.recent` (1200
 *   when unset), ranked right after the chat and the pulled block and ahead of `<people>`; a
 *   header without an item, or items without the header, make no block. The moments
 *   `<people>` shows are left out: the interlocutor's that its block keeps and those of a
 *   member asked about. One that `<people>` cuts comes back here, in the room this block took
 *   plus what the request has beyond `<people>`'s room, so `<people>` never loses room to it,
 *   and a member asked about that `<people>` could not place gets the room it frees. A private
 *   chat shows no member's moment. The switch off, the labels missing, or the input omitted or
 *   not an array (the mentor's sandbox): no block, the request as before.
 * @param {(channelId: string|null) => boolean} [input.recentAudience]  Whether a recent line from
 *   that channel may be shown in this turn (src/behavior/turn.js decides it from the channels'
 *   audiences). Omitted -> only the lines of `currentChannelId`.
 * @returns {{ messages: object[], stats: object, idByIndex: Map<number, string>, tempo: object,
 *   pictures: object[], textFallback: string|null, pulledIds: Map<string, string>,
 *   pulledKept: { channelId: string, ids: string[], newestId: string, newestTs: number }[],
 *   peopleShown: { id: string, names: string[] }[],
 *   recent: { lines: number, episodes: number, cut: number, hidden: number, repeated: number,
 *     unnamed: number }|null }}
 *   `pictures` are the ones attached as image_url parts; `textFallback` is the same user message
 *   with every attached picture rendered blind or described (null when nothing is attached), for
 *   a provider that rejects them. `idByIndex` maps chat AND pulled indices; `pulledIds` maps
 *   every pulled line's message id to its channel id (the output side reacts there, never
 *   replies across channels); `pulledKept` lists the channels whose block survived the budget,
 *   with the ids of the lines shown and the newest window line shown. `peopleShown` lists the
 *   members whose profile the request shows (the interlocutor when its block was kept, then those
 *   `<people>` kept, in its order) with their stored names: whose `@name` the reply may resolve
 *   (src/behavior/turn.js#resolveMentions). `stats.pulled` is the
 *   block's budget line: `used`, `kept` (channels shown), `dropped` (channels offered and not
 *   shown, the budget's cut or a missing header label), `lines` (lines offered) and `linesCut`
 *   (lines offered and not shown). `recent` counts what `<recent>` did, null when it was off or
 *   its view held nothing (no item, none hidden, repeated or unnamed): `lines` and `episodes`
 *   shown, `cut` (items offered and not shown), `hidden` (lines `recentAudience` refused),
 *   `repeated` (moments in the window left out as shown in `<people>`) and `unnamed` (moments
 *   left out because their member has no name); `stats.recent` (only when an item was offered)
 *   counts the items, not the header.
 */
export function buildRequest(input) {
  const { config, prompts, calibrator, mode, forced = false, now, selfName, history, neighbors, trigger, triggerKind, channels = [], currentChannelId = null, descriptions, videos, reads, lookup = null } = input;
  const labels = requireLabels(prompts);
  const privateChat = Boolean(input.privateChat);
  const interlocutor = privateChat ? mergeProfiles(input.interlocutor, input.privateProfile) : input.interlocutor;
  const nameOf = typeof input.nameOf === 'function' ? input.nameOf : () => null;
  const { timezone } = config.bot;
  const relationships = config.features?.relationships !== false;
  const episodesOn = config.features?.episodes !== false;
  const loreOn = config.features?.lore !== false;
  const visionCfg = config.context.vision ?? {};
  const visionOn = config.features?.vision !== false;
  // Only this channel's pictures are attached: a trigger in another channel (a routed call)
  // is shown as captions, like every pulled line.
  const pictures = visionOn ? selectPictures({ trigger, history, visionCfg, now, channelId: currentChannelId }) : [];
  const attachedIndex = new Map(pictures.map((picture, i) => [picture.itemId, i + 1]));
  // The GIF library: the switch (a missing key counts as on) and at least one entry.
  const gifLibrary = config.features?.gifs !== false && input.gifs ? normalizeGifs(input.gifs) : null;
  const gifsOn = Boolean(gifLibrary) && Object.keys(gifLibrary.entries).length > 0;
  const formatOptions = {
    timezone,
    gapMinutes: config.context.gapMarkerMinutes,
    maxChars: config.context.maxMessageChars,
    selfName,
    labels,
    seeReactions: config.features?.seeReactions !== false,
    reactionsPerMessage: config.context.reactionsPerMessage,
    attachedIndex,
    descriptions,
    videos,
    reads,
    // A GIF the library knows carries its handle in the transcript.
    gifHandles: gifsOn ? gifHandleMap(gifLibrary) : undefined,
  };

  const nameFill = (text) => fillPromptTemplate(text, { name: selfName });
  const system = [prompts['system-prompt'], prompts['character-card'], prompts.rules, prompts.format]
    .map(nameFill)
    .filter(Boolean)
    .join('\n\n');
  const chatItems = formatTranscript(history, formatOptions);
  const idByIndex = new Map(chatItems.map((item) => [item.index, item.id]));

  // Another channel pulled into this turn (`<channel_view>`): never in a private chat, and
  // shown only when the labels can head it. Its lines are numbered on after the chat's and
  // map back through idByIndex and pulledIds. A routed turn answers a call that lives there.
  const source = privateChat ? null : (input.source ?? null);
  const routed = source?.reason === 'routed';
  const offered = privateChat ? [] : usablePulled(input.pulled, currentChannelId);
  const pulledChannels = labels.pull?.header ? offered : [];
  const chatTrigger = trigger ? (chatItems.find((item) => item.id === trigger.id) ?? null) : null;
  const pulledTriggerId = trigger && !chatTrigger ? trigger.id : null;
  const pulledSets = pulledTranscripts(pulledChannels, { formatOptions, descriptions, firstIndex: history.length, triggerId: pulledTriggerId, labels });
  const pulledIds = new Map();
  for (const channel of pulledSets) {
    for (const item of channel.items) {
      idByIndex.set(item.index, item.id);
      pulledIds.set(item.id, channel.channelId);
    }
  }

  // On a routed turn the call is not in this chat: its silence is measured to now, and its
  // last line being the persona's own is no sign that nobody answered the persona.
  const tempo = computeTempo(history, now, routed ? null : trigger);
  const tempoText = renderTempo(routed ? { ...tempo, lastIsOwn: false } : tempo, labels, config.context.tempo);

  // The trigger's line in another channel (a routed call), when a pulled channel holds it.
  const pulledTrigger =
    pulledTriggerId !== null ? (pulledSets.flatMap((channel) => channel.items).find((item) => item.id === pulledTriggerId) ?? null) : null;
  // A follow-up (triggerKind: 'followUp') falls back to labels.triggers.reply
  // when an older labels.json has no dedicated label yet -- see prompt-contract.md.
  // An overheard line (triggerKind: 'overheard') falls back to the follow-up's label, then reply's.
  // A failed drawing (triggerKind: 'drawFailed') names its reason through labels.draw.reasons.
  const overheard = triggerKind === 'overheard';
  const rawTriggerLabel = overheard
    ? (labels.triggers?.overheard ?? labels.triggers?.followUp ?? labels.triggers?.reply ?? '')
    : triggerKind === 'followUp'
      ? (labels.triggers?.followUp ?? labels.triggers?.reply ?? '')
      : (labels.triggers?.[triggerKind] ?? '');
  const triggerLabel =
    triggerKind === 'drawFailed'
      ? fill(rawTriggerLabel, { reason: labels.draw?.reasons?.[input.drawReason] ?? input.drawReason ?? '' })
      : rawTriggerLabel;
  // A turn about another channel (routed or noticed) names both channels in its task: the
  // source, and this one, where the words go (its live name first).
  const sourceChannel = source ? (offered.find((channel) => channel.channelId === source.channelId) ?? null) : null;
  const here = sourceChannel
    ? (currentChannelFallback(currentChannelId, history)?.name ??
      (input.elsewhereDestination?.name || null) ??
      channels.find((channel) => channel?.id === currentChannelId)?.name ??
      '')
    : '';
  // An overheard turn has its own task text (prompts.overheard) INSTEAD of the mode's; without
  // it (missing or blank) the mode's text frames the line as said to the persona: degraded.
  const overheardTask = overheard && typeof prompts.overheard === 'string' && prompts.overheard.trim() ? prompts.overheard : null;
  // A line put to everyone present (a room question), found in the chat.
  const focus = privateChat ? null : (input.focus ?? null);
  const focusItem = focus ? chatItems.find((item) => item.id === focus.id) : null;
  const focusText = focusItem && labels.room?.focus ? fill(labels.room.focus, { author: focus.authorName ?? '', target: `#${focusItem.index}` }) : '';
  // What else the author waits for: the part answered now and the rest, their queued calls, and
  // their later messages about this call.
  const tasksText = renderTasks(input.tasks, labels);
  // The task text. `callShown`: whether the pulled trigger's line made it into
  // `<channel_view>` -- a task never points at a line the request does not show.
  const composeTask = (callShown) => {
    const callItem = chatTrigger ?? (callShown ? pulledTrigger : null);
    const taskValues = {
      name: selfName,
      author: trigger?.authorName ?? '',
      trigger: triggerLabel,
      target: callItem ? `#${callItem.index}` : '',
      ...(sourceChannel ? { channel: sourceChannel.name, destination: here } : {}),
    };
    const baseTask = fillPromptTemplate(overheardTask ?? prompts[mode] ?? '', taskValues);
    // Owner-forced turn (`/nep interject`/`/nep initiate`): tell the model
    // `<skip/>` is not the expected outcome this time -- optional, missing
    // prompts.forced (an older/undeployed labels layer) leaves the task as-is.
    const forcedText = forced && typeof prompts.forced === 'string' && prompts.forced.trim() ? fillPromptTemplate(prompts.forced, taskValues) : '';
    // Private chat: prompts.private follows the mode prompt; a missing file adds nothing.
    const privateText =
      privateChat && typeof prompts.private === 'string' && prompts.private.trim() ? fillPromptTemplate(prompts.private, taskValues) : '';
    // A routed call: where it came from and where the words go follow the mode's text, while
    // the call is shown and this channel has a name.
    const calledText =
      routed && sourceChannel && callItem && here && labels.elsewhere?.called
        ? fill(labels.elsewhere.called, { channel: sourceChannel.name, destination: here })
        : '';
    return [baseTask, calledText, focusText, tasksText, privateText, forcedText].filter(Boolean).join('\n\n');
  };
  // Fitted as if the call's line is shown: the pulled block keeps it whenever the request has
  // room for it (see fitPulledChannel); checked once the budget is spent.
  const fittedTask = composeTask(true);

  // The server's custom emoji: the switch (a missing key counts as on) and a non-empty index.
  const customEmoji = config.features?.customEmoji !== false && Array.isArray(input.customEmoji) ? input.customEmoji : [];
  const sensesText = renderSenses(config, labels, {
    searchAvailable: input.searchAvailable === true,
    recallAvailable: input.recallAvailable === true,
    drawQuota: input.drawQuota,
    privateChat,
    customEmoji: customEmoji.length > 0,
    gifs: gifsOn,
    // Whether a GIF in the transcript was watched rather than seen in one frame, under the live config and prompts.
    gifWatching: gifWatchBlocker(config, prompts) === null,
    elsewhereDestination: input.elsewhereDestination ?? null,
  });

  // A private chat has no neighbouring channels (and no server map, below).
  const offeredNeighbors = privateChat ? [] : neighbors;
  const pulledChannelIds = new Set(pulledChannels.map((channel) => channel.channelId));
  // Channels the bot can read but not write in, marked in `<server>` and on a pulled header.
  const givenReadOnly = input.readOnlyIds instanceof Set || Array.isArray(input.readOnlyIds) ? input.readOnlyIds : [];
  const readOnlyIds = new Set([
    ...(privateChat ? [] : givenReadOnly),
    ...pulledChannels.filter((channel) => channel.entry.readOnly === true).map((channel) => channel.channelId),
  ]);

  const caps = config.context.caps;
  const cost = sectionCost(calibrator);
  const limit = requestTokenLimit(config) - pictures.length * (visionCfg.tokensPerImage ?? 400) - TAG_OVERHEAD;

  const episodesOpt = { enabled: episodesOn, cap: caps.interlocutor, cost };
  const interlocutorShown = renderProfileShown(interlocutor, labels, {
    interlocutor: true,
    // The author of an overheard line is not talking to the persona.
    mark: !overheard,
    relationships,
    episodes: episodesOpt,
    maxInterests: config.memory?.maxInterests,
    maxDetails: config.memory?.maxDetails,
    maxAliases: config.memory?.maxAliases,
    aliasHalfLifeDays: config.memory?.aliasHalfLifeDays,
    interestHalfLifeDays: config.memory?.interestHalfLifeDays,
    detailHalfLifeDays: config.memory?.detailHalfLifeDays,
    confirmAfter: config.memory?.confirmAfter,
    staleDays: config.memory?.interestStaleDays,
    now,
    nameOf,
  });
  const fixedSection = { name: 'fixed', required: true, items: [system, fittedTask, formatNow(now, timezone, labels.locale), sensesText, tempoText] };
  const interlocutorSection = { name: 'interlocutor', cap: caps.interlocutor, items: [interlocutorShown.text].filter(Boolean) };
  // `<lookup>`: one piece. With both a web and a server part, the first candidate that fits the
  // room the two sections ahead of it leave (the whole block, else the web part alone, else the
  // server part alone); so a server part never costs the web part its place, and the block as a
  // whole stays one item the main pass keeps or drops like before.
  const lookupOptions = lookupCandidates(lookup, labels, timezone);
  let lookupItem = lookupOptions[0] ?? '';
  if (lookupOptions.length > 1) {
    const room = limit - fitSections([fixedSection, interlocutorSection], limit, cost).used;
    lookupItem = lookupOptions.find((text) => cost(text) <= room) ?? lookupItem;
  }
  // The sections fitted ahead of the chat, in priority order.
  const head = [
    fixedSection,
    interlocutorSection,
    // One piece, never split: already bounded by web.search.summaryChars and
    // recall.answerChars / recall.stretchChars, and ahead of the chat so a
    // tight budget trims old messages first.
    { name: 'lookup', items: [lookupItem].filter(Boolean) },
    {
      name: 'aboutChat',
      cap: caps.aboutChat,
      items: aboutChatItems(input.guildMemory, labels, nameOf, learnedConfig(config)),
    },
    {
      name: 'self',
      cap: caps.aboutChat,
      items: (input.guildMemory?.self ?? []).map((fact) => `- ${resolveChatText(fact, nameOf)}`),
    },
    {
      name: 'lore',
      cap: caps.lore,
      keep: 'first',
      items: loreOn ? loreItems(input.loreEntries, history, trigger, labels, config.lore, nameOf) : [],
    },
    {
      name: 'server',
      cap: caps.server ?? 4000,
      keep: 'first',
      items: privateChat
        ? []
        : serverItems(
            channels,
            currentChannelId,
            // A pulled channel's note right after the current channel's, then the neighbours'
            // (each once). Fitted ahead of the pulled block, so it cannot hang on its cut.
            [...pulledChannelIds, ...offeredNeighbors.map((n) => n.channelId).filter(Boolean)],
            history,
            now,
            config.context.channelActivity,
            labels,
            nameOf,
            readOnlyIds,
          ),
    },
  ];
  const chatSection = { name: 'chat', keep: 'newest', items: chatItems.map((item) => item.text) };

  // The pulled block's room: what the sections fitted ahead of it leave (the chat included,
  // except on a routed turn), at most context.caps.pulled, shared evenly between the
  // channels. Each channel is cut to its share here -- the call's own line may go past the
  // share and the cap, never past what the request has left (`free`, exactly what the main
  // pass leaves the block) -- so the main pass keeps every channel whole and the block can
  // never fail the request.
  const pulledCap = caps.pulled ?? 4000;
  const pulledFits = [];
  let pulledTaken = 0;
  if (pulledSets.length > 0) {
    const ahead = routed ? head : [...head, chatSection];
    const free = Math.max(0, limit - fitSections(ahead, limit, cost).used);
    const room = Math.min(pulledCap, free);
    const share = Math.floor(room / pulledSets.length);
    for (const channel of pulledSets) {
      const fitted = fitPulledChannel(channel, {
        budget: Math.min(share, Math.max(0, room - pulledTaken)),
        ceiling: free - pulledTaken,
        cost,
        labels,
        timezone,
        now,
        readOnly: readOnlyIds.has(channel.channelId),
        triggerId: pulledTriggerId,
      });
      if (!fitted) continue;
      pulledTaken += cost(fitted.text);
      pulledFits.push({ ...fitted, channelId: channel.channelId, messages: channel.messages });
    }
  }
  const pulledSection = { name: 'pulled', cap: Math.max(pulledCap, pulledTaken), keep: 'first', items: pulledFits.map((fit) => fit.text) };

  // The neighbours, cut shorter than the chat (context.neighborMessageChars); a channel whose
  // pulled block is shown is not shown again among them, one whose block was cut still is.
  const neighborChars = config.context.neighborMessageChars ?? 300;
  // The neighbours' own cached captions join the chat's for their lines only, so the
  // chat keeps exactly the captions this turn gave it.
  const neighborDescriptions =
    input.neighborDescriptions instanceof Map && input.neighborDescriptions.size > 0
      ? new Map([...input.neighborDescriptions, ...(descriptions ?? [])])
      : descriptions;
  const shownPulledIds = new Set(pulledFits.map((fit) => fit.channelId));
  const neighborItems = offeredNeighbors
    .filter((neighbor) => !shownPulledIds.has(neighbor.channelId))
    .map(
      ({ channelName, messages }) =>
        `# ${channelName}\n${formatTranscript(messages, { ...formatOptions, maxChars: neighborChars, descriptions: neighborDescriptions })
          .map((item) => item.text.replace(/^#\d+ /gm, ''))
          .join('\n')}`,
    );

  // <people> priority (b)/(c): who the trigger message / the last few
  // messages name or @mention (askedAbout, rendered FULL with their top
  // episodes, see below) vs. the other active participants (participants,
  // rendered COMPACT) -- see docs/prompt-contract.md, "Aliases". The authors
  // of the pulled lines shown join (b) after them, under the same cap.
  const { askedAbout, participants } = splitPeople(
    input.otherProfiles,
    input.candidateProfiles,
    history,
    trigger,
    interlocutor?.id,
    config.context.askedAboutProfiles,
    config.memory?.maxAliases,
    config.memory?.aliasHalfLifeDays,
    pulledAuthors(pulledFits),
  );
  // Each member asked about shows their top `context.askedAboutEpisodes` episodes (0 = off;
  // none in a private chat: another member's moments never reach it; none with an older labels
  // file that cannot render one).
  const askedAboutEpisodes = privateChat ? 0 : (config.context.askedAboutEpisodes ?? 3);
  const episodeCount = (profile) => (Array.isArray(profile?.episodes) ? profile.episodes.length : 0);
  const episodeLabelsOn = Boolean(labels.profile?.episodes && labels.profile?.episode && labels.profile?.episodeNoQuote);
  const askedEpisodesOn =
    episodesOn &&
    episodeLabelsOn &&
    Number.isInteger(askedAboutEpisodes) &&
    askedAboutEpisodes > 0 &&
    askedAbout.some((profile) => episodeCount(profile) > 0);
  // The keys of the moments `<people>` shows for the members asked about: the top `counts[i]` of each.
  const askedKeys = (counts) =>
    new Set(askedAbout.flatMap((profile, i) => topEpisodes(profile.episodes, counts[i]).map((ep) => episodeKey(memberIdOf(profile.id), ep))));
  const askedIntended = askedKeys(askedAbout.map(() => (askedEpisodesOn ? askedAboutEpisodes : 0)));

  // `<recent>`: the last `memory.recentHours`, built when the caller hands the store's lines
  // over (an array, empty for a store without one; the mentor's sandbox hands none) with the
  // switch on and the labels present, and shown when the window holds an item this turn may
  // show. The lines `recentAudience` accepts (by default this channel's alone), then the
  // moments of the window (none in a private chat, none without the episode label), the ones
  // about the people this turn is about first: the trigger's author, the interlocutor and the
  // members asked about. A moment `<people>` shows is left out: those the interlocutor's block
  // keeps (none when the budget drops the block), and those of the members asked about --
  // ranked before `<people>` is fitted, the block first leaves out every moment `<people>` may
  // show them by and is built again below when `<people>` shows fewer.
  const recentCfg = recentSettings(config);
  const recentOn = Boolean(recentCfg && labels.recent?.header && labels.recent?.line && Array.isArray(input.recentLines));
  const recentCap = caps.recent ?? 1200;
  const interlocutorId = memberIdOf(interlocutor?.id);
  const recentFocus = [trigger?.authorId, interlocutorId, ...askedAbout.map((profile) => profile?.id)].map(memberIdOf).filter(Boolean);
  const recentAudience = typeof input.recentAudience === 'function' ? input.recentAudience : (channelId) => channelId === currentChannelId;
  const recentProfiles =
    recentOn && !privateChat && episodesOn && labels.recent.episode && Array.isArray(input.candidateProfiles) ? input.candidateProfiles : [];
  const interlocutorKeys = new Set(
    recentProfiles.length > 0 &&
    interlocutorId !== null &&
    interlocutorShown.episodes > 0 &&
    fitSections([fixedSection, interlocutorSection], limit, cost).kept.interlocutor.length > 0
      ? topEpisodes(interlocutor.episodes, interlocutorShown.episodes).map((ep) => episodeKey(interlocutorId, ep))
      : [],
  );
  const buildRecent = (askedShown) => {
    const view = recentView({
      lines: input.recentLines,
      profiles: recentProfiles,
      now,
      hours: recentCfg.hours,
      focusIds: recentFocus,
      excludeEpisodeKeys: new Set([...interlocutorKeys, ...askedShown]),
      isShown: recentAudience,
      perMember: RECENT_EPISODES_PER_MEMBER,
    });
    const { entries, unnamed } = recentEntries(view.items, { labels, timezone, currentChannelId, channels, nameOf });
    return { header: fill(labels.recent.header, { hours: recentCfg.hours }), entries, hidden: view.hidden, repeated: view.repeated, unnamed };
  };
  // One item per entry after the header, in the view's order: the budget keeps them from the top.
  const recentSectionOf = (built, cap) =>
    built && built.entries.length > 0 ? { name: 'recent', cap, keep: 'first', items: [built.header, ...built.entries.map((entry) => entry.text)] } : null;
  let recentBuilt = recentOn ? buildRecent(askedIntended) : null;
  let recentSection = recentSectionOf(recentBuilt, recentCap);

  // The sections fitted ahead of `<people>`, in priority order: the one list both the main
  // pass and the room of the asked-about members' episodes (below) are measured on. The
  // pulled block right after the chat; ahead of it on a routed turn, whose call lives there;
  // then the last hours.
  const aheadOfRecent = [...head, ...(routed ? [pulledSection, chatSection] : [chatSection, pulledSection])];
  let aheadOfPeople = recentSection ? [...aheadOfRecent, recentSection] : aheadOfRecent;
  // Episodes only fill what `<people>` has left once every member asked about is placed
  // without them, as the budget takes them in order, so no member asked about is ever cut
  // for anyone's episodes; the earlier members take theirs first, each losing their lightest
  // first. That room is `caps.people`, or less when the sections ahead of `<people>` leave
  // less; measured only when an episode may be shown. The compact participants after them
  // get what is left.
  const peopleRoomCap = Number.isFinite(caps.people) ? caps.people : Infinity;
  const renderAsked = (profile, episodes) =>
    renderProfileShown(profile, labels, {
      relationships,
      episodes,
      maxInterests: config.memory?.maxInterests,
      maxDetails: config.memory?.maxDetails,
      maxAliases: config.memory?.maxAliases,
      aliasHalfLifeDays: config.memory?.aliasHalfLifeDays,
      interestHalfLifeDays: config.memory?.interestHalfLifeDays,
      detailHalfLifeDays: config.memory?.detailHalfLifeDays,
      confirmAfter: config.memory?.confirmAfter,
      staleDays: config.memory?.interestStaleDays,
      now,
      nameOf,
    });
  const askedAboutBare = askedAbout.map((profile) => renderAsked(profile, undefined).text);
  let askedAboutItems = askedAboutBare;
  // Members asked about the second placement below leaves out (see there): offered, not shown.
  let askedLeftOut = 0;
  if (askedEpisodesOn) {
    const measured = fitSections(aheadOfPeople, limit, cost);
    const free = Math.max(0, limit - measured.used);
    const room = Math.min(peopleRoomCap, free);
    let spare = room;
    // Who the budget keeps without episodes: one that does not fit is skipped, the next tried.
    const placed = askedAboutBare.map((text) => {
      const price = text ? cost(text) : 0;
      if (price > spare) return false;
      spare -= price;
      return true;
    });
    // How many of each member's top episodes their rendering shows.
    const shownCounts = askedAbout.map(() => 0);
    askedAboutItems = askedAbout.map((profile, i) => {
      const bare = askedAboutBare[i];
      if (!placed[i]) return bare;
      const base = bare ? cost(bare) : 0;
      // The most of the top episodes whose rendering fits what is spare.
      for (let max = Math.min(askedAboutEpisodes, episodeCount(profile)); max > 0; max -= 1) {
        const shown = renderAsked(profile, { enabled: true, max });
        const extra = (shown.text ? cost(shown.text) : 0) - base;
        if (extra <= spare) {
          spare -= extra;
          shownCounts[i] = shown.episodes;
          return shown.text;
        }
      }
      return bare;
    });
    const askedShown = askedKeys(shownCounts);
    if (recentBuilt && askedShown.size < askedIntended.size) {
      // `<recent>` again, now leaving out only the moments `<people>` shows: the ones it cuts
      // come back, ranked anew, in the room the block took plus what the request has beyond
      // `<people>`'s room -- so `<people>` keeps at least the room its members were placed in.
      recentBuilt = buildRecent(askedShown);
      recentSection = recentSectionOf(recentBuilt, Math.min(recentCap, (measured.stats.recent?.used ?? 0) + (free - room)));
      aheadOfPeople = recentSection ? [...aheadOfRecent, recentSection] : aheadOfRecent;
      // The room `<people>` has now (never less than `room`): the members placed above keep their
      // rendering, and one that was not is tried bare (their moments are in `<recent>` now) in
      // what is left, never at the cost of a member placed after it. One that the budget would
      // still take where it stands, squeezing such a member out, is left out of the block.
      const roomNow = Math.min(peopleRoomCap, Math.max(0, limit - fitSections(aheadOfPeople, limit, cost).used));
      const prices = askedAboutItems.map((text) => (text ? cost(text) : 0));
      let reserved = prices.reduce((sum, price, i) => sum + (placed[i] ? price : 0), 0);
      let left = roomNow;
      askedAboutItems = askedAboutItems.map((text, i) => {
        if (placed[i]) {
          left -= prices[i];
          reserved -= prices[i];
          return text;
        }
        if (!text) return text;
        if (prices[i] <= left - reserved) {
          left -= prices[i];
          return text;
        }
        if (prices[i] > left) return text;
        askedLeftOut += 1;
        return '';
      });
    }
  }

  // `<people>`'s items, each with the member it renders (an empty rendering is no item).
  const peopleOffered = [
    ...askedAbout.map((profile, i) => ({ profile, text: askedAboutItems[i] })),
    ...participants.map((profile) => ({
      profile,
      text: renderProfile(profile, labels, {
        compact: true,
        relationships,
        maxAliases: config.memory?.maxAliases,
        aliasHalfLifeDays: config.memory?.aliasHalfLifeDays,
        interestHalfLifeDays: config.memory?.interestHalfLifeDays,
        confirmAfter: config.memory?.confirmAfter,
        staleDays: config.memory?.interestStaleDays,
        now,
        nameOf,
      }),
    })),
  ].filter((entry) => entry.text);
  const budgetFit = fitSections(
    [
      ...aheadOfPeople,
      {
        name: 'people',
        cap: caps.people,
        items: peopleOffered.map((entry) => entry.text),
      },
      // One small piece, kept or dropped whole: below the chat and the people, above the rest.
      { name: 'worn', items: [renderWorn(input.worn, labels, config)].filter(Boolean) },
      { name: 'neighbors', cap: caps.neighbors, items: neighborItems },
      // Lowest priority: a list to pick from, trimmed from the bottom (least used last).
      {
        name: 'emoji',
        cap: caps.emoji ?? 800,
        keep: 'first',
        items: emojiItems(customEmoji, input.guildMemory?.emojiUsage, input.mediaCache ?? null, labels, config.context.customEmoji),
      },
      // Below even the emoji: the GIF library, trimmed the same way (least used last).
      {
        name: 'gifs',
        cap: caps.gifs ?? 900,
        keep: 'first',
        items: gifsOn ? gifItems(gifLibrary, input.mediaCache ?? null, labels, config.gifs) : [],
      },
    ],
    limit,
    cost,
  );
  const { kept, stats } = budgetFit;
  let { used } = budgetFit;
  // The header alone, or entries without their header, make no block.
  if (kept.emoji.length < 2 || kept.emoji[0] !== labels.emoji?.header) kept.emoji = [];
  if (kept.gifs.length < 2 || kept.gifs[0] !== labels.gifs?.header) kept.gifs = [];
  if (askedLeftOut > 0) stats.people = { ...stats.people, dropped: stats.people.dropped + askedLeftOut };
  // `<recent>` as one piece: the header, then the entries kept (a subsequence of the offered
  // ones, in their order) oldest first. The header alone, or entries without it, make no block.
  let recent = null;
  if (recentBuilt) {
    const keptRecent = kept.recent ?? [];
    const shown = [];
    if (keptRecent.length >= 2 && keptRecent[0] === recentBuilt.header) {
      let next = 1;
      for (const entry of recentBuilt.entries) {
        if (next < keptRecent.length && keptRecent[next] === entry.text) {
          shown.push(entry);
          next += 1;
        }
      }
    }
    shown.sort((a, b) => a.at - b.at);
    kept.recent = shown.length > 0 ? [[recentBuilt.header, ...shown.map((entry) => entry.text)].join('\n')] : [];
    if (stats.recent) stats.recent = { ...stats.recent, kept: shown.length, dropped: recentBuilt.entries.length - shown.length };
    // Counted only when the view held something: an item, or one hidden, repeated or unnamed.
    const { entries, hidden, repeated, unnamed } = recentBuilt;
    if (entries.length > 0 || hidden + repeated + unnamed > 0) {
      recent = {
        lines: shown.filter((entry) => entry.kind === 'line').length,
        episodes: shown.filter((entry) => entry.kind === 'episode').length,
        cut: entries.length - shown.length,
        hidden,
        repeated,
        unnamed,
      };
    }
  }
  // The members whose profile the request shows: the interlocutor when its block was kept, then
  // the ones `<people>` kept (a subsequence of the offered items, in their order).
  const peopleShown = [];
  const showPerson = (profile) => {
    const id = memberIdOf(profile?.id);
    const names = Array.isArray(profile?.names) ? profile.names.filter((name) => typeof name === 'string') : [];
    if (id !== null) peopleShown.push({ id, names });
  };
  if ((kept.interlocutor ?? []).length > 0) showPerson(interlocutor);
  const keptPeople = kept.people ?? [];
  let nextPerson = 0;
  for (const entry of peopleOffered) {
    if (nextPerson < keptPeople.length && keptPeople[nextPerson] === entry.text) {
      showPerson(entry.profile);
      nextPerson += 1;
    }
  }
  // The pulled channels whose block survived, with what of them was shown.
  const keptPulled = new Set(kept.pulled);
  const pulledKept = pulledFits
    .filter((fit) => keptPulled.has(fit.text))
    .map(({ channelId, ids, newestId, newestTs }) => ({ channelId, ids, newestId, newestTs }));
  // The block's budget line counts what was offered and not shown too: a channel cut whole,
  // or lines cut inside a channel shown.
  const pulledShownLines = pulledKept.reduce((sum, shown) => sum + shown.ids.length, 0);
  const pulledLines = offered.reduce((sum, channel) => sum + channel.messages.length, 0);
  stats.pulled = { ...stats.pulled, dropped: offered.length - pulledKept.length, lines: pulledLines, linesCut: pulledLines - pulledShownLines };

  // A call whose line did not make it into the block is not pointed at: the task loses its
  // target and the called text. The request only gets shorter, so the fit holds.
  const callShown = pulledKept.some((shown) => shown.ids.includes(pulledTrigger?.id));
  const task = pulledTrigger && !callShown ? composeTask(false) : fittedTask;
  if (task !== fittedTask) {
    const saved = cost(fittedTask) - cost(task);
    stats.fixed.used -= saved;
    used -= saved;
  }

  const keptChat = chatItems.slice(chatItems.length - kept.chat.length);
  const user = assembleUser({ now, timezone, labels, sensesText, kept, tempoText, task, chatItems: keptChat });

  // A provider that rejects the images (see src/behavior/turn.js's 4xx
  // retry) must never resend a <chat> claiming a picture is attached with
  // nothing actually attached: `textFallback` re-renders the SAME kept
  // messages with attachedIndex dropped, so imageAttached/frameAttached fall
  // back to their blind/described forms. Only `<chat>` is re-rendered: the
  // pulled lines never carry an attachment marker (rendered without
  // attachedIndex from the start), but `<other_channels>` lines are rendered
  // with it, so a neighbour line holding an item that is attached for the
  // chat (the same sticker or link id) shows the attached marker in both
  // renderings -- a known gap, left as it is. Computed only when there is
  // anything to fall back from.
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
    pulledIds,
    pulledKept,
    peopleShown,
    recent,
  };
}
