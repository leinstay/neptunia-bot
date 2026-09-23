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
import { affinityBand, roundScore } from '../memory/affinity.js';
import { isConfirmed, isStale } from '../memory/interests.js';
import { topByRank } from '../memory/ranking.js';
import { sortEpisodesForDisplay } from '../memory/episodes.js';
import { matchLore } from '../memory/lore.js';
import { channelActivity, renderChannel } from '../memory/channels.js';
import { selectPictures, mediaProxyUrl } from '../discord/media.js';
import { fromTokens, occursAsWholeWord } from '../memory/mentions.js';

const TAG_OVERHEAD = 60;

function block(tag, body) {
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
 * The caller's remembered episodes as `[heading, ...oneLinePerEpisode]`,
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
 * Append `labels.profile.unsureMark`/`staleMark` to `text` per
 * docs/prompt-contract.md, "Confirmation"/"Dates come from the
 * messages": the unsure mark when `item` is below `marks.confirmAfter`, then
 * the stale mark when `item` is older than `marks.staleDays` (skipped
 * entirely for `marks.stale === false`, since details never go stale). Both
 * marks are OPT IN: `marks.confirmAfter`/`marks.staleDays` being anything
 * other than a plain number (i.e. omitted -- the direct-call/older-caller
 * case) never marks anything, so a caller that does not know about this
 * feature renders exactly as before. A missing label appends nothing.
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
 * weight (no decay), matching the behaviour before this feature.
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
 * docs/prompt-contract.md, "<people>". `opts.episodes.cap`/`.cost`
 * (when given) trim the episode list, heaviest-first, to fit that token
 * budget on top of the rest of the profile; without them every episode
 * renders. `opts.maxInterests`/`opts.maxDetails` cap how many interests/details
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
 */
export function renderProfile(
  profile,
  labels,
  {
    interlocutor = false,
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
  if (!profile) return '';
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
  if (!hasContent && !interlocutor) return '';
  if (!hasContent) restLines.push(p.unknown);
  if (!compact && profile.messageCount) restLines.push(fill(p.messageCount, { count: profile.messageCount }));

  const mark = interlocutor ? p.interlocutorMark : '';
  const heading = `## ${name}${mark}`;

  let renderedEpisodes = interlocutor && !compact && episodes?.enabled ? episodeLines(profile.episodes, labels, nameOf) : [];
  if (renderedEpisodes.length && typeof episodes.cap === 'number' && typeof episodes.cost === 'function') {
    const restText = [heading, ...attitudeLines, ...restLines].join('\n');
    renderedEpisodes = fitEpisodeLines(renderedEpisodes, episodes.cap - episodes.cost(restText), episodes.cost);
  }

  return [heading, ...attitudeLines, ...renderedEpisodes, ...restLines].join('\n');
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
 * where-am-I fallback.
 */
function serverItems(channels, currentChannelId, neighborChannelIds, history, now, activityCfg, labels, nameOf) {
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
      },
    ),
  );
}

function aboutChatItems(guildMemory, labels, nameOf) {
  const a = labels.aboutChat;
  const items = [];
  if (guildMemory?.patterns) items.push(fill(a.patterns, { text: resolveChatText(guildMemory.patterns, nameOf) }));
  if (guildMemory?.starters) items.push(fill(a.starters, { text: resolveChatText(guildMemory.starters, nameOf) }));
  if (guildMemory?.injokes?.length) {
    items.push(fill(a.injokes, { text: guildMemory.injokes.map((text) => resolveChatText(text, nameOf)).join('; ') }));
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

  const matched = matchLore(entries, recentTexts, { maxMatches: loreCfg?.maxMatches ?? Infinity });
  return matched.map((lore) => fill(entry, { title: lore.title, text: resolveChatText(lore.text, nameOf) }));
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

/**
 * Fill the double-brace `{{key}}` placeholders of a prompt file (the prompt
 * contract's form; labels.json uses single braces, see fill() in
 * src/discord/format.js). An unknown key is left untouched.
 * @param {string} template
 * @param {object} values
 */
export function fillPromptTemplate(template, values) {
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
 * under the live config (see docs/prompt-contract.md, "`<senses>`").
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

  lines.push(senses.voice, videoOn ? (senses.linksWatch ?? senses.links) : senses.links, senses.files);
  return lines.filter(Boolean).join('\n');
}

const ASKED_ABOUT_SCAN_MESSAGES = 5;

/** Whether `ch` is a letter/digit/underscore (Unicode-aware) -- same word-char
 * notion as `occursAsWholeWord` (src/memory/mentions.js), duplicated locally
 * so `nameOccurs` below stays a pure, single-purpose function. */
function isWordChar(ch) {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

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
 * @param {object[]} otherProfiles
 * @param {object[]} candidateProfiles
 * @param {object[]} history
 * @param {object|null} trigger
 * @param {string|number|null|undefined} excludeId
 * @param {number} [maxAskedAbout]        Not a non-negative integer -> no cap.
 * @param {number} [maxAliases]
 * @param {number} [aliasHalfLifeDays]
 * @returns {{ askedAbout: object[], participants: object[] }}
 */
function splitPeople(otherProfiles, candidateProfiles, history, trigger, excludeId, maxAskedAbout, maxAliases, aliasHalfLifeDays) {
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

  return { askedAbout, participants };
}

/**
 * @param {object} input
 * @param {object} input.config            Live config.
 * @param {object} input.prompts           Live prompts keyed by file name.
 * @param {object} input.calibrator
 * @param {'reply'|'interject'|'initiate'} input.mode
 * @param {boolean} [input.forced]  True for an owner-forced turn (`/nep interject`, `/nep
 *   initiate`): when `prompts.forced` is a non-empty string, its filled text is appended to the
 *   task text (same placeholders as `prompts[mode]`) so the model knows `<skip/>` is not the
 *   expected outcome this time. Missing `prompts.forced` -> no change, same as before this existed.
 * @param {number} input.now
 * @param {string} input.selfName
 * @param {object[]} input.history         Normalized channel messages, oldest first.
 * @param {{channelId?: string, channelName: string, messages: object[]}[]} input.neighbors
 *   `channelId` (see src/discord/collect.js#fetchNeighbors) is how `<server>` tells which
 *   stored channel note, if any, belongs to a neighbour that contributed to `<other_channels>` --
 *   omitted (an older/direct caller) simply means that neighbour never gets its note shown.
 * @param {object|null} input.trigger      Normalized message that called the persona (reply mode).
 * @param {string|null} input.triggerKind
 * @param {object} input.guildMemory
 * @param {object|null} input.interlocutor Profile of the trigger's author.
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
 *   NOT selected to be attached (see src/behavior/turn.js, src/memory/describe.js).
 * @param {Map<string, object>} [input.videos]  Item id -> video state from the video describer
 *   (src/memory/describe.js#describeVideos), passed to formatTranscript.
 * @returns {{ messages: object[], stats: object, idByIndex: Map<number, string>, tempo: object }}
 */
export function buildRequest(input) {
  const { config, prompts, calibrator, mode, forced = false, now, selfName, history, neighbors, trigger, triggerKind, channels = [], currentChannelId = null, descriptions, videos } = input;
  const labels = requireLabels(prompts);
  const nameOf = typeof input.nameOf === 'function' ? input.nameOf : () => null;
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
    videos,
  };

  const nameFill = (text) => fillPromptTemplate(text, { name: selfName });
  const system = [prompts['system-prompt'], prompts['character-card'], prompts.rules, prompts.format]
    .map(nameFill)
    .filter(Boolean)
    .join('\n\n');
  const chatItems = formatTranscript(history, formatOptions);
  const idByIndex = new Map(chatItems.map((item) => [item.index, item.id]));
  const tempo = computeTempo(history, now, trigger);
  const tempoText = renderTempo(tempo, labels, config.context.tempo);

  const triggerItem = trigger ? chatItems.find((item) => item.id === trigger.id) : null;
  // A follow-up (triggerKind: 'followUp') falls back to labels.triggers.reply
  // when an older labels.json has no dedicated label yet -- see prompt-contract.md.
  const triggerLabel =
    triggerKind === 'followUp' ? (labels.triggers?.followUp ?? labels.triggers?.reply ?? '') : (labels.triggers?.[triggerKind] ?? '');
  const taskValues = {
    name: selfName,
    author: trigger?.authorName ?? '',
    trigger: triggerLabel,
    target: triggerItem ? `#${triggerItem.index}` : '',
  };
  const baseTask = fillPromptTemplate(prompts[mode] ?? '', taskValues);
  // Owner-forced turn (`/nep interject`/`/nep initiate`): tell the model
  // `<skip/>` is not the expected outcome this time -- optional, missing
  // prompts.forced (an older/undeployed labels layer) leaves the task as-is.
  const forcedText = forced && typeof prompts.forced === 'string' && prompts.forced.trim() ? fillPromptTemplate(prompts.forced, taskValues) : '';
  const task = forcedText ? `${baseTask}\n\n${forcedText}` : baseTask;

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

  // <people> priority (b)/(c): who the trigger message / the last few
  // messages name or @mention (askedAbout, rendered FULL, no episodes) vs. the
  // other active participants (participants, rendered COMPACT) -- see
  // docs/prompt-contract.md, "Aliases".
  const { askedAbout, participants } = splitPeople(
    input.otherProfiles,
    input.candidateProfiles,
    history,
    trigger,
    input.interlocutor?.id,
    config.context.askedAboutProfiles,
    config.memory?.maxAliases,
    config.memory?.aliasHalfLifeDays,
  );

  const episodesOpt = { enabled: episodesOn, cap: caps.interlocutor, cost };
  const { kept, stats, used } = fitSections(
    [
      { name: 'fixed', required: true, items: [system, task, formatNow(now, timezone, labels.locale), sensesText, tempoText] },
      {
        name: 'interlocutor',
        cap: caps.interlocutor,
        items: [
          renderProfile(input.interlocutor, labels, {
            interlocutor: true,
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
          }),
        ].filter(Boolean),
      },
      { name: 'aboutChat', cap: caps.aboutChat, items: aboutChatItems(input.guildMemory, labels, nameOf) },
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
        cap: caps.server ?? 2500,
        keep: 'first',
        items: serverItems(
          channels,
          currentChannelId,
          neighbors.map((n) => n.channelId).filter(Boolean),
          history,
          now,
          config.context.channelActivity,
          labels,
          nameOf,
        ),
      },
      { name: 'chat', keep: 'newest', items: chatItems.map((item) => item.text) },
      {
        name: 'people',
        cap: caps.people,
        items: [
          ...askedAbout.map((profile) =>
            renderProfile(profile, labels, {
              relationships,
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
            }),
          ),
          ...participants.map((profile) =>
            renderProfile(profile, labels, {
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
          ),
        ].filter(Boolean),
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
