// One "turn": collect context → build the request under the token cap → ask
// the model → act in Discord like a person would (pause, typing indicator
// proportional to the text, several short messages in a row, reactions).
// Used for answering a call ('reply') and for spontaneous turns
// ('interject' / 'initiate'), in a server channel or in a private chat (a
// channel without a guild, served on behalf of the one pinned guild). A
// server turn may also show other channels it is about (`<channel_view>`):
// the read-only channel a call came from, a channel named with an explicit
// <#id>, or one a route hook names. The turn still speaks only here: a
// reaction on a shown line of another channel lands in that channel, and a
// post (a message, the GIF, the picture) answering such a line goes here
// plain, with a jump link to it.

import {
  audienceOf,
  canAttach,
  canReact,
  fetchHistory,
  fetchNeighbors,
  isWritableChannel,
  PAGE as HISTORY_PAGE,
  withTextPreviews,
} from '../discord/collect.js';
import { audienceAllows, captionPulled, checkPull, fetchPull } from '../discord/pull-fetch.js';
import { buildDrawPrompt, buildRequest, fillPromptTemplate } from './prompt.js';
import { channelPullOn, pullSettings, pullTargets } from './pull.js';
import { audienceCovers, markSeen, messageLink, resolveDestination, stampPings } from './elsewhere.js';
import { classifierTextModel } from './mention.js';
import { parseLookupAnswer, recallSettings } from './recall.js';
import { turnRequestInput } from './turn-input.js';
import { parseOutput } from '../llm/parse.js';
import { DailyCapError, TokenLimitError, RETRY_STATUS, helperRequestOptions, sleep } from '../llm/openrouter.js';
import { ImageCapError, ImageGenError } from '../llm/images.js';
import { limitOf, mirrorChannelLabel, mirrorDryRun, postLimitNotice } from './limits.js';
import { between, typingMs } from './random.js';
import {
  collectPictures,
  collectEmojiItems,
  collectVideos,
  collectReadableLinks,
  isDescribable,
  selectPictures,
} from '../discord/media.js';
import { avatarReference, createImageFetcher } from '../discord/fetch-image.js';
import { renderCustomEmoji, resolveReactionEmoji } from '../discord/emoji.js';
import { fill, formatTranscript, renderTranscript } from '../discord/format.js';
import { log } from '../log.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { gifPostsToday } from '../memory/gif-watch.js';
import { liveRecent, recentSettings } from '../memory/recent.js';
import { isVideoVisionOn } from '../memory/youtube-check.js';
import { bumpDaily, utcDay } from '../time.js';

/**
 * How a turn ended. `spoke` and `skip` reached the model (a skip chose
 * silence); `busy` (another turn blocks this one), `paused` (`/nep pause`),
 * `not-now` (a spontaneous chooser found nothing to do) never did; `refused`
 * is a rail (request or token cap) and carries its `limit`; `error` is any
 * other failure, logged.
 * @typedef {'spoke'|'skip'|'busy'|'refused'|'paused'|'not-now'|'error'} TurnOutcome
 */

/**
 * Why a reply turn runs: a `@mention`, a Discord reply to the persona, a
 * name trigger, a follow-up the address classifier said "yes" to, a line the
 * address classifier found to be about the persona but said to someone else
 * or to the room (`overheard`), a private chat message, or the second turn
 * after a drawing that failed. Each has a `labels.triggers` entry.
 * @typedef {'mention'|'reply'|'name'|'followUp'|'overheard'|'private'|'drawFailed'} TriggerKind
 */

/**
 * Whether a turn of `triggerKind` posts plain, never as a Discord reply: the
 * address classifier's turns (a follow-up, an overheard line), whose model
 * `reply="#n"` quotes nothing for messages, the GIF and the picture alike (a
 * pulled line it points at still gets its jump link: replyTarget). The
 * drawFailed turn after such a turn posts plain too: runTurn hands it the
 * first turn's kind. Exported so a limit notice can quote by the same rule.
 * @param {TriggerKind|null|undefined} triggerKind
 * @returns {boolean}
 */
export function postsPlain(triggerKind) {
  return triggerKind === 'followUp' || triggerKind === 'overheard';
}

/** `mentor.anchor.ledgerSize` when it is missing or unusable: config.json's value. */
const POST_LEDGER_SIZE_FALLBACK = 300;

/**
 * How many entries the post ledger (`state.json` `postLedger`) keeps:
 * `mentor.anchor.ledgerSize` read from `config` (the live config), floored;
 * 0 keeps none; missing or not a non-negative number -> 300 (config.json's value).
 * @param {object} config
 * @returns {number}
 */
export function postLedgerSize(config) {
  const size = config?.mentor?.anchor?.ledgerSize;
  return Number.isFinite(size) && size >= 0 ? Math.floor(size) : POST_LEDGER_SIZE_FALLBACK;
}

/**
 * The post ledger with `entry` appended, cut to its newest `size` entries.
 * The ledger tells the mentor (src/mentor/anchor.js#ledgerEntryFor) which
 * turn a posted message of the persona belonged to. A value that is not a
 * list counts as an empty ledger. Pure: the given list is not changed.
 * @param {unknown} ledger
 * @param {{ messageId: string, channelId: string, mode: string, triggerKind: string|null,
 *   triggerId: string|null, newestHistoryId: string|null, sourceChannelId: string|null, at: number }} entry
 * @param {number} size
 * @returns {object[]}
 */
export function appendPostLedger(ledger, entry, size) {
  if (!(size > 0)) return [];
  const list = Array.isArray(ledger) ? ledger : [];
  return [...list, entry].slice(-size);
}

/**
 * Whether someone asked for this turn: it has a trigger that is not an
 * overheard line (talk about the persona asks it nothing). An unasked turn
 * gets no image-cap notice and no drawFailed turn, and charges no member's
 * picture quota -- like a spontaneous turn.
 */
function askedFor(trigger, triggerKind) {
  return Boolean(trigger) && triggerKind !== 'overheard';
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

/**
 * Profiles of the people most recently active in the transcript, excluding `exceptId`.
 * Also used by the mentor's reply sandbox (src/mentor/sandbox.js) with a store-shaped reader.
 * @param {{ getUser: (guildId: string, userId: string) => (object|null) }} store
 * @param {string} guildId
 * @param {object[]} history
 * @param {string|undefined} exceptId
 * @param {number} count
 * @returns {object[]}
 */
export function pickOtherProfiles(store, guildId, history, exceptId, count) {
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

/** No `<recent>` input: no store's lines handed over, so the request builder builds no block. */
const NO_RECENT = Object.freeze({ lines: undefined, audience: undefined });

/**
 * The audience of "every member of the server" in the shape
 * src/behavior/elsewhere.js#audienceCovers compares: @everyone views it and no
 * role or member is held back. A source covers it only when every member can
 * read that source -- the private chat's rail for recent lines.
 */
function everyMemberAudience() {
  return { everyone: true, roles: new Set(), roleAllow: new Set(), roleDeny: new Set(), memberAllow: new Set(), memberDeny: new Set() };
}

/** Display name of the author of `messageId` in `history`, or null when the message is not there. */
function authorNameFor(history, messageId) {
  const message = history.find((m) => m.id === messageId);
  return message?.authorName ?? null;
}

/**
 * Where the model's `reply="#n"` points. `replyId`: a line of this chat, which
 * a post may quote as a Discord reply. `pulledId`: a line of a pulled channel
 * (`pulledIds`, buildRequest's map of every pulled line to its channel), which
 * a post here never quotes -- Discord resolves a reply reference in the
 * channel posted to -- and links instead (createLinker). A turn that posts
 * plain (postsPlain) quotes no chat line; a pulled line is linked all the
 * same, since a link is not a Discord reply.
 * @returns {{ replyId: string|null, pulledId: string|null }}
 */
function replyTarget(replyTo, { plain, idByIndex, pulledIds }) {
  const id = replyTo !== null && replyTo !== undefined ? (idByIndex.get(replyTo) ?? null) : null;
  if (id === null) return { replyId: null, pulledId: null };
  if (pulledIds.has(id)) return { replyId: null, pulledId: id };
  return { replyId: plain ? null : id, pulledId: null };
}

/**
 * Where a reaction on line `targetId` goes: this channel for a chat line; for
 * a pulled line (`pulledIds`) its own channel, looked up in this channel's
 * guild, while the bot may react there now (canReact). Otherwise `target` is
 * null and `reason` is the code the drop is logged with: `not-found` (the
 * channel is gone) or `cannot-react`. `source` is the pulled channel's id,
 * null for a chat line.
 * @returns {{ target: object|null, source: string|null, reason: 'not-found'|'cannot-react'|null }}
 */
function reactionChannel(channel, targetId, pulledIds) {
  const source = pulledIds.get(targetId) ?? null;
  if (!source) return { target: channel, source: null, reason: null };
  const target = channel.guild?.channels?.cache?.get?.(source) ?? null;
  if (!target) return { target: null, source, reason: 'not-found' };
  return canReact(target) ? { target, source, reason: null } : { target: null, source, reason: 'cannot-react' };
}

/**
 * What the first post of a turn about another channel (`source`) links to
 * when it answers no pulled line: a routed call (in its own channel), else the
 * newest line of the source the request showed (buildRequest's `pulledKept`).
 * Null without a source, or when nothing of it was shown (the budget dropped
 * its block): a post never points at a line the model did not see.
 * @returns {{ channelId: string, messageId: string }|null}
 */
function sourceLinkTarget({ source, trigger, pulledKept }) {
  if (!source?.channelId) return null;
  if (source.reason === 'routed' && trigger?.id) return { channelId: trigger.channelId || source.channelId, messageId: trigger.id };
  const newestId = pulledKept.find((shown) => shown.channelId === source.channelId)?.newestId ?? null;
  return newestId ? { channelId: source.channelId, messageId: newestId } : null;
}

/**
 * The jump links (src/behavior/elsewhere.js#messageLink) of one turn's posts
 * -- its messages, then the GIF, then the picture -- asked in posting order;
 * act and dryAct share the rule, so a rehearsal shows the links a real turn
 * posts. A post answering a pulled line (`pulledId`) links to that line; on a
 * turn about another channel the first post links to `sourceTarget` when it
 * answers none. One line is linked at most once per turn: a second answer to
 * it carries no link.
 * @param {{ guildId: string, pulledIds: Map<string, string>,
 *   sourceTarget: { channelId: string, messageId: string }|null }} args
 * @returns {(pulledId: string|null) => string|null}  The next post's link, or null.
 */
function createLinker({ guildId, pulledIds, sourceTarget }) {
  const linked = new Set();
  let first = true;
  return (pulledId) => {
    const target = pulledId ? { channelId: pulledIds.get(pulledId), messageId: pulledId } : first ? sourceTarget : null;
    first = false;
    if (!target || linked.has(target.messageId)) return null;
    linked.add(target.messageId);
    return messageLink(guildId, target.channelId, target.messageId);
  };
}

// A Discord message holds at most 2000 characters.
const DISCORD_MESSAGE_CHARS = 2000;

/**
 * `text` cut to `max` characters at its end, never inside a `<...>` token (a
 * mention, a custom emoji); unchanged when it fits.
 */
function cutPost(text, max) {
  let body = clampChars(text, max);
  if (body.length < text.length) {
    const open = body.lastIndexOf('<');
    if (open > body.lastIndexOf('>')) body = body.slice(0, open);
    body = body.trimEnd();
  }
  return body;
}

/**
 * `text` with `link` joined through `labels.elsewhere.link` (`{text}` `{link}`);
 * without the label, a newline between them. Every post fits one Discord
 * message: `text` is cut at its end (cutPost) when it would outgrow it --
 * with a link, so that the link always fits; without one, after the mentions
 * and custom emoji expanded into it (parse.js leaves only a small margin for
 * them, which a few long ones or a link outgrow).
 */
function withLink(text, link, labels) {
  if (!link) return cutPost(text, DISCORD_MESSAGE_CHARS);
  const template = labels?.elsewhere?.link;
  const join = (body) => (typeof template === 'string' && template ? fill(template, { text: body, link }) : `${body}\n${link}`);
  return join(cutPost(text, Math.max(0, DISCORD_MESSAGE_CHARS - [...join('')].length)));
}

const REWATCH_QUESTION_CHARS = 300;
const REWATCH_SUMMARY_CHARS = 200;
// Protocol tokens of the re-watch classifier (docs/en/prompt-contract.md), not wording:
// the status column of a `<videos>` line and the answer that asks for a retry.
const REWATCH_STATUS_WATCHED = 'watched';
const REWATCH_STATUS_NOT_LOADED = 'not loaded';
const REWATCH_RETRY = /^retry$/i;
// The ordinal column: `<n>`, tolerating a `#` before it or a `.` after it.
const REWATCH_ORDINAL = /^#?\s*(\d+)\.?$/;

/**
 * Parse the re-watch classifier's answer (prompts/rewatch.md): ONE line,
 * `none` or `<n> | <question>` (`<n> | retry` asks to try a video that did
 * not load again), where `<n>` is the 1-based ordinal of a `<videos>` line
 * (1 = the newest; ordinals, not ids, because the model miscopies long ids).
 * `#1` and `1.` are accepted as `1`. Only the first non-empty line counts;
 * `none` (any case), anything unparsable, an ordinal outside 1..`count` or an
 * empty question -> no pick. The question is trimmed and cut to 300
 * characters; `retry` is true when it is exactly `retry` (any case). The
 * caller maps `n` back to its candidate (`candidates[n - 1]`). `reason` is a
 * code safe to log: `none` (the model answered none), `empty` (no non-empty
 * line), `no-bar`, `unknown-id` (not an ordinal within 1..`count`; the name
 * predates ordinals and is kept for log continuity), `no-question` or `ok`.
 * @param {string} raw
 * @param {number} count  How many videos the `<videos>` block listed.
 * @returns {{ pick: { n: number, question: string, retry: boolean }|null,
 *   reason: 'none'|'empty'|'no-bar'|'unknown-id'|'no-question'|'ok' }}
 */
export function parseRewatchPickDetailed(raw, count) {
  const line = String(raw ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return { pick: null, reason: 'empty' };
  if (/^none$/i.test(line)) return { pick: null, reason: 'none' };
  const bar = line.indexOf('|');
  if (bar === -1) return { pick: null, reason: 'no-bar' };
  const ordinal = REWATCH_ORDINAL.exec(line.slice(0, bar).trim());
  const n = ordinal ? Number(ordinal[1]) : NaN;
  const question = [...line.slice(bar + 1).trim()].slice(0, REWATCH_QUESTION_CHARS).join('').trim();
  if (!Number.isSafeInteger(n) || n < 1 || n > count) return { pick: null, reason: 'unknown-id' };
  if (!question) return { pick: null, reason: 'no-question' };
  return { pick: { n, question, retry: REWATCH_RETRY.test(question) }, reason: 'ok' };
}

/**
 * The link items of `history` the web lookup may read (src/discord/media.js#collectReadableLinks:
 * no video-site link, no gif embed), newest message first.
 */
function readableLinkCandidates(history, sites) {
  const out = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    out.push(...collectReadableLinks(history[i], { videoSites: sites ?? [] }));
  }
  return out;
}

/** Upload file name for a generated picture: `image/jpeg` -> `image.jpg`, else `image.<subtype>`; `/nep draw` names its picture the same way. */
export function imageFileName(mediaType) {
  const subtype = String(mediaType ?? '').split('/')[1]?.split(';')[0]?.trim().toLowerCase() || 'png';
  return `image.${subtype === 'jpeg' ? 'jpg' : subtype}`;
}

// A Discord message holds 2000 characters; the part mark is ` (n/m)` on the header plus the newline.
const MIRROR_MAX_CHARS = 2000;
const MIRROR_PART_MARK_CHARS = 16;

/**
 * `text` in pieces of at most `max` code points, each cut at its last newline
 * when there is one, so a dry-run mirror of a long text fits Discord messages.
 */
function splitForMirror(text, max) {
  const limit = Math.max(1, Math.floor(max));
  const parts = [];
  let rest = [...String(text ?? '')];
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const newline = window.lastIndexOf('\n');
    const cut = newline > 0 ? newline : limit;
    parts.push(rest.slice(0, cut).join(''));
    rest = rest.slice(newline > 0 ? cut + 1 : cut);
  }
  parts.push(rest.join(''));
  return parts;
}

/**
 * Describable pictures (image/gif/video/sticker/link-thumbnail, plus custom
 * emoji — see src/discord/media.js#isDescribable) of `history` that are NOT
 * among `picked` (the ones already attached as image_url parts), newest
 * message first — so a per-turn cap spends its budget on what the persona
 * just saw. Pictures (collectPictures) come before that message's emoji.
 *
 * With `includePicked` (features.attachedDescriptions), the attached pictures
 * are candidates too and come FIRST, newest first: they are what the turn is
 * about. A picked `link` thumbnail stays out -- its attached form
 * (frameAttached) never shows a caption, so one would be spent for nothing.
 */
function describableCandidates(history, picked, { includePicked = false } = {}) {
  const pickedIds = new Set(picked.map((p) => p.itemId));
  const out = includePicked ? [...picked].reverse().filter((item) => item.kind !== 'link' && isDescribable(item)) : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    for (const item of [...collectPictures(history[i]), ...collectEmojiItems(history[i])]) {
      if (pickedIds.has(item.itemId) || !isDescribable(item)) continue;
      out.push(item);
    }
  }
  return out;
}

/**
 * Where the persona's words about a channel it cannot write in go (a call
 * from there, a remark on it), read from `config` (the live config) at the
 * call: the first id of `memory.mainChannelIds`
 * (src/behavior/elsewhere.js#resolveDestination) that is a channel of
 * `guild` the persona may write in (src/discord/collect.js#isWritableChannel:
 * a text channel, not a thread, allowed by `bot.channels`, never the dry-run
 * mirror, its history readable, the bot can send) and not `exceptId` (the
 * channel the words are about). The one copy of the rule: `<senses>` names
 * this channel, and whatever routes a call there asks the same function.
 * @param {object|null} guild  The discord.js guild; none (a private chat) has no destination.
 * @param {object} config      The live config.
 * @param {{ exceptId?: string|null }} [options]
 * @returns {{ channel: object, reason: null } | { channel: null, reason: 'off'|'no-destination' }}
 *   `reason` is resolveDestination's code: `off` with features.elsewhere false, else `no-destination`.
 */
export function usableDestination(guild, config, { exceptId = null } = {}) {
  const channelOf = (id) => guild?.channels?.cache?.get?.(id) ?? null;
  const usable = (id) => {
    const target = channelOf(id);
    return Boolean(target) && id !== exceptId && typeof target.isTextBased === 'function' && isWritableChannel(target, config?.bot ?? {});
  };
  const { destinationId, reason } = resolveDestination(config, usable);
  return destinationId ? { channel: channelOf(destinationId), reason: null } : { channel: null, reason };
}

/**
 * `images` (src/llm/images.js#createImageGen) is optional: absent,
 * `features.imageGeneration` false, a `drawFailed` turn, or a channel where
 * the bot cannot attach files, the persona's `<draw>` is dropped and no
 * drawing line reaches `<senses>`.
 *
 * `lookup` (src/web/lookup.js#createLookup) is optional too: absent, or
 * `features.webLookup` not true, no link is read and no search is made.
 *
 * `recall` (src/behavior/recall-run.js#createRecall) is optional too: the
 * search of the server's own history beside the web search. Absent, or its
 * `available()` false, or a private chat, no server search is made. The one
 * lookup classifier serves both (maybeLookup) and the request's `lookup`
 * input carries both parts: the web search's result as it is
 * (src/web/lookup.js#search, `{ query, text, sources, cached? }`), with a
 * `server` key (`{ text, stretch, people }`, recall's result) added only when
 * the server search found something; a server part alone is `{ server }`.
 * A web-only result is exactly the web search's object, as before recall.
 *
 * `now` (default Date.now) is the turn's clock: its own time, `{{today}}` of
 * the search classifier, the daily GIF counter, every `lastPostAt` stamp and
 * the post ledger's times.
 *
 * With features.mentor true every message, GIF and picture a turn posts in a
 * server channel is recorded in `state.json` `postLedger` (recordPost; at
 * most `mentor.anchor.ledgerSize`, nothing while paused or in a dry run): `{
 * messageId, channelId, mode, triggerKind, triggerId, newestHistoryId,
 * sourceChannelId, at }`, read by src/mentor/anchor.js#ledgerEntryFor.
 *
 * `emoji` (src/discord/emoji.js#createEmojiIndex) is optional: absent, or
 * `features.customEmoji` false (a missing key counts as on), no `:name:` is
 * turned into a custom emoji and a `<react>` with a custom one is dropped.
 *
 * `describer` (src/memory/describe.js#createDescriber) is optional: when
 * absent, or `features.mediaDescriptions` is off, no description request is
 * ever made — buildRequest simply renders every un-attached picture blind
 * (and every attached one with its bare marker). A neighbour channel's
 * pictures never cost a request: they get only the captions the cache
 * already holds (`describer.cachedDescriptions`), under the same switch. A
 * pulled channel's pictures (`<channel_view>`) get the cache's captions, and
 * fresh ones only once the turn is certain to run (src/discord/pull-fetch.js).
 * Likewise, videos are only watched when `features.mediaDescriptions` AND
 * `features.videoDescriptions` (a missing key counts as on) are on and the describer has
 * `describeVideos`; otherwise they render without a watch.
 *
 * `variety` (src/behavior/variety-pass.js#createVarietyPass) is optional: when
 * present, every turn but a `drawFailed` one looks up its pass on the persona's
 * own recent lines as soon as the history is known, alongside the rest of the
 * preparation, and the request carries its answer as `<worn>`; every message
 * posted in a server channel joins its ring of own lines; and once a turn's
 * text is out (not in a dry run), the pass for the next turn starts ahead
 * (`variety.ahead`, when the pass has it). Absent -> none of these.
 *
 * `getSelfName` (src/index.js) is the persona's display name in a guild;
 * default: the client's cached guild member, else the bot user's name.
 *
 * `routeChannels` (the route classifier's hook; src/index.js passes
 * src/behavior/route-channel.js#createChannelRouter's) is optional:
 * `({ guildId, channel, history, trigger, triggerKind, selfName, config }) => Promise<string[]>`,
 * the ids of channels the conversation is about; `triggerKind` is the turn's
 * TriggerKind (null on a turn without a trigger), so the hook can decline
 * kinds it does not serve (src/behavior/route.js#routeAllowed). It is asked on a server turn
 * (never a drawFailed one) with features.channelPull on and the labels able
 * to render the block (`labels.pull.header`) while a
 * `<channel_view>` slot (`context.pull.maxChannels`) is left after the turn's
 * source and the explicit `<#id>` mentions; its ids are pulled after those
 * (src/behavior/pull.js#pullTargets). On a routed turn `history` is the source
 * channel's lines, not this chat. A throw or an answer that is not an array
 * counts as no id (a throw logs `pull: route failed`).
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
  lookup,
  recall = null,
  images,
  emoji,
  variety,
  getSelfName = (guildId) => client.guilds?.cache?.get(guildId)?.members?.me?.displayName ?? client.user?.username ?? 'bot',
  routeChannels,
  now: clock = Date.now,
}) {
  const busy = new Set();
  const lastPostAt = new Map(); // channelId -> ts of the persona's last message
  let onIdle = null; // set via setOnIdle(); see the finally block of runTurn below
  let idleWaiters = []; // resolvers for waitIdle() (/nep pause), notified once busy.size hits 0
  // channelId -> ids of the messages in the history of the last turn that spoke there; for a
  // channel the bot cannot write in, the lines its `<channel_view>` block showed in the last
  // turn that spoke anywhere while showing it (noteSpokeSaw). The pending-ping drain
  // (src/discord/events.js) skips a ping such a turn already had in view.
  const spokeSaw = new Map();

  /** The custom emoji lookup, or null when there is no index or features.customEmoji is off (read now). */
  function emojiLookup() {
    return emoji && hot.config.features?.customEmoji !== false ? emoji.byName : null;
  }

  /** One dry-run mirror message (src/behavior/limits.js#mirrorDryRun), `bot.dryRunChannelId` read now. */
  function mirror(header, body) {
    return mirrorDryRun({ client, dryRunChannelId: hot.config.bot?.dryRunChannelId || '', header, body });
  }

  /**
   * Dry-run stand-in for `act()`: does everything `act()` would have decided
   * to do, but never touches the target channel -- no sendTyping, no send, no
   * react, no artificial timing. Logs one line per would-be action and, when
   * `bot.dryRunChannelId` is configured, mirrors it there in plain language.
   * The same routing as act(): a reaction on a pulled line names its channel
   * (`source`) or is dropped where the bot may not react there, a message, the
   * GIF or the picture answering a pulled line carries its jump link
   * (`linkFor`) and no reply. Like act(), a reaction stamps no `lastPostAt`.
   * The mirror header names the mode, the trigger kind (none on a spontaneous
   * turn), then `react to <name>` for a reaction and `to <name>` for a message
   * that answers a line (a reply or a linked pulled line); nothing more for
   * one that answers none.
   * @param {{ channel: object, parsed: object, idByIndex: Map<number, string>,
   *   mode: string, triggerKind: TriggerKind|null, plain: boolean, selfName: string, pulledIds: Map<string, string>,
   *   lines: object[], linkFor: (pulledId: string|null) => string|null }} args
   *   `plain`: the turn quotes no chat line (postsPlain); `lines`: the lines shown of the pulled
   *   channels, then this chat's history (names and authors).
   */
  async function dryAct({ channel, parsed, idByIndex, mode, triggerKind, plain, selfName, pulledIds, lines, linkFor }) {
    const channelName = channel.name ?? null;
    const where = mirrorChannelLabel(channel);
    // Every triggered turn shares the mode `reply`: the header names its
    // trigger kind (a call, a follow-up, an overheard line...); a spontaneous
    // turn has none.
    const head = `[dry-run] ${where} · ${mode}${triggerKind ? ` · ${triggerKind}` : ''}`;
    const labels = hot.prompts?.labels;

    for (const reaction of parsed.reactions) {
      const targetId = idByIndex.get(reaction.to);
      if (!targetId) continue;
      const route = reactionChannel(channel, targetId, pulledIds);
      if (!route.target) {
        log.info('turn: reaction dropped', { channel: channel.id, source: route.source, reason: route.reason });
        continue;
      }
      const authorName = authorNameFor(lines, targetId) ?? '—';
      // The ONE deliberate exception to "never log message contents": this is
      // the persona's own output, not a user's, and only while dry-run is on.
      log.info('dry-run: would react', { channel: channel.id, channelName, source: route.source, to: targetId, emoji: reaction.emoji });
      const elsewhere = route.source ? ` in ${mirrorChannelLabel(route.target)}` : '';
      await mirror(`${head} · react to ${authorName}`, `reacts with ${reaction.emoji} to ${authorName}${elsewhere}`);
    }

    for (const message of parsed.messages) {
      const { replyId, pulledId } = replyTarget(message.replyTo, { plain, idByIndex, pulledIds });
      const answeredId = replyId ?? pulledId;
      const to = answeredId ? ` · to ${authorNameFor(lines, answeredId) ?? '—'}` : '';
      const link = linkFor(pulledId);
      // Same deliberate exception as above: the persona's own output, dry-run only.
      const text = withLink(renderCustomEmoji(resolveMentions(message.text, lines).text, emojiLookup()), link, labels);
      log.info('dry-run: would send', { channel: channel.id, channelName, mode, trigger: triggerKind ?? null, replyTo: replyId, link, text });
      // The mirror shows @name as the model wrote it: resolving it to a real
      // mention here would ping someone in a channel meant to be invisible to them.
      await mirror(`${head}${to}`, withLink(renderCustomEmoji(message.text, emojiLookup()), link, labels));
      lastPostAt.set(channel.id, clock());
    }

    if (parsed.gif) {
      const { replyId, pulledId } = replyTarget(parsed.gif.replyTo, { plain, idByIndex, pulledIds });
      const link = linkFor(pulledId);
      const { entry } = parsed.gif;
      // The persona's own pick from the library, dry-run only: the handle and the stored URL.
      log.info('dry-run: would send gif', { channel: channel.id, channelName, mode, replyTo: replyId, link, gif: entry.id, kind: entry.kind, url: entry.url });
      await mirror(`${head} · gif ${entry.id}`, withLink(entry.url, link, labels));
      lastPostAt.set(channel.id, clock());
    }

    if (parsed.draw) {
      const self = parsed.draw.self === true;
      const { pulledId } = replyTarget(parsed.draw.replyTo, { plain, idByIndex, pulledIds });
      const link = linkFor(pulledId);
      // The FULL image prompt (prompt files + the persona's request), so the
      // owner can check the prompt files in dry-run. Same deliberate exception:
      // the persona's own output, dry-run only. Nothing is generated.
      const prompt = drawPromptFor(selfName, parsed.draw);
      log.info('dry-run: would draw', { channel: channel.id, channelName, mode, self, link, prompt });
      // A full prompt outgrows one Discord message: mirrored in numbered parts.
      const header = `${head} · draw${self ? ' (self)' : ''}${link ? ` · ${link}` : ''}`;
      const parts = splitForMirror(prompt, MIRROR_MAX_CHARS - header.length - MIRROR_PART_MARK_CHARS);
      for (const [i, part] of parts.entries()) {
        await mirror(parts.length > 1 ? `${header} (${i + 1}/${parts.length})` : header, part);
      }
      lastPostAt.set(channel.id, clock());
    }
  }

  /** The image prompt for `draw` (parsed.draw): prompts read now, the request clamped to image.maxPromptChars. */
  function drawPromptFor(selfName, draw) {
    return buildDrawPrompt({
      prompts: hot.prompts,
      selfName,
      request: clampChars(draw.text, hot.config.image?.maxPromptChars),
      self: draw.self === true,
    });
  }

  /**
   * The limit notice for a refused drawing (src/behavior/limits.js#postLimitNotice,
   * labels and dry-run read now), posted in `channel`, quoting the trigger
   * unless `plain` (a follow-up: never a Discord reply; a routed call: it lives
   * in another channel). Never throws.
   */
  async function notifyLimit(channel, limit, trigger, plain) {
    const posted = await postLimitNotice({
      channel,
      trigger,
      limit,
      asReply: !plain,
      labels: hot.prompts?.labels,
      config: hot.config,
      client,
    });
    if (posted === 'sent') lastPostAt.set(channel.id, clock());
  }

  /**
   * The persona's picture, after its messages: the draw prompt (prompts.draw,
   * read now) with the request clamped to `image.maxPromptChars`, the avatar as
   * reference for a picture the persona is in (`image.reference: 'avatar'`),
   * then one generation and one upload. No typing indicator while it works.
   * Resolves `{ posted: true, pulledId, message }` when posted (`pulledId`: the pulled
   * line it answers, or null; `message`: what channel.send resolved), `{ drawFailed: reason }`
   * otherwise (a generation failure keeps its reason, `empty` counts as
   * `error`; anything else, the upload included, is `error`). A refusal by an
   * image cap (`ImageCapError`) resolves `{}`: the senses line already told the
   * persona; on a turn someone asked for the limit notice tells the
   * requester, an unasked one (spontaneous, overheard: askedFor) stays silent
   * and only logs it. An unasked picture is charged to no member. A picture
   * answering a pulled line (`pulledIds`) posts plain (replyTarget); the link
   * `linkFor` gives it, asked once the picture is ready, is its content. On a
   * turn about another channel (`sourceId`) the trigger, if any, is a call
   * written there: the limit notice is posted here as a plain message, never as
   * a Discord reply across channels. `plain`: the turn quotes no chat line (postsPlain).
   */
  async function draw({ channel, parsed, idByIndex, pulledIds, linkFor, trigger, triggerKind, plain, selfName, sourceId = null }) {
    const config = hot.config;
    const self = parsed.draw.self === true;
    const prompt = drawPromptFor(selfName, parsed.draw);
    const asked = askedFor(trigger, triggerKind);
    try {
      let reference = null;
      if (self && config.image?.reference === 'avatar') {
        reference = await avatarReference({ client, imageFetcher, config });
        if (!reference) log.warn('turn: avatar reference unavailable', { channel: channel.id });
      }

      const picture = await images.generate({ prompt, reference, userId: asked ? (trigger.authorId ?? null) : null });
      const { replyId, pulledId } = replyTarget(parsed.draw.replyTo, { plain, idByIndex, pulledIds });
      const link = linkFor(pulledId);
      const message = await channel.send({
        ...(link ? { content: link } : {}),
        files: [{ attachment: picture.buffer, name: imageFileName(picture.mediaType) }],
        reply: replyId ? { messageReference: replyId, failIfNotExists: false } : undefined,
        allowedMentions: { parse: [] },
      });
      lastPostAt.set(channel.id, clock());
      log.info('turn: drew', {
        channel: channel.id,
        seconds: picture.seconds,
        cost: picture.cost,
        self,
        bytes: picture.buffer?.length ?? 0,
        ...(link ? { link: true } : {}),
      });
      return { posted: true, pulledId, message };
    } catch (err) {
      if (err instanceof ImageCapError) {
        const limit = limitOf(err);
        log.info('turn: draw refused by a limit', {
          channel: channel.id,
          key: limit?.key ?? null,
          used: limit?.used ?? null,
          cap: limit?.cap ?? null,
          spontaneous: !trigger,
          // What decides the notice: an overheard turn has a trigger, yet nobody asked.
          asked,
        });
        if (!asked) return {};
        await notifyLimit(channel, limit, trigger, plain || Boolean(sourceId));
        return {};
      }
      if (err instanceof ImageGenError) {
        return { drawFailed: err.reason === 'empty' ? 'error' : err.reason };
      }
      log.warn('turn: draw error', { channel: channel.id, error: err });
      return { drawFailed: 'error' };
    }
  }

  /** Today's UTC date `YYYY-MM-DD` on the injected clock (the daily GIF counter). */
  function todayDate() {
    return utcDay(clock());
  }

  /** GIFs the persona posted today against `gifs.maxPerDay` (src/memory/gif-watch.js#gifPostsToday); reads only. */
  function gifsToday() {
    return gifPostsToday(store.state.data, hot.config, todayDate());
  }

  /** Count one posted GIF against `gifs.maxPerDay` (the counter restarts on a new UTC day). */
  function countGif() {
    bumpDaily(store.state.data, { dayKey: 'gifDay', countKey: 'gifCount' }, clock());
    store.state.markDirty();
  }

  /**
   * The persona's `<gif>` resolved against the guild's library: `{ id,
   * replyTo, entry }`, or null (logged with its reason, never a URL) when
   * features.gifs is false, the handle is unknown, or `gifs.maxPerDay`
   * (default 40, read now) is spent.
   */
  function resolveGif(guildId, gif, channelId) {
    if (!gif) return null;
    let reason = null;
    let entry = null;
    if (hot.config.features?.gifs === false) reason = 'off';
    else {
      entry = store.findGif(guildId, gif.id);
      const posts = gifsToday();
      if (!entry) reason = 'unknown';
      else if (posts.used >= posts.cap) reason = 'daily';
    }
    if (reason) {
      log.info('turn: gif dropped', { channel: channelId, reason, usedToday: gifsToday().used });
      return null;
    }
    return { ...gif, entry };
  }

  /**
   * A fresh URL of an attached GIF: its original message is fetched again
   * (Discord attachment URLs expire) and the attachment found by id, in the
   * message itself or in a forwarded snapshot. Null when anything fails.
   */
  async function freshAttachmentUrl(channel, entry) {
    if (!entry.messageId) return null;
    try {
      const source = entry.channelId && entry.channelId !== channel.id ? await client.channels.fetch(entry.channelId) : channel;
      const message = await source?.messages?.fetch(entry.messageId);
      const own = message?.attachments?.get?.(entry.itemId);
      if (own?.url) return own.url;
      for (const snapshot of message?.messageSnapshots?.values?.() ?? []) {
        const forwarded = snapshot?.attachments?.get?.(entry.itemId);
        if (forwarded?.url) return forwarded.url;
      }
      return null;
    } catch (err) {
      log.warn('turn: gif refetch failed', { channel: channel.id, gif: entry.id, error: err });
      return null;
    }
  }

  /**
   * Post the persona's GIF (after its messages): a link GIF as its stored
   * URL (Discord embeds tenor/giphy links), an attached one as a fresh URL of
   * its attachment, the stored one when that fails. Counted against
   * `gifs.maxPerDay` once sent. Never throws; resolves what channel.send
   * resolved (an object, `{}` when it resolved nothing) once sent, else null.
   * `replyId`: the chat line it quotes as a Discord reply (replyTarget), or
   * null; `link`: the jump link it carries after its URL (withLink, so the
   * URL comes first and still embeds), or null.
   * @returns {Promise<object|null>}
   */
  async function postGif(channel, gif, replyId, link) {
    const { entry } = gif;
    try {
      const fresh = entry.kind === 'attachment' ? await freshAttachmentUrl(channel, entry) : null;
      const message = await channel.send({
        content: withLink(fresh ?? entry.url, link, hot.prompts?.labels),
        reply: replyId ? { messageReference: replyId, failIfNotExists: false } : undefined,
        allowedMentions: { parse: [] },
      });
      countGif();
      lastPostAt.set(channel.id, clock());
      log.info('turn: gif sent', { channel: channel.id, gif: entry.id, kind: entry.kind, fresh: Boolean(fresh), ...(link ? { link: true } : {}) });
      return message ?? {};
    } catch (err) {
      log.warn('turn: gif failed', { channel: channel.id, gif: entry.id, error: err });
      return null;
    }
  }

  /**
   * Record one message the persona posted in the post ledger (`state.json`
   * `postLedger`, appendPostLedger, capped at postLedgerSize): `post` (the
   * turn's mode, trigger kind and id, the newest line of its history, its
   * source channel) with the posted message's id and the time. Only with
   * features.mentor true (read now, like the size), never while paused (the
   * owner may be editing data/), never without a message id; marks the state
   * dirty. The mentor reads it to replay a moment as the turn it was.
   */
  function recordPost(sent, post) {
    if (hot.config.features?.mentor !== true) return;
    const data = store.state.data;
    const messageId = sent?.id;
    if (data.paused || typeof messageId !== 'string' || !messageId) return;
    data.postLedger = appendPostLedger(data.postLedger, { messageId, ...post, at: clock() }, postLedgerSize(hot.config));
    store.state.markDirty();
  }

  /**
   * Start the variety pass for the next turn (src/behavior/variety-pass.js#ahead)
   * once this turn's text is out: on this turn's history plus the `posted`
   * lines, cut to what the next fetchHistory returns (the last
   * `context.channelMessages`, read now, at most one page), so the next turn's
   * own lines carry the same ids and find the answer ready. Nothing when the
   * pass has no `ahead` or nothing was posted. Never awaited, never throws
   * into the turn.
   */
  function startAhead({ guildId, channelId, history, posted, selfName, privateChat }) {
    if (typeof variety?.ahead !== 'function' || posted.length === 0) return;
    const failed = (err) => log.warn('turn: variety ahead failed', { channel: channelId, error: err });
    try {
      const cap = Math.min(HISTORY_PAGE, hot.config.context?.channelMessages);
      const all = [...history, ...posted];
      const seen = Number.isFinite(cap) && cap > 0 ? all.slice(-cap) : all;
      Promise.resolve(variety.ahead({ guildId, channelId, history: seen, selfName, privateChat })).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  /**
   * Post the turn for real. Resolves `{ delivered, answered }` -- whether
   * anything reached the chat (a reaction put, a message, the GIF or the
   * picture posted; a limit notice is not the persona's answer), and the ids
   * of the pulled lines what reached it answered (a reaction put on one, a
   * message, the GIF or the picture posted answering one: stampShownCalls) --
   * plus `drawFailed` from draw() when the persona's picture could not be
   * posted. Once the text
   * messages are out (before the GIF and the picture), the variety pass for
   * the next turn starts ahead (startAhead) on this chat's history.
   *
   * Everything is posted in `channel`. A reaction on a pulled line
   * (`pulledIds`) is put in that line's channel when the bot may react there,
   * else dropped (`turn: reaction dropped`); a message, the GIF or the picture
   * answering a pulled line posts plain, never as a Discord reply across
   * channels, and each post carries the jump link `linkFor` gives it (a message
   * and the GIF through `labels.elsewhere.link`, read now; the picture as its
   * content). `@name` resolves over `lines`. Every message is cut to fit one
   * Discord message once its mentions and custom emoji are expanded (withLink).
   *
   * A message whose send fails ends the posting: `turn: send failed`
   * (`channel`, `index` -- 0-based among the turn's messages --, `error`), no
   * later message, GIF or picture, and the turn resolves what reached the chat
   * before it (the pass ahead starts on those lines).
   *
   * In a server channel every posted message, GIF and picture is recorded in
   * the post ledger (recordPost) with `mode`, the trigger, the newest line of
   * `history` and `sourceId`.
   * @param {{ channel: object, guildId: string, privateChat: boolean, parsed: object,
   *   idByIndex: Map<number, string>, history: object[], startedAt: number, mode: string,
   *   triggerKind: TriggerKind|null, plain: boolean, trigger: object|null, selfName: string,
   *   pulledIds: Map<string, string>, lines: object[], linkFor: (pulledId: string|null) => string|null,
   *   sourceId: string|null }} args
   *   `plain`: the turn quotes no chat line (postsPlain); `lines`: the lines shown of the
   *   pulled channels, then `history` (a chat author wins a display name both share);
   *   `sourceId`: the channel the turn is about (its `source`), logged on every message sent;
   *   with it a refused drawing's limit notice quotes nothing (the trigger of a routed turn
   *   lives in that channel).
   */
  async function act({ channel, guildId, privateChat, parsed, idByIndex, history, startedAt, mode, triggerKind, plain, trigger, selfName, pulledIds, lines, linkFor, sourceId }) {
    const cfg = hot.config.typing;
    const typingOn = hot.config.features?.typingSimulation !== false;
    // Whether anything reached the chat (the caller of a routed turn marks its call by it), and
    // the pulled lines it answered (the ring of calls marks them by it).
    let delivered = false;
    const answered = new Set();
    // What the post ledger records of each post of this turn (server channels only).
    const ledgerPost = privateChat
      ? null
      : {
          channelId: channel.id,
          mode,
          triggerKind: triggerKind ?? null,
          triggerId: trigger?.id ?? null,
          newestHistoryId: history.at(-1)?.id ?? null,
          sourceChannelId: sourceId ?? null,
        };
    const record = (sent) => {
      if (ledgerPost) recordPost(sent, ledgerPost);
    };

    for (const reaction of parsed.reactions) {
      const targetId = idByIndex.get(reaction.to);
      if (!targetId) continue;
      const route = reactionChannel(channel, targetId, pulledIds);
      if (!route.target) {
        log.info('turn: reaction dropped', { channel: channel.id, source: route.source, reason: route.reason });
        continue;
      }
      if (typingOn) await sleep(between(cfg.reactionDelayMs, rng));
      try {
        const target = await route.target.messages.fetch(targetId);
        await target.react(reaction.emoji);
        delivered = true;
        if (route.source) answered.add(targetId);
      } catch (err) {
        log.warn('turn: reaction failed', { channel: channel.id, ...(route.source ? { source: route.source } : {}), emoji: reaction.emoji, error: err });
      }
    }

    // Each posted message as the next fetchHistory will normalize it (its own id and time, the
    // persona's text as written): the lines the pass ahead looks at.
    const ownPosted = [];
    let sendFailed = false;
    for (const [index, message] of parsed.messages.entries()) {
      if (index > 0 && typingOn) await sleep(between(cfg.betweenMessagesMs, rng));

      const { replyId, pulledId } = replyTarget(message.replyTo, { plain, idByIndex, pulledIds });
      const link = linkFor(pulledId);
      const mentioned = resolveMentions(message.text, lines);
      const { userIds } = mentioned;
      // Custom emoji after the mentions: `<@id>` has no `:name:` in it to break.
      const spoken = renderCustomEmoji(mentioned.text, emojiLookup());
      const text = withLink(spoken, link, hot.prompts?.labels);
      if (typingOn) {
        // Only the indicator: a missing Send Messages shows up here first, so it is logged.
        await channel.sendTyping().catch((err) => log.warn('turn: typing failed', { channel: channel.id, error: err }));
        await sleep(typingMs(spoken, cfg, rng));
      }

      let posted;
      try {
        posted = await channel.send({
          content: text,
          reply: replyId ? { messageReference: replyId, failIfNotExists: false } : undefined,
          allowedMentions: { parse: [], users: userIds, repliedUser: true },
        });
      } catch (err) {
        log.warn('turn: send failed', { channel: channel.id, index, error: err });
        sendFailed = true;
        break;
      }
      delivered = true;
      if (pulledId) answered.add(pulledId);
      lastPostAt.set(channel.id, clock());
      record(posted);
      ownPosted.push({
        id: posted?.id ?? null,
        ts: Number.isFinite(posted?.createdTimestamp) ? posted.createdTimestamp : clock(),
        channelId: channel.id,
        self: true,
        content: message.text,
        replyToId: replyId,
      });
      // The ring of own lines the variety pass reads for the other channels: server channels only,
      // the persona's text as it wrote it, with what it answered (the line it answered, here or
      // in a pulled channel, else the trigger).
      if (variety && channel.guild) {
        const answeredId = replyId ?? pulledId;
        const answeredLine = answeredId ? lines.find((m) => m.id === answeredId) : trigger;
        variety.record(channel.guild.id, {
          id: posted?.id ?? null,
          ts: clock(),
          channelId: channel.id,
          text: message.text,
          to: typeof answeredLine?.content === 'string' ? answeredLine.content : undefined,
        });
      }
      log.info('turn: sent', {
        channel: channel.id,
        chars: text.length,
        secondsSinceTrigger: Math.round((clock() - startedAt) / 100) / 10,
        ...(triggerKind === 'followUp' ? { followUp: true } : {}),
        ...(triggerKind === 'overheard' ? { overheard: true } : {}),
        ...(sourceId ? { source: sourceId } : {}),
        ...(link ? { link: true } : {}),
      });
    }
    startAhead({ guildId, channelId: channel.id, history, posted: ownPosted, selfName, privateChat });
    if (sendFailed) return { delivered, answered };

    // The GIF right after the messages.
    if (parsed.gif) {
      if (parsed.messages.length > 0 && typingOn) await sleep(between(cfg.betweenMessagesMs, rng));
      const { replyId, pulledId } = replyTarget(parsed.gif.replyTo, { plain, idByIndex, pulledIds });
      const sent = await postGif(channel, parsed.gif, replyId, linkFor(pulledId));
      if (sent) {
        delivered = true;
        if (pulledId) answered.add(pulledId);
        record(sent);
      }
    }

    // The picture comes last, once every message is out.
    if (!parsed.draw) return { delivered, answered };
    const drawn = await draw({ channel, parsed, idByIndex, pulledIds, linkFor, trigger, triggerKind, plain, selfName, sourceId });
    if (drawn.posted === true) {
      if (drawn.pulledId) answered.add(drawn.pulledId);
      record(drawn.message);
    }
    return { delivered: delivered || drawn.posted === true, answered, ...(drawn.drawFailed ? { drawFailed: drawn.drawFailed } : {}) };
  }

  /**
   * The `<transcript>` block of a classifier request (re-watch, search): the
   * last `contextMessages` messages of `history` before the trigger, rendered
   * like the address classifier's context (src/discord/events.js) with the
   * media states this turn already has, plus the trigger's text cut to
   * `context.maxMessageChars`. `transcriptBlock` is '' (no block) for a
   * window of 0 or no earlier message.
   * @returns {{ triggerText: string, transcriptBlock: string }}
   */
  function classifierContext({ config, selfName, history, trigger, contextMessages, descriptions, videos, reads }) {
    const triggerText = [...String(trigger.content ?? '')].slice(0, config.context?.maxMessageChars ?? 800).join('');
    const context = contextMessages > 0 ? history.filter((m) => m.id !== trigger.id).slice(-contextMessages) : [];
    if (context.length === 0) return { triggerText, transcriptBlock: '' };
    const labels = hot.prompts.labels;
    const items = formatTranscript(context, {
      timezone: config.bot.timezone,
      gapMinutes: config.context.gapMarkerMinutes,
      maxChars: config.context.maxMessageChars,
      selfName,
      labels,
      seeReactions: config.features?.seeReactions !== false,
      reactionsPerMessage: config.context.reactionsPerMessage,
      descriptions,
      videos,
      reads,
    });
    return { triggerText, transcriptBlock: `<transcript>\n${renderTranscript(items, config.bot.timezone, labels)}\n</transcript>\n` };
  }

  /**
   * The re-watch on a question (features.videoRewatch): when the trigger
   * asks about a video watched in the last `media.video.rewatch.recentMessages`
   * messages (at most `media.video.rewatch.maxCandidates` of them, newest
   * first), one cheap classifier call (prompts.rewatch, on the classifier
   * model: classifierTextModel -- `classifier.text`, else the media model; its answer capped at
   * `media.video.rewatch.classifierMaxOutputTokens`) picks the video and
   * the question, then the describer looks at it again
   * (describer.rewatchVideo) and the answer joins that video's state as
   * `answer: { question, text }` -- mutating `videos` in place. Videos that
   * did not load (`error` state) are candidates too whenever the describer
   * can fetch one (describer.describeVideo): the classifier's `<n> | retry`
   * watches one again with `force` and its new state replaces the old one.
   * The explicit request has its own slot, apart from the
   * `media.video.maxPerTurn` new videos this turn already fetched; the
   * describer's daily caps still apply. At most one re-watch or retry per
   * turn. The `<videos>` lines are numbered 1.. newest first and the
   * classifier answers with that ordinal, mapped back here. A `<transcript>` block before
   * `<videos>` carries the last `media.video.rewatch.contextMessages` messages before the
   * trigger (0 omits it), with the video states and captions this turn already has. Never throws: any failure leaves
   * `videos` as it was. The question and the answer are data: never logged;
   * every early stop logs `rewatch: skipped` with its reason. The classifier is
   * not asked when its answer could not run (`reason: 'cap'`): the describer's
   * `videoCapsLeft()` (when it has one; read only) says no video slot is left
   * today, or no re-watch slot is left and no failed video can be retried --
   * with only the re-watch slots spent, only the videos that did not load are
   * offered. The classifier's request is a helper's (helperRequestOptions).
   */
  async function maybeRewatch({ config, guildId, channelId, selfName, history, trigger, videos, descriptions, candidates }) {
    const prompt = hot.prompts?.rewatch;
    if (!prompt) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-prompt' });
      return;
    }
    // A retry requested by the person has its own slot, outside media.video.maxPerTurn.
    const canRetry = typeof describer.describeVideo === 'function';
    // Today's slots, when the describer can tell: both a second look and a retry take a video slot.
    const slots = typeof describer.videoCapsLeft === 'function' ? describer.videoCapsLeft() : null;
    const questionsOn = !slots || slots.rewatch > 0;
    if (slots && (!(slots.video > 0) || (!questionsOn && !canRetry))) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'cap' });
      return;
    }
    const system = fillPromptTemplate(prompt, { name: selfName ?? '' });
    const mediaCfg = config.media ?? {};
    const rewatchCfg = mediaCfg.video?.rewatch ?? {};
    const recent = Math.max(0, Math.floor(rewatchCfg.recentMessages ?? 60));
    if (recent === 0) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-window' });
      return;
    }
    // `candidates` is already newest first, so the cap keeps the newest videos.
    const maxCandidates = Math.max(1, Math.floor(rewatchCfg.maxCandidates ?? 6));
    const recentIds = new Set(history.slice(-recent).map((m) => m.id));
    const seen = new Set();
    const watched = [];
    for (const item of candidates) {
      if (watched.length >= maxCandidates) break;
      if (seen.has(item.itemId) || !recentIds.has(item.messageId)) continue;
      const state = videos.get(item.itemId)?.state;
      if (!(state === 'watched' && questionsOn) && !(state === 'error' && canRetry)) continue;
      seen.add(item.itemId);
      watched.push(item);
    }
    if (watched.length === 0) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-watched', watched: 0, recent });
      return;
    }

    const lines = watched.map((item, index) => {
      const video = videos.get(item.itemId);
      const status = video.state === 'watched' ? REWATCH_STATUS_WATCHED : REWATCH_STATUS_NOT_LOADED;
      const summary = video.state === 'watched' ? [...oneLine(video.text)].slice(0, REWATCH_SUMMARY_CHARS).join('') : '';
      return `${index + 1} | ${oneLine(item.name)} | ${status} | ${summary}`.trimEnd();
    });
    // The chat around the question.
    const { triggerText, transcriptBlock } = classifierContext({
      config,
      selfName,
      history,
      trigger,
      contextMessages: Math.max(0, Math.floor(rewatchCfg.contextMessages ?? 50)),
      descriptions,
      videos,
    });
    const user = `${transcriptBlock}<videos>\n${lines.join('\n')}\n</videos>\n<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`;

    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        {
          model: classifierTextModel(config),
          ...helperRequestOptions(config, { role: 'classifier.text', maxOutputTokens: rewatchCfg.classifierMaxOutputTokens ?? 120, purpose: 'rewatch' }),
        },
      );
    } catch (err) {
      log.warn('rewatch: classifier failed', { channel: channelId, status: err.statusCode ?? null, name: err.name });
      return;
    }
    const { pick, reason } = parseRewatchPickDetailed(completion.text, watched.length);
    const item = pick ? watched[pick.n - 1] : null;
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
   * Whether the server search (`recall`) could run now: wired, and its
   * `available()` (the switch, its prompt, the daily caps; read only) says
   * yes. A throw counts as no.
   */
  function recallAvailable() {
    if (typeof recall?.available !== 'function' || typeof recall.run !== 'function') return false;
    try {
      return recall.available() === true;
    } catch {
      return false;
    }
  }

  /**
   * `work()` as a promise that never rejects: a throw or a rejection logs
   * `lookup: failed` with the `part` it was (`web` / `server`) and gives null.
   */
  function settleLookupPart(work, channelId, part) {
    return Promise.resolve()
      .then(work)
      .catch((err) => {
        log.warn('lookup: failed', { channel: channelId, part, error: err });
        return null;
      });
  }

  /**
   * The searches on a question: the web search (`webOn`: features.webLookup,
   * web.search.enabled, a lookup with `search`) and the search of the
   * server's own history (`serverOn`: recall wired and available, a server
   * turn). One cheap classifier call (prompts.lookup, `{{name}}` = the
   * persona's display name, `{{today}}` = the injected clock's UTC date
   * `YYYY-MM-DD`, on classifierTextModel, its answer capped at
   * `web.search.classifierMaxOutputTokens`) reads the last
   * `web.search.contextMessages` messages of `history` before the trigger
   * (with the pictures' captions, the video states and the read links this
   * turn already has; on a routed turn the caller passes the source
   * channel's lines, where the call was written) and the trigger itself, and
   * answers `none` or labelled lines (src/behavior/recall.js#parseLookupAnswer,
   * `when:` read in `bot.timezone`, forms capped at `recall.maxForms`).
   * The web side runs only under its own gates: `web.search.maxPerTurn`
   * below 1 (`no-slot`), no search key (`no-key`), its daily slots spent
   * (`cap`: the lookup's `webCapLeft()`, when it has one; read only); the
   * classifier is not asked when neither side can run (`lookup: skipped`
   * with the web side's reason, or `no-prompt` without prompts.lookup). Then
   * what the answer asks for runs in parallel: a `web` query goes to
   * lookup.search (at most one per turn), a `server` part to `recall.run`
   * (`history` = `chatHistory`, the turn's own chat; `candidate` = the
   * trigger); a part the answer asks for whose side cannot run is not run,
   * and a failing part logs `lookup: failed` and counts as nothing. Resolves
   * the `lookup` input of the request (see createTurnRunner) or null. The
   * query, the forms and the transcript are data: never logged (`lookup:
   * classified` carries codes and counts only); an empty or blank answer is
   * a failed call (`lookup: classifier failed`, `reason: 'empty'`), no
   * search. Its request is a helper's (helperRequestOptions).
   */
  async function maybeLookup({ config, guildId, channel, selfId, selfName, history, chatHistory, trigger, descriptions, videos, reads, webOn, serverOn }) {
    const channelId = channel.id;
    const prompt = hot.prompts?.lookup;
    const searchCfg = config.web?.search ?? {};
    let webSkip = null;
    if (webOn) {
      if ((searchCfg.maxPerTurn ?? 1) < 1) webSkip = 'no-slot';
      else if (typeof lookup.hasSearch === 'function' && !lookup.hasSearch()) webSkip = 'no-key';
      else if (typeof lookup.webCapLeft === 'function' && !(lookup.webCapLeft() > 0)) webSkip = 'cap';
    }
    const webCan = webOn && webSkip === null;
    let skip = null;
    if (!prompt) skip = 'no-prompt';
    else if (!webCan && !serverOn) skip = webSkip ?? 'no-search';
    if (skip) {
      log.info('lookup: skipped', { channel: channelId, reason: skip });
      return null;
    }

    // The chat around the question, with the pages this turn already read.
    const { triggerText, transcriptBlock } = classifierContext({
      config,
      selfName,
      history,
      trigger,
      contextMessages: Math.max(0, Math.floor(searchCfg.contextMessages ?? 50)),
      descriptions,
      videos,
      reads,
    });
    const user = `${transcriptBlock}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`;

    // Read once: the request and its empty-answer warning name the same model.
    const model = classifierTextModel(config);
    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(prompt, { today: todayDate(), name: selfName ?? '' }) },
          { role: 'user', content: user },
        ],
        { model, ...helperRequestOptions(config, { role: 'classifier.text', maxOutputTokens: searchCfg.classifierMaxOutputTokens ?? 200, purpose: 'lookup' }) },
      );
    } catch (err) {
      log.warn('lookup: classifier failed', { channel: channelId, status: err.statusCode ?? null, name: err.name });
      return null;
    }
    if (!String(completion.text ?? '').trim()) {
      // Nothing at all (typically a reasoning model that spent its whole
      // output cap thinking) is a failed call, not a silent "none".
      log.warn('lookup: classifier failed', { channel: channelId, reason: 'empty', model: model ?? null });
      return null;
    }
    const parsed = parseLookupAnswer(completion.text, { timezone: config.bot?.timezone, now: clock(), maxForms: recallSettings(config)?.maxForms });
    const server = parsed.server;
    // Codes and counts only, never the query, a form or a name.
    log.info('lookup: classified', {
      channel: channelId,
      picked: Boolean(parsed.web || server),
      parse: parsed.reason,
      web: Boolean(parsed.web),
      server: Boolean(server),
      forms: server?.forms.length ?? 0,
      who: server?.who.length ?? 0,
      ranged: Boolean(server && (server.from !== null || server.to !== null)),
    });
    const runWeb = webCan && Boolean(parsed.web);
    const runServer = serverOn && Boolean(server);
    if (!runWeb && !runServer) return null;
    const [webResult, found] = await Promise.all([
      runWeb ? settleLookupPart(() => lookup.search(guildId, parsed.web), channelId, 'web') : null,
      runServer
        ? settleLookupPart(
            () => recall.run({ guild: channel.guild, guildId, channel, selfId, selfName, history: chatHistory, candidate: trigger, server }),
            channelId,
            'server',
          )
        : null,
    ]);
    // A server search that found nothing leaves no server part.
    const serverPart =
      found && (found.text || found.stretch)
        ? { text: found.text ?? null, stretch: found.stretch ?? null, people: Array.isArray(found.people) ? found.people : [] }
        : null;
    if (!serverPart) return webResult ?? null;
    return { ...(webResult ?? {}), server: serverPart };
  }

  /**
   * fetchPull (src/discord/pull-fetch.js) that never throws: an unexpected
   * failure is logged (`pull: failed`) and counts as a skip with code `error`.
   */
  async function pullSafely(args) {
    try {
      return await fetchPull(args);
    } catch (err) {
      log.warn('pull: failed', { channel: args.destination?.id ?? null, source: args.channelId, pullReason: args.reason, error: err });
      return { pulled: null, skip: 'error' };
    }
  }

  /** The route hook's channel ids (non-empty strings); a throw (`pull: route failed`) or a non-array answer is []. */
  async function routeIds(args) {
    try {
      const ids = await routeChannels(args);
      return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id !== '') : [];
    } catch (err) {
      log.warn('pull: route failed', { channel: args.channel.id, error: err });
      return [];
    }
  }

  /**
   * The input of a turn's `<recent>` block (src/behavior/prompt.js#buildRequest
   * `recentLines` / `recentAudience`): the guild's recent lines inside the last
   * `memory.recentHours` (src/memory/store.js#getRecent, read now) and which
   * source channels this turn may show them from. On a server turn: the
   * channel the turn posts in, and every channel whose audience covers it
   * (src/discord/collect.js#audienceOf, src/behavior/elsewhere.js#audienceCovers:
   * everyone who can read this channel can read that one). In a private chat:
   * the channels every member of the served guild can read. A channel the
   * guild does not hold is never covered. No live line: an empty list (the
   * block may still show the members' moments of those hours). Nothing
   * (`lines` undefined: no block at all) with features.recent off (a missing
   * key counts as on) or for a store without the recent store (tests' fakes);
   * a read that throws is logged (`recent: failed`) and is nothing either: the
   * block is never worth a turn.
   * @returns {{ lines: object[]|undefined, audience: ((channelId: string|null) => boolean)|undefined }}
   */
  function recentInput({ channel, guildId, isPrivate, config, now }) {
    const settings = recentSettings(config);
    if (!settings || typeof store.getRecent !== 'function') return NO_RECENT;
    try {
      const lines = liveRecent(store.getRecent(guildId)?.lines, { now, hours: settings.hours });
      if (lines.length === 0) return { lines, audience: undefined };
      const guild = isPrivate ? (client.guilds?.cache?.get?.(guildId) ?? null) : channel.guild;
      const here = isPrivate ? everyMemberAudience() : audienceOf(channel);
      const allowed = new Set();
      for (const id of new Set(lines.map((line) => line.channelId))) {
        if (typeof id !== 'string' || !id) continue;
        if (!isPrivate && id === channel.id) allowed.add(id);
        else if (audienceCovers(here, audienceOf(guild?.channels?.cache?.get?.(id) ?? null))) allowed.add(id);
      }
      return { lines, audience: (channelId) => allowed.has(channelId) };
    } catch (err) {
      log.warn('recent: failed', { channel: channel.id, error: err });
      return NO_RECENT;
    }
  }

  /**
   * The other channels a server turn shows in `<channel_view>`, each fetched
   * by fetchPull, in the order of src/behavior/pull.js#pullTargets: the
   * turn's `source` first and alone -- a turn about it does not go on
   * without it, so nothing else is fetched when it fails -- then the explicit
   * `<#id>` mentions of the trigger and of the last `context.pull.scanMessages`
   * messages, then the route hook's ids (routeIds; asked only with
   * features.channelPull on, not on a drawFailed turn, and while a slot is
   * left; on a routed turn it reads the source's lines), at most
   * `context.pull.maxChannels` in all. features.channelPull off: the source
   * alone. Without `labelled` (no `labels.pull.header`: buildRequest renders
   * no `<channel_view>`) the source alone too, with no fresh caption, and one
   * `pull: skipped` (`reason: 'no-label'`) when the turn had a source, a
   * mention or a route hook to ask. Every candidate is judged once, without a
   * request, by the rails fetchPull checks first (checkPull); a refused one
   * logs `pull: skipped` (`channel`, `source` = its id, `reason` = the skip
   * code, `pullReason` = `mention` or `route`), one whose check throws logs
   * `pull: failed` and is not pulled. Every pull reads the ring of calls
   * (`state.json` `elsewherePings`) for its ping marks. Fresh captions only
   * with `certain` (no chooser can still end the turn as not-now), never on a
   * drawFailed turn. Settings come from `config`, the turn's live config.
   * @returns {Promise<{ pulled: object[], sourceSkip: string|null }>}  The PulledChannel records,
   *   source first; `sourceSkip` is the skip code of a source that could not be pulled.
   */
  async function pullChannels({ channel, guildId, history, trigger, triggerKind = null, source, selfId, selfName, config, now, certain, drawFailure, labelled }) {
    const guild = channel.guild;
    const settings = pullSettings(config);
    const channelPull = channelPullOn(config) && labelled;
    // Every candidate judged once: its skip code (null = pullable) and why it was a candidate.
    const judged = new Map();
    let judging = 'mention';
    const judge = (id) => {
      try {
        return checkPull({ guild, channelId: id, destination: channel, config, now }).skip;
      } catch (err) {
        log.warn('pull: failed', { channel: channel.id, source: id, pullReason: judging, error: err });
        return 'error';
      }
    };
    const isPullable = (id) => {
      if (!judged.has(id)) judged.set(id, { skip: judge(id), pullReason: judging });
      return judged.get(id).skip === null;
    };
    const targetsWith = (extra, { pullable = isPullable, more = channelPull } = {}) =>
      pullTargets({
        source,
        history,
        trigger,
        extra,
        currentChannelId: channel.id,
        scanMessages: settings.scanMessages,
        maxChannels: settings.maxChannels,
        isPullable: pullable,
        channelPull: more,
      });
    const logRefused = () => {
      for (const [id, { skip, pullReason }] of judged) {
        // A check that threw was logged as `pull: failed` already.
        if (skip && skip !== 'error') log.info('pull: skipped', { channel: channel.id, source: id, reason: skip, pullReason });
      }
    };
    if (!labelled) {
      // What the turn would have pulled with the label (unjudged: no check is wasted on it).
      const wanted = targetsWith([], { pullable: () => true, more: channelPullOn(config) });
      const hookWanted = typeof routeChannels === 'function' && channelPullOn(config) && !drawFailure && wanted.length < settings.maxChannels;
      if (wanted.length > 0 || hookWanted) log.info('pull: skipped', { channel: channel.id, reason: 'no-label' });
    }
    const pings = store.state.data.elsewherePings ?? [];
    const pullOne = (target) =>
      pullSafely({
        guild,
        guildId,
        channelId: target.channelId,
        destination: channel,
        reason: target.reason,
        trigger: target.reason === 'routed' ? trigger : null,
        pings,
        config,
        selfId,
        now,
        describer: describer ?? null,
        turnCertain: certain && !drawFailure && labelled,
      });

    let targets = targetsWith([]);
    const sourceTarget = source ? (targets.find((target) => target.channelId === source.channelId) ?? null) : null;
    let sourcePulled = null;
    if (sourceTarget) {
      const result = await pullOne(sourceTarget);
      if (!result.pulled) {
        logRefused();
        return { pulled: [], sourceSkip: result.skip };
      }
      sourcePulled = result.pulled;
    }
    if (typeof routeChannels === 'function' && channelPull && !drawFailure && targets.length < settings.maxChannels) {
      const routedLines = source?.reason === 'routed' ? sourcePulled?.messages : null;
      const ids = await routeIds({ guildId, channel, history: routedLines ?? history, trigger, triggerKind, selfName, config });
      judging = 'route';
      if (ids.length > 0) targets = targetsWith(ids);
    }
    const fetched = await Promise.all(targets.filter((target) => target.channelId !== sourceTarget?.channelId).map(pullOne));
    logRefused();
    return { pulled: [sourcePulled, ...fetched.map((result) => result.pulled)].filter(Boolean), sourceSkip: null };
  }

  /**
   * Fresh captions (src/discord/pull-fetch.js#captionPulled) for channels
   * pulled before a chooser, once the turn is certain to run; only with
   * features.mediaDescriptions on and a describer. Never rejects: a channel
   * whose captions fail keeps the cached ones (`pull: captions failed`).
   */
  function captionAll(pulled, { guildId, config, destination }) {
    if (pulled.length === 0 || config.features?.mediaDescriptions !== true || !describer) return Promise.resolve(pulled);
    return Promise.all(
      pulled.map((entry) =>
        captionPulled(entry, { describer, guildId, config, destination }).catch((err) => {
          log.warn('pull: captions failed', { channel: destination.id, source: entry.channelId, error: err });
          return entry;
        }),
      ),
    );
  }

  /**
   * Move the seen mark of each pulled channel whose block the request showed
   * (buildRequest's `pulledKept`) to the newest line shown, in `state.json`
   * `elsewhereSeen` (src/behavior/elsewhere.js#markSeen: never backwards). The
   * caller marks the state dirty.
   * @param {{ channelId: string, newestTs: number }[]} shown
   */
  function markPulledSeen(shown) {
    if (shown.length === 0) return;
    let seen = store.state.data.elsewhereSeen;
    for (const { channelId, newestTs } of shown) seen = markSeen(seen, channelId, newestTs);
    store.state.data.elsewhereSeen = seen;
  }

  /**
   * What a turn that spoke had in view (spokeAfterSeeing): this channel's
   * history under this channel, and the lines shown of each pulled channel
   * the bot cannot write in under that channel -- a call there is answered
   * here, so one queued meanwhile and already shown is not answered twice. A
   * pulled channel the bot can write in keeps its own record: a call written
   * there is answered there, not by being shown here.
   * @param {object} channel
   * @param {object[]} history
   * @param {{ channelId: string, ids: string[] }[]} shown  buildRequest's `pulledKept`.
   * @param {object[]} pulled  The PulledChannel records (their `readOnly`).
   */
  function noteSpokeSaw(channel, history, shown, pulled) {
    spokeSaw.set(channel.id, new Set(history.map((m) => m.id)));
    const readOnly = readOnlyIdsOf(pulled);
    for (const { channelId, ids } of shown) {
      if (readOnly.has(channelId)) spokeSaw.set(channelId, new Set(ids));
    }
  }

  /** The ids of the pulled channels (PulledChannel records) the bot cannot write in. */
  function readOnlyIdsOf(pulled) {
    return new Set(pulled.filter((entry) => entry.readOnly === true).map((entry) => entry.channelId));
  }

  /**
   * The ring of calls (`state.json` `elsewherePings`, read by every later
   * pull) after a turn that reached a decision -- it chose silence, or it
   * spoke for real (a dry run that spoke reached nobody and stamps nothing):
   * every call of the ring among the lines it showed of a channel the bot
   * cannot write in (buildRequest's `pulledKept`) is stamped answered when
   * what reached the chat answered it (`answered`, from act), else skipped --
   * it was in view, so no later pull presents it as waiting for an answer
   * (src/behavior/elsewhere.js#stampPings: an answer wins over a skip, a stamp
   * never moves). A pulled channel the bot can write in is left alone (a call
   * there is answered there), and so is `exceptId`: a routed turn's own call,
   * which its caller (src/discord/events.js) stamps by the turn's outcome.
   * Nothing changes while paused (the owner may be editing data/). Each call
   * whose state changed logs `elsewhere: marked`; the state is marked dirty
   * once.
   * @param {{ shown: { channelId: string, ids: string[] }[], pulled: object[], answered: Set<string>,
   *   exceptId: string|null }} args
   */
  function stampShownCalls({ shown, pulled, answered, exceptId }) {
    const readOnly = readOnlyIdsOf(pulled);
    const stamps = shown
      .filter(({ channelId }) => readOnly.has(channelId))
      .flatMap(({ ids }) => ids.filter((id) => id !== exceptId).map((id) => ({ messageId: id, status: answered.has(id) ? 'answered' : 'skipped' })));
    const data = store.state.data;
    if (stamps.length === 0 || data.paused || !Array.isArray(data.elsewherePings)) return;
    const { ring, marked } = stampPings(data.elsewherePings, stamps, clock());
    if (marked.length === 0) return;
    data.elsewherePings = ring;
    store.state.markDirty();
    for (const { messageId, channelId, status } of marked) log.info('elsewhere: marked', { source: channelId, message: messageId, status });
  }

  /**
   * @param {object} params
   * @param {import('discord.js').TextBasedChannel} params.channel
   * @param {string} [params.guildId]  The served guild, used when `channel` has no guild (a
   *   private chat); a server channel always uses its own guild. Neither -> throws.
   * @param {'reply'|'interject'|'initiate'|'auto'} params.mode  'auto' lets `chooseMode` pick
   *   between interject/initiate/nothing once the history is known (spontaneous turns).
   * @param {object} [params.trigger]      Normalized message the turn answers (a call, or an
   *   overheard line).
   * @param {TriggerKind} [params.triggerKind]
   * @param {(history: object[], now: number, context: { pulled: object[] }) => string|null} [params.chooseMode]
   *   Called with this channel's history and the channels already pulled for the turn (the
   *   PulledChannel records of src/discord/pull-fetch.js, the source first).
   * @param {{ channelId: string, reason: 'routed'|'noticed' }|null} [params.source]  The channel
   *   this turn is about when it is not `channel` (a call from a channel the bot cannot write in,
   *   a noticed comment): pulled before anything else and shown in `<channel_view>`. When it
   *   cannot be pulled a routed turn ends in `error` (`turn: source unavailable`), a noticed one
   *   in `not-now`. `channel` is where the words go and the one marked busy; the first post
   *   links to the routed call, or to the newest line of the source shown (none when the budget
   *   dropped its block). The drawFailed turn after a failed picture keeps it.
   * @param {object|null} [params.focus]  A normalized message of this chat put to everyone present
   *   (a room question): buildRequest appends `labels.room.focus` to the task.
   * @param {boolean} [params.forced]  True for an owner-forced turn (`/nep interject`, `/nep
   *   initiate`) -- passed straight through to buildRequest, which appends prompts.forced (when
   *   present) to the task text so the model knows `<skip/>` is not the expected outcome this time.
   * @returns {Promise<{ outcome: TurnOutcome, mode?: string, dryRun?: boolean, drawFailed?: string,
   *   delivered?: boolean, limit?: { key: string, used: number, cap: number }|null }>}
   *   `drawFailed` (the reason) when the persona's picture could not be posted; `delivered` on a
   *   `spoke` turn posted for real: whether anything reached the chat (a reaction put, a message,
   *   the GIF or the picture posted -- by the drawFailed turn too; a send that fails stops the
   *   posting and the turn still ends `spoke` with what reached the chat); `limit` on `outcome:
   *   'refused'` (a request or token cap), for the caller's limit notice. A `skip`, or a `spoke`
   *   turn posted for real, stamps the calls of the ring it showed (stampShownCalls) -- every
   *   one but a routed turn's own call, which the caller stamps by this outcome.
   */
  async function runTurn(params) {
    const first = await runTurnOnce(params);
    if (!first.drawFailed) return first;
    const { channel, guildId, trigger = null, triggerKind = null, source = null } = params;
    // A failed picture someone asked for gets its own turn, started only once
    // the first one has fully returned (and freed the channel), with the
    // reason in the trigger label; its own <draw> is dropped. The first turn
    // held back its idle notifications (see runTurnOnce's `finally`), so a
    // pending ping is drained only after this second turn -- never raced by
    // it. Nobody asked on a spontaneous or an overheard turn (askedFor, the
    // same predicate as runTurnOnce's hand-off): the failure is only logged.
    // A turn about another channel keeps its source: a routed call is still
    // answered here, with the call shown and linked -- what that turn posts
    // reached the chat for the call too (`delivered`). It posts plain when the
    // first turn did (a follow-up): it carries that turn's kind.
    if (askedFor(trigger, triggerKind)) {
      try {
        const second = await runTurnOnce({
          channel,
          guildId,
          mode: 'reply',
          trigger,
          triggerKind: 'drawFailed',
          drawReason: first.drawFailed,
          drawFailedAfter: triggerKind,
          source,
          holdIdle: true,
        });
        log.info('turn: draw failure answered', { channel: channel.id, reason: first.drawFailed, outcome: second.outcome });
        if (second.outcome === 'spoke' && second.delivered === true) return { ...first, delivered: true };
      } finally {
        notifyIdle();
      }
    } else {
      log.warn('turn: draw failed', { channel: channel.id, reason: first.drawFailed });
    }
    return first;
  }

  /**
   * Tell whoever waits that a turn has finished: onIdle (fire-and-forget, same
   * as the caller of runTurn itself: whatever wants to run next --
   * src/discord/events.js's pending-ping drain, wired in src/index.js -- must
   * never hold up, or throw into, the turn that just freed the channel), and
   * the waitIdle() waiters once no turn is in flight anywhere.
   */
  function notifyIdle() {
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

  /**
   * One turn, as described on runTurn. Internal for the `drawFailed` turn:
   * `drawReason`, `drawFailedAfter` (the first turn's trigger kind: the
   * second posts plain when the first did, postsPlain), and `holdIdle` --
   * leave the idle notifications to the caller (runTurn fires them once the
   * second turn is over).
   */
  async function runTurnOnce({
    channel,
    guildId: guildIdParam = null,
    mode,
    trigger = null,
    triggerKind = null,
    chooseMode = null,
    forced = false,
    source = null,
    focus = null,
    drawReason = null,
    drawFailedAfter = null,
    holdIdle = false,
  }) {
    // A server channel carries its guild; a private chat is served on behalf of the pinned one.
    const guildId = channel.guild?.id ?? guildIdParam;
    if (!guildId) throw new Error('runTurn: a channel without a guild needs a guildId');
    const isPrivate = !channel.guild;
    // Set when this turn hands off to a drawFailed turn: runTurn notifies after it.
    let handOff = false;
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
      const selfName = getSelfName(guildId);
      const now = clock();
      const startedAt = now;
      // A drawFailed turn only says the picture failed: no classifier or
      // at-turn variety pass is paid for a second time (once it posts, its
      // pass ahead for the next turn starts like any turn's).
      const answersDrawFailure = triggerKind === 'drawFailed';
      // Someone asked for this turn (askedFor): not a spontaneous or an overheard one.
      const asked = askedFor(trigger, triggerKind);

      let history = await fetchHistory(channel, {
        limit: config.context.channelMessages,
        selfId,
        embedTextChars: config.media?.embedTextChars,
        videoSites: config.media?.video?.sites,
      });

      // The other channels this turn shows (`<channel_view>`, pullChannels), found and fetched
      // before the mode is chosen so a chooser sees them. Fresh captions only for a turn certain
      // to run: with the fetch when no chooser can still say not-now, else once it chose
      // (captionAll). A turn about another channel, or one with a chooser, waits for them here;
      // any other turn fetches them alongside the preparation below. Never in a private chat.
      // The block renders only under `labels.pull.header` (read now, as buildRequest reads it):
      // without it no channel is fetched for a mention or the route hook and no fresh caption
      // is paid for; a turn's source is still pulled (its chooser and a routed call's search
      // classifier read it).
      const certain = mode !== 'auto';
      const pullLabelled = Boolean(hot.prompts?.labels?.pull?.header);
      const pullsPending = isPrivate
        ? Promise.resolve({ pulled: [], sourceSkip: null })
        : pullChannels({ channel, guildId, history, trigger, triggerKind, source, selfId, selfName, config, now, certain, drawFailure: answersDrawFailure, labelled: pullLabelled })
            // Never fails the turn: anything unexpected is no pull (and no source).
            .catch((err) => {
              log.warn('pull: failed', { channel: channel.id, error: err });
              return { pulled: [], sourceSkip: source ? 'error' : null };
            });
      const early = source || !certain ? await pullsPending : null;
      if (early?.sourceSkip) {
        // Nothing to answer, or nothing to comment on: the source is gone or refused.
        if (source.reason !== 'routed') return { outcome: 'not-now' };
        log.warn('turn: source unavailable', { channel: channel.id, source: source.channelId, reason: early.sourceSkip });
        return { outcome: 'error' };
      }

      let finalMode = mode;
      if (mode === 'auto') {
        finalMode = chooseMode(history, now, { pulled: early.pulled });
        if (!finalMode) return { outcome: 'not-now' };
      }
      // Ready before the request is built; pulled ahead of a chooser, they get their fresh
      // captions now (only when the block can render).
      const pulledPending = !early
        ? pullsPending.then((pulls) => pulls.pulled)
        : certain || !pullLabelled
          ? Promise.resolve(early.pulled)
          : captionAll(early.pulled, { guildId, config, destination: channel });
      // A routed call lives in its source: the search classifier reads the source's lines around
      // it, with their captions, instead of this chat; the re-watch is not offered (below).
      const routedPull = source?.reason === 'routed' ? (early?.pulled.find((entry) => entry.channelId === source.channelId) ?? null) : null;

      // The variety pass on the persona's own recent lines is looked up now (ready, in flight, or
      // asked) and runs alongside everything below (descriptions, re-watch, lookup, neighbours); it
      // never rejects and the turn waits for it at most variety.timeoutMs, so it can never fail the
      // turn. A request still running then keeps going and its answer serves the next turn.
      const wornPending =
        variety && typeof variety.forTurn === 'function' && !answersDrawFailure
          ? variety.forTurn({ guildId, channelId: channel.id, history, selfName, privateChat: isPrivate }).catch(() => null)
          : Promise.resolve(null);

      // Lazy, request-time only (see fetchTextPreview's header comment):
      // never fetched during plain normalization or while just buffered.
      history = await withTextPreviews(history, config.media?.filePreviewChars ?? 500, fetchImpl);

      // Pictures NOT selected to be attached as image_url may still get a
      // helper's caption, newest first, capped at media.maxPerTurn; cached
      // captions are free (see src/memory/describe.js). With
      // features.attachedDescriptions (a missing key counts as on) the
      // attached ones get one too, ahead of the rest, shown next to their
      // attachment marker. Only this channel's pictures are attached, as
      // buildRequest picks them: a routed call's own pictures are captioned
      // with its pulled channel instead.
      let descriptions;
      if (features.mediaDescriptions === true && describer) {
        const visionCfg = config.context.vision ?? {};
        const picked = features.vision !== false ? selectPictures({ trigger, history, visionCfg, now, channelId: channel.id }) : [];
        const includePicked = features.attachedDescriptions !== false;
        const candidates = describableCandidates(history, picked, { includePicked });
        const described = await describer.describeMany(guildId, candidates, { maxNew: config.media?.maxPerTurn ?? 6 });
        descriptions = described.descriptions;
      }
      // What the search classifier reads around the trigger (routedPull above).
      const searchHistory = routedPull ? routedPull.messages : history;
      const searchDescriptions = routedPull ? new Map([...(descriptions ?? []), ...routedPull.descriptions]) : descriptions;

      // Videos (attached, or linked from a known video site) may be watched
      // by the video describer, newest first, at most media.video.maxPerTurn
      // NEW ones per turn; cached results and limit/error states are free.
      let videos;
      // Both switches (isVideoVisionOn), like the senses line; a missing videoDescriptions counts as on.
      if (isVideoVisionOn(config) && typeof describer?.describeVideos === 'function') {
        const videoCfg = config.media?.video ?? {};
        const candidates = [];
        for (let i = history.length - 1; i >= 0; i -= 1) {
          candidates.push(...collectVideos(history[i], { videoSites: videoCfg.sites }));
        }
        const watched = await describer.describeVideos(guildId, candidates, { maxNew: videoCfg.maxPerTurn ?? 1 });
        videos = watched.videos;

        // A second look when the trigger asks about a watched video: a
        // direct address only (never a spontaneous or an overheard turn, never
        // the drawFailed turn), switch features.videoRewatch (a missing key counts as on).
        // A routed call asks about its source, whose videos no turn watches: the videos
        // here belong to another conversation, so nothing is offered or retried.
        if (asked && !answersDrawFailure && features.videoRewatch !== false && typeof describer.rewatchVideo === 'function') {
          if (routedPull) {
            log.info('rewatch: skipped', { channel: channel.id, reason: 'routed' });
          } else {
            try {
              await maybeRewatch({
                config,
                guildId,
                channelId: channel.id,
                selfName,
                history,
                trigger,
                videos,
                descriptions,
                candidates,
              });
            } catch (err) {
              log.warn('rewatch: failed', { channel: channel.id, error: err });
            }
          }
        }
      }

      // The web lookup (features.webLookup -- unlike the other switches a
      // missing key counts as OFF: it costs money and the search needs a
      // key). Links first: the newest readable links of the history, at most
      // web.links.maxPerTurn NEW reads (cached excerpts are free). Then, on a
      // direct address only (not an overheard line), the search classifier
      // when the web search or the server search (recall, never in a private
      // chat) can run, and what its answer asks for of the two, in parallel.
      let reads;
      let lookupResult = null;
      const webCfg = config.web ?? {};
      const webLookupOn = features.webLookup === true && Boolean(lookup);
      if (webLookupOn && webCfg.links?.enabled !== false && typeof lookup.readLinks === 'function') {
        try {
          const candidates = readableLinkCandidates(history, config.media?.video?.sites);
          const read = await lookup.readLinks(guildId, candidates, { maxNew: webCfg.links?.maxPerTurn ?? 2 });
          reads = read.reads;
        } catch (err) {
          log.warn('lookup: links failed', { channel: channel.id, error: err });
        }
      }
      if (asked && !answersDrawFailure) {
        const webOn = webLookupOn && webCfg.search?.enabled !== false && typeof lookup.search === 'function';
        const serverOn = !isPrivate && recallAvailable();
        if (webOn || serverOn) {
          try {
            lookupResult = await maybeLookup({
              config,
              guildId,
              channel,
              selfId,
              selfName,
              history: searchHistory,
              chatHistory: history,
              trigger,
              descriptions: searchDescriptions,
              videos,
              reads,
              webOn,
              serverOn,
            });
          } catch (err) {
            log.warn('lookup: failed', { channel: channel.id, error: err });
          }
        }
      }

      // A private chat has no neighbouring channels. A neighbour passes the audience rail the
      // pulls pass (audienceAllows, context.pull.sameAudience): everyone who can read this channel
      // can read it. One refused takes no slot, costs no fetch, and never reaches `<server>`
      // either (buildRequest maps only the neighbours it is given); counted on the answer's log.
      let neighborsHidden = 0;
      const acceptNeighbor = (other) => {
        const allowed = audienceAllows(channel, other, config);
        if (!allowed) neighborsHidden += 1;
        return allowed;
      };
      const neighbors = isPrivate ? [] : await fetchNeighbors(channel, config, selfId, now, { accept: acceptNeighbor });
      // A neighbour's pictures get only the captions the cache already holds, under the
      // chat captions' switch: cachedDescriptions never sends a request or counts a day.
      const neighborDescriptions =
        features.mediaDescriptions === true && typeof describer?.cachedDescriptions === 'function' && neighbors.length > 0
          ? describer.cachedDescriptions(guildId, neighbors.flatMap((neighbor) => describableCandidates(neighbor.messages, [])))
          : undefined;
      // Drawing (features.imageGeneration, a missing key counts as on) needs the image client
      // and Attach Files here; a drawFailed turn answers the failure and never draws again.
      // An unasked turn reads the quota for no member, like draw() charges none.
      const drawOn = Boolean(images) && features.imageGeneration !== false && triggerKind !== 'drawFailed' && canAttach(channel);
      const drawQuota = drawOn ? images.quota({ userId: asked ? (trigger.authorId ?? null) : null }) : undefined;
      const pulled = await pulledPending;
      // Neighbours the bot can read but not write in, marked in `<server>` (a pulled channel's
      // record carries its own mark). A pulled channel whose block is shown is left out of the
      // neighbours by buildRequest itself.
      const readOnlyIds = new Set(neighbors.filter((neighbor) => neighbor.readOnly === true).map((neighbor) => neighbor.channelId));
      // Where a call from a read-only channel is answered, for `<senses>`.
      const destination = isPrivate ? null : usableDestination(channel.guild, config).channel;
      const worn = await wornPending;
      // `<recent>`: the guild's live recent lines (none: an empty list) and the channels this turn may show them from.
      const recent = memoryOn ? recentInput({ channel, guildId, isPrivate, config, now }) : NO_RECENT;
      // Every input named (turnRequestInput throws on one left undefined); null marks an absent one.
      const request = buildRequest(
        turnRequestInput({
          config,
          prompts: hot.prompts,
          calibrator,
          mode: finalMode,
          forced,
          now,
          selfName,
          history,
          neighbors,
          trigger,
          triggerKind,
          guildMemory: memoryOn ? store.getGuild(guildId) : {},
          interlocutor: memoryOn && trigger ? (store.getUser(guildId, trigger.authorId) ?? null) : null,
          // A private chat: the partner's private layer joins their public profile (only there).
          privateChat: isPrivate ? { userId: trigger?.authorId ?? null } : null,
          privateProfile: isPrivate && memoryOn && trigger ? (store.getPrivate(guildId, trigger.authorId) ?? null) : null,
          otherProfiles: memoryOn
            ? pickOtherProfiles(store, guildId, history, trigger?.authorId, config.context.otherProfiles)
            : [],
          candidateProfiles: memoryOn ? store.listUserProfiles(guildId) : [],
          nameOf: memoryOn ? (id) => store.getUser(guildId, id)?.names?.[0] ?? null : null,
          channels: memoryOn ? store.listChannels(guildId) : [],
          loreEntries: memoryOn ? store.getLore(guildId) : [],
          currentChannelId: channel.id,
          descriptions: descriptions ?? null,
          neighborDescriptions: neighborDescriptions ?? null,
          videos: videos ?? null,
          reads: reads ?? null,
          lookup: lookupResult ?? null,
          searchAvailable: features.webLookup === true && typeof lookup?.hasSearch === 'function' && lookup.hasSearch() === true,
          drawQuota: drawQuota ?? null,
          drawReason,
          // The `<emoji>` block: the index's emoji (ranked by guildMemory.emojiUsage) and their cached captions.
          customEmoji: emoji ? (emoji.list() ?? []) : [],
          // The `<gifs>` block and the transcript's GIF handles: the guild's library (features.gifs).
          gifs: features.gifs !== false && typeof store.getGifs === 'function' ? (store.getGifs(guildId) ?? null) : null,
          // The cached captions of both lists.
          mediaCache:
            emoji || (features.gifs !== false && typeof store.getGifs === 'function') ? (store.getMediaCache(guildId) ?? null) : null,
          // The `<worn>` block: what this turn's variety pass named, or nothing.
          worn: worn ?? null,
          // `<channel_view>`: the channels pulled into this turn, the one it is about, the chat
          // line put to the room, where a call from a read-only channel is answered.
          pulled,
          source,
          focus,
          elsewhereDestination: destination?.name ? { name: destination.name } : null,
          readOnlyIds,
          // `<recent>`: the last hours, its live lines and the members' moments (no block without the store).
          recentLines: recent.lines ?? null,
          recentAudience: recent.audience ?? null,
        }),
      );
      // What `<recent>` showed, held back or cut: counts only.
      if (request.recent) log.info('recent: shown', { channel: channel.id, ...request.recent });

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
        completion = await llm.complete(messages, { role: 'talk' });
      } catch (err) {
        // Second line of defence: the picture downloaded fine on our end but
        // the provider still rejects the request for some 4xx reason.
        // request.textFallback is a full re-render of the same user message
        // with every imageAttached/frameAttached tag dropped back to its
        // blind/described form -- resending the ORIGINAL text (still
        // claiming a picture is attached) alongside no actual image would be
        // worse than the error itself.
        // A 408 or 429 (timeout, rate limit, quota) says nothing about the
        // pictures and the client has already retried it (RETRY_STATUS): a
        // resend would only double a doomed request while the persona's one
        // attention waits, so it propagates like any error without pictures.
        const aboutThePictures = err.statusCode >= 400 && err.statusCode < 500 && !RETRY_STATUS.has(err.statusCode);
        if (Array.isArray(messages[1]?.content) && aboutThePictures) {
          const textOnly = messages.map((m) => (Array.isArray(m.content) ? { ...m, content: request.textFallback } : m));
          completion = await llm.complete(textOnly, { role: 'talk' });
        } else {
          throw err;
        }
      }

      const parsed = parseOutput(completion.text);
      // Feature switches drop parts of the model's output before it is acted on.
      if (features.reactions === false) parsed.reactions = [];
      // A custom emoji reaction resolves through the index; an unknown one (or the switch off) is dropped.
      const lookupEmoji = emojiLookup();
      parsed.reactions = parsed.reactions
        .map((reaction) => ({ ...reaction, emoji: resolveReactionEmoji(reaction.emoji, lookupEmoji) }))
        .filter((reaction) => reaction.emoji);
      if (features.multiMessage === false) parsed.messages = parsed.messages.slice(0, 1);
      // No image client, drawing off, no Attach Files, or already answering a failed picture: the <draw> is dropped.
      if (!drawOn) parsed.draw = null;
      // features.gifs off, an unknown handle or gifs.maxPerDay spent: the <gif> is dropped.
      parsed.gif = resolveGif(guildId, parsed.gif, channel.id);
      const nothingToDo =
        parsed.messages.length === 0 && parsed.reactions.length === 0 && parsed.draw === null && parsed.gif === null;

      log.info('turn: model answered', {
        mode: finalMode,
        trigger: triggerKind ?? null,
        // Only on a turn about another channel, with channels pulled, or with a line put to the room.
        ...(source ? { source: source.channelId ?? null } : {}),
        ...(pulled.length > 0 ? { pulled: pulled.length } : {}),
        ...(focus ? { focus: true } : {}),
        // Active neighbours the audience rail left out.
        ...(neighborsHidden > 0 ? { neighborsHidden } : {}),
        secondsToAnswer: Math.round((clock() - startedAt) / 100) / 10,
        channel: channel.id,
        estimated: completion.estimated,
        usage: completion.usage,
        calibration: Number(calibrator.ratio.toFixed(3)),
        budget: request.stats,
        think: parsed.think,
        skip: parsed.skip || nothingToDo,
        messages: parsed.messages.length,
        reactions: parsed.reactions.length,
        draw: Boolean(parsed.draw),
        gif: Boolean(parsed.gif),
      });
      // The pulled channels whose block was in the request sent (a skip and a dry run included):
      // their seen marks move to the newest line shown; a block the budget dropped moves none.
      const shownPulled = request.pulledKept ?? [];
      markPulledSeen(shownPulled);
      store.state.data.calibration = calibrator.ratio;
      store.state.markDirty();
      // The calls of the ring this turn showed follow its decision (stampShownCalls), except a
      // routed turn's own call: its caller stamps that one.
      const ownCallId = source?.reason === 'routed' ? (trigger?.id ?? null) : null;

      if (parsed.skip || nothingToDo) {
        stampShownCalls({ shown: shownPulled, pulled, answered: new Set(), exceptId: ownCallId });
        return { outcome: 'skip', mode: finalMode };
      }

      const idByIndex = request.idByIndex;
      // The output side of the pulled channels: which line lives where, whose @name resolves,
      // which post carries a jump link (one rule for act and dryAct). Names resolve over the
      // pulled lines the request showed, then this chat's history: resolveMentions keeps the
      // last author of a display name, so a chat author wins a name both share, and nobody the
      // model was not shown (a block the budget dropped) is pinged.
      const pulledIds = request.pulledIds ?? new Map();
      const shownLines = shownPulled.flatMap(({ channelId, ids }) => {
        const shownIds = new Set(ids);
        return (pulled.find((entry) => entry.channelId === channelId)?.messages ?? []).filter((message) => shownIds.has(message.id));
      });
      const lines = shownLines.length > 0 ? [...shownLines, ...history] : history;
      const linkFor = createLinker({
        guildId,
        pulledIds,
        sourceTarget: isPrivate ? null : sourceLinkTarget({ source, trigger, pulledKept: shownPulled }),
      });
      // A follow-up or an overheard turn (postsPlain) never posts as a Discord reply -- the
      // model's reply="#n" quotes nothing --, nor does the drawFailed turn after one.
      const plain = postsPlain(triggerKind) || postsPlain(drawFailedAfter);
      const routing = { pulledIds, lines, linkFor, plain };
      // Read fresh right here, not from the `features` snapshot taken at the
      // top of this turn: unlike the other switches this one defaults to OFF,
      // and whether to actually post is the very last decision of a turn.
      if (hot.config.features?.dryRun === true) {
        await dryAct({ channel, parsed, idByIndex, mode: finalMode, triggerKind, selfName, ...routing });
        noteSpokeSaw(channel, history, shownPulled, pulled);
        return { outcome: 'spoke', mode: finalMode, dryRun: true };
      }
      const acted = await act({
        channel,
        guildId,
        privateChat: isPrivate,
        parsed,
        idByIndex,
        history,
        startedAt,
        mode: finalMode,
        triggerKind,
        trigger,
        selfName,
        ...routing,
        sourceId: isPrivate ? null : (source?.channelId ?? null),
      });
      noteSpokeSaw(channel, history, shownPulled, pulled);
      stampShownCalls({ shown: shownPulled, pulled, answered: acted.answered ?? new Set(), exceptId: ownCallId });
      const spoke = { outcome: 'spoke', mode: finalMode, delivered: acted.delivered === true };
      if (!acted.drawFailed) return spoke;
      // The same predicate as runTurn's hand-off: an unasked turn notifies right here.
      handOff = asked;
      return { ...spoke, drawFailed: acted.drawFailed };
    } catch (err) {
      if (err instanceof DailyCapError || err instanceof TokenLimitError) {
        log.warn('turn: refused by a safety rail', { channel: channel.id, error: err });
        return { outcome: 'refused', limit: limitOf(err) };
      }
      log.error('turn: failed', { channel: channel.id, error: err });
      return { outcome: 'error' };
    } finally {
      busy.delete(channel.id);
      // A hand-off to the drawFailed turn (or that turn itself) leaves the
      // notifications to runTurn, which fires them once both are done.
      if (!handOff && !holdIdle) notifyIdle();
    }
  }

  return {
    runTurn,
    isBusy: (channelId) => busy.has(channelId),
    isAnyBusy: () => busy.size > 0,
    lastPostAt: (channelId) => lastPostAt.get(channelId) ?? 0,
    notePost: (channelId, ts) => lastPostAt.set(channelId, ts),
    /**
     * Whether the last turn that spoke in `channelId` (this process, dry-run included) had
     * `messageId` in its channel history -- so a direct ping queued while that turn ran was
     * already in front of the model and is not answered a second time. For a channel the bot
     * cannot write in: whether the last turn that spoke while showing that channel's lines
     * (`<channel_view>`) showed `messageId`.
     * @param {string} channelId
     * @param {string} messageId
     * @returns {boolean}
     */
    spokeAfterSeeing: (channelId, messageId) => spokeSaw.get(channelId)?.has(messageId) ?? false,
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
