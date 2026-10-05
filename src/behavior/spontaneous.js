// The persona does not only answer when called: at chaotic, unpredictable
// intervals it either cuts into a conversation that is clearly alive right
// now ('interject') or starts a topic itself in a channel that has gone
// quiet ('initiate'). It can also eavesdrop on a single fresh message and
// jump in a few seconds/minutes later, as if it had just noticed it.
//
// A channel the persona can read but not write in (a read-only channel) is a
// candidate too, with the main channel as its destination
// (features.elsewhere): with unseen, settled, live messages there, a tick may
// run a noticed comment about it in the destination, and an eavesdrop hit
// there (noticeElsewhere) lets src/discord/events.js arm a settle wait that
// ends in runNoticed. The ordinary rails apply, every one checked on the
// destination; the per-source seen mark keeps one content from being
// commented twice. There is no counter of its own.
//
// Pure decision functions (delay, active hours, mode, channel pick) take an
// injected `rng`/`now` and are unit-tested directly. The factory below is the
// only place that touches discord.js, the schedule on disk and the turn
// runner.

import { localHour } from '../discord/format.js';
import { readableChannels, canSend, lastActivity, channelAllowed } from '../discord/collect.js';
import { audienceAllows } from '../discord/pull-fetch.js';
import { usableDestination } from './turn.js';
import { chooseElsewhereMode, elsewhereSettings, hasUnseen, mayBeLive } from './elsewhere.js';
import { between } from './random.js';
import { log } from '../log.js';
import { MINUTE_MS, HOUR_MS, DAY_MS } from '../time.js';

const REWAKE_MINUTES = [10, 40]; // how soon to try again after a turn found "nothing to say" / no channel

/**
 * Time until the next spontaneous check, in ms. Usually a long, log-uniform
 * gap (so short waits are common and very long ones still happen); sometimes
 * a short "burst" gap, as if the persona got caught up in something.
 * @param {object} cfg  config.spontaneous
 * @param {() => number} rng
 */
export function nextDelayMs(cfg, rng) {
  if (rng() < cfg.burstChance) {
    return between(cfg.burstMinutes, rng) * MINUTE_MS;
  }
  const [min, max] = [cfg.minIntervalMinutes, cfg.maxIntervalMinutes];
  const logMin = Math.log(min);
  const logMax = Math.log(max);
  const minutes = Math.exp(logMin + rng() * (logMax - logMin));
  return minutes * MINUTE_MS;
}

/**
 * Whether `hour` (0-23, local time) falls inside `activeHours = { from, to }`.
 * The window may wrap over midnight (from 10 to 3 means active 10:00-02:59).
 * `from === to` means always active.
 */
export function isActiveHour(hour, activeHours) {
  const { from, to } = activeHours;
  if (from === to) return true;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

/**
 * 0 when `now` already falls in an active hour; otherwise the ms until the
 * next `from` hour (found by stepping minute by minute through `localHour`,
 * which is simple and cheap since this only runs when the persona is
 * asleep), plus a random 0-90 minutes so it does not wake up on the dot.
 */
export function msUntilActive(now, timezone, activeHours, rng) {
  const hour = localHour(now, timezone);
  if (isActiveHour(hour, activeHours)) return 0;

  let t = now;
  let steps = 0;
  const maxSteps = 2 * (24 * 60); // two days of minutes, generous safety cap
  while (localHour(t, timezone) !== activeHours.from && steps < maxSteps) {
    t += MINUTE_MS;
    steps += 1;
  }
  return t - now + between([0, 90], rng) * MINUTE_MS;
}

/**
 * Decide what a spontaneous turn should do, from the same normalized history
 * a real turn sees (oldest first, `{ ts, self, bot, authorId }`), in order:
 * an empty history, or a silence of at least `cfg.deadAfterMinutes` since the
 * last message (whoever wrote it, the persona included), rolls
 * `cfg.initiateChance` for 'initiate'; otherwise a last message of the
 * persona's own means null (it never interjects on itself); otherwise at least
 * `cfg.liveMinMessages` messages from other members (not the persona, not bots)
 * within `cfg.liveWindowMinutes` means 'interject'; otherwise null.
 * @param {object[]} history
 * @param {number} now
 * @param {object} cfg  config.spontaneous
 * @param {() => number} rng
 * @returns {'interject'|'initiate'|null}
 */
export function chooseMode(history, now, cfg, rng) {
  if (history.length === 0) {
    return rng() < cfg.initiateChance ? 'initiate' : null;
  }

  const last = history[history.length - 1];
  const silenceMs = now - last.ts;
  if (silenceMs >= cfg.deadAfterMinutes * MINUTE_MS) {
    return rng() < cfg.initiateChance ? 'initiate' : null;
  }

  if (last.self) return null; // the persona never interjects on its own last line

  const windowStart = now - cfg.liveWindowMinutes * MINUTE_MS;
  const liveCount = history.filter((m) => m.ts >= windowStart && !m.self && !m.bot).length;
  if (liveCount >= cfg.liveMinMessages) return 'interject';

  return null;
}

/**
 * Whether `channel`'s last message is older than `cfg.maxChannelSilenceHours`
 * -- such a channel is never a candidate for a spontaneous turn (interject or
 * initiate) started on the persona's own initiative. A `maxChannelSilenceHours`
 * that is not a positive number means no limit. A direct ping in a dead
 * channel is still answered: this only concerns the persona starting on its own.
 * @param {object} channel
 * @param {number} now
 * @param {{ maxChannelSilenceHours?: number }} cfg  config.spontaneous
 * @returns {boolean}
 */
export function isChannelDead(channel, now, cfg) {
  const maxHours = cfg.maxChannelSilenceHours;
  if (!(typeof maxHours === 'number' && maxHours > 0)) return false;
  return now - lastActivity(channel) > maxHours * HOUR_MS;
}

/**
 * Pick a channel to speak in, favouring recent activity without always
 * picking the same one. `candidates = [{ channel, lastActivity }]`.
 */
export function pickChannel(candidates, now, rng) {
  if (candidates.length === 0) return null;

  const activeRecently = candidates.filter((c) => now - c.lastActivity < DAY_MS);
  if (activeRecently.length === 0) {
    return candidates[Math.floor(rng() * candidates.length)].channel;
  }

  if (rng() < 0.7) {
    return activeRecently.reduce((a, b) => (b.lastActivity > a.lastActivity ? b : a)).channel;
  }
  return activeRecently[Math.floor(rng() * activeRecently.length)].channel;
}

/**
 * Where the persona's words about `source` (a channel the bot cannot send
 * in) go, read from `config` (the live config) now: `{ destination, reason:
 * null }` with the discord.js channel, or `{ destination: null, reason }`
 * with the code logged as `route`: `off` (features.elsewhere false),
 * `no-destination` (no usable memory.mainChannelIds entry other than the
 * source, src/behavior/turn.js#usableDestination) or `audience` (someone who
 * can view the destination cannot view the source,
 * src/discord/pull-fetch.js#audienceAllows). The one copy of the route of a
 * routed call and of a noticed comment.
 * @param {object} source  A discord.js guild channel.
 * @param {object} config  The live config.
 * @returns {{ destination: object, reason: null } | { destination: null, reason: 'off'|'no-destination'|'audience' }}
 */
export function routeFor(source, config) {
  const { channel: destination, reason } = usableDestination(source.guild, config, { exceptId: source.id });
  if (!destination) return { destination: null, reason };
  if (!audienceAllows(destination, source, config)) return { destination: null, reason: 'audience' };
  return { destination, reason: null };
}

/** Whether `prompts.elsewhere` (the task of a noticed comment) is a non-empty text. */
function hasElsewherePrompt(prompts) {
  const text = prompts?.elsewhere;
  return typeof text === 'string' && text.trim() !== '';
}

/**
 * Wire the pure decisions above to discord.js, the persisted schedule and the
 * turn runner.
 * @param {object} params
 * @param {import('../hot.js').createHot extends (...args: any) => infer R ? R : never} params.hot
 * @param {ReturnType<import('../memory/store.js').createStore>} params.store
 * @param {import('discord.js').Client} params.client
 * @param {ReturnType<import('./turn.js').createTurnRunner>} params.turns
 * @param {() => string | null} params.getGuildId  the single guild this instance serves, or null before it resolves
 * @param {() => boolean} [params.isWarmingUp]  true while the memory warmup runner
 *   (src/memory/warmup.js) is in flight: no tick and no eavesdrop scheduling happens.
 *   Default: never warming up.
 * @param {() => number} [params.rng]
 * @param {() => number} [params.now]
 */
export function createSpontaneous({
  hot,
  store,
  client,
  turns,
  getGuildId,
  isWarmingUp = () => false,
  rng = Math.random,
  now = Date.now,
}) {
  const running = new Set(); // guildIds with a spontaneous turn in flight
  const eavesdropTimers = new Set();

  /**
   * Why the persona may not speak unprompted in `dest` (the channel the words
   * go to) now, or null when it may: `channel` (not allowed by bot.channels,
   * or not in a non-empty spontaneous.channels), `cannot-send`, `gap` (its
   * own last post there is younger than spontaneous.minGapMinutes) or `busy`
   * (a turn runs there or, with one attention, anywhere). A writable channel
   * is its own destination; a read-only source speaks in the main channel.
   */
  function destinationBlock(dest, config, cfg, t) {
    if (!channelAllowed(dest, config.bot)) return 'channel';
    if (!canSend(dest)) return 'cannot-send';
    if (cfg.channels.length > 0 && !cfg.channels.includes(dest.id)) return 'channel';
    if (t - turns.lastPostAt(dest.id) < cfg.minGapMinutes * MINUTE_MS) return 'gap';
    // One attention (mention.oneAtATime, default on): while a turn is
    // running anywhere, a spontaneous tick or an eavesdrop must treat every
    // channel as unavailable, not just the one already busy -- runTurn
    // enforces the same rail itself, this just avoids attempting it.
    const oneAtATime = config.mention?.oneAtATime !== false;
    if (turns.isBusy(dest.id) || (oneAtATime && turns.isAnyBusy())) return 'busy';
    return null;
  }

  function passesFilters(channel, config, cfg, t) {
    return destinationBlock(channel, config, cfg, t) === null;
  }

  /** The seen mark of a source (state.json `elsewhereSeen`), read now; null without one. */
  function seenOf(sourceId) {
    const mark = store.state.data.elsewhereSeen?.[sourceId];
    return Number.isFinite(mark) ? mark : null;
  }

  /**
   * Where a noticed comment on `source` would be spoken now, every rail of
   * the words checked on that destination: `{ destination, reason: null }`,
   * or `{ destination: null, reason }`: `channel` (the source is not allowed
   * or the bot can send there), routeFor's codes (`off`, `no-destination`,
   * `audience`), `no-prompt` (prompts.elsewhere missing or empty) or
   * destinationBlock's codes for the destination.
   */
  function noticedRoute(source, config, cfg, t) {
    if (!channelAllowed(source, config.bot) || canSend(source)) return { destination: null, reason: 'channel' };
    const route = routeFor(source, config);
    if (!route.destination) return route;
    if (!hasElsewherePrompt(hot.prompts)) return { destination: null, reason: 'no-prompt' };
    const blocked = destinationBlock(route.destination, config, cfg, t);
    return blocked ? { destination: null, reason: blocked } : route;
  }

  /**
   * A read-only source on the tick path: its destination when it is a
   * candidate, else null. Its last message must be newer than its seen mark
   * and, with spontaneous.liveMinMessages above 0, inside the live window
   * (mayBeLive: the ordinary liveness, the member count is the chooser's),
   * and at least elsewhere.settleSeconds old (the burst settled); then
   * noticedRoute.
   */
  function sourceDestination(source, config, cfg, t) {
    const last = lastActivity(source);
    if (!mayBeLive(last, t, seenOf(source.id), cfg)) return null;
    if (t - last < elsewhereSettings(config).settleMs) return null;
    return noticedRoute(source, config, cfg, t).destination;
  }

  /**
   * Every channel a tick may pick: `{ channel, lastActivity, destination }`.
   * A writable channel is its own destination; a read-only source (only
   * with features.elsewhere on and a non-empty prompts.elsewhere) carries
   * the main channel and `noticed: true`. A dead channel is never one.
   */
  function channelCandidates(guild, config, cfg, t) {
    const candidates = [];
    for (const channel of readableChannels(guild, config.bot)) {
      if (isChannelDead(channel, t, cfg)) continue;
      if (canSend(channel)) {
        if (passesFilters(channel, config, cfg, t)) candidates.push({ channel, lastActivity: lastActivity(channel), destination: channel });
        continue;
      }
      const destination = sourceDestination(channel, config, cfg, t);
      if (destination) candidates.push({ channel, lastActivity: lastActivity(channel), destination, noticed: true });
    }
    return candidates;
  }

  function makeChooseMode(cfg) {
    return (history, ts) => chooseMode(history, ts, cfg, rng);
  }

  /**
   * The chooser of a noticed turn on `sourceId`: the source as runTurn
   * pulled it, its seen mark read when the chooser runs, chooseElsewhereMode
   * on `path` (`tick`: the ordinary liveness; `eavesdrop`: the roll was the
   * gate). A source that was not pulled is `not-now`.
   */
  function makeChooseNoticed(sourceId, cfg, path) {
    return (history, ts, context) => {
      const pulled = context?.pulled?.find?.((entry) => entry.channelId === sourceId);
      if (!pulled) return null;
      return chooseElsewhereMode(pulled.messages, ts, seenOf(sourceId), cfg, { path });
    };
  }

  /** runTurn's arguments of a noticed comment on `source`, spoken in `destination`. */
  function noticedTurn(source, destination, cfg, path) {
    return {
      channel: destination,
      source: { channelId: source.id, reason: 'noticed' },
      mode: 'auto',
      chooseMode: makeChooseNoticed(source.id, cfg, path),
    };
  }

  async function tick() {
    // /nep pause: the owner is editing data/ by hand -- no spontaneous
    // activity, and nothing here (not even the schedule) may become dirty.
    if (store.state.data.paused) return;
    // A memory warmup run is in flight: the persona stays mute, same as a pause.
    if (isWarmingUp()) return;

    const config = hot.config;
    const cfg = config.spontaneous;
    if (config.features?.spontaneous === false) return;

    const guildId = getGuildId();
    if (!guildId) return; // not resolved yet — nothing to do
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    if (running.has(guildId)) return;

    const schedule = (store.state.data.spontaneous ??= {});
    const t = now();

    if (schedule[guildId] === undefined) {
      schedule[guildId] = t + nextDelayMs(cfg, rng);
      store.state.markDirty();
      return;
    }
    if (t < schedule[guildId]) return;

    const hour = localHour(t, config.bot.timezone);
    if (!isActiveHour(hour, cfg.activeHours)) {
      schedule[guildId] = t + msUntilActive(t, config.bot.timezone, cfg.activeHours, rng);
      store.state.markDirty();
      log.info('spontaneous: outside active hours, sleeping', { guildId, wakeAt: schedule[guildId] });
      return;
    }

    const candidates = channelCandidates(guild, config, cfg, t);
    const channel = pickChannel(candidates, t, rng);

    if (!channel) {
      schedule[guildId] = t + between(REWAKE_MINUTES, rng) * MINUTE_MS;
      store.state.markDirty();
      log.info('spontaneous: no eligible channel', { guildId });
      return;
    }

    // Reschedule before awaiting the turn, so a slow turn cannot double-fire.
    schedule[guildId] = t + nextDelayMs(cfg, rng);
    store.state.markDirty();

    // A read-only source speaks in its destination, about itself (a noticed comment).
    const picked = candidates.find((candidate) => candidate.channel === channel);
    const noticed = picked?.noticed === true;
    const turnChannel = noticed ? picked.destination : channel;
    const source = noticed ? channel.id : null;

    running.add(guildId);
    log.info('spontaneous: firing a turn', { guildId, channel: turnChannel.id, source });
    try {
      const result = await turns.runTurn(
        noticed ? noticedTurn(channel, turnChannel, cfg, 'tick') : { channel, mode: 'auto', chooseMode: makeChooseMode(cfg) },
      );
      log.info('spontaneous: turn finished', { guildId, channel: turnChannel.id, source, outcome: result.outcome });
      if (result.outcome === 'not-now') {
        schedule[guildId] = now() + between(REWAKE_MINUTES, rng) * MINUTE_MS;
        store.state.markDirty();
      }
    } catch (err) {
      log.error('spontaneous: turn failed', { guildId, error: err });
    } finally {
      running.delete(guildId);
    }
  }

  /**
   * Whether an eavesdrop may happen now, `config` read by the caller now:
   * not warming up, both switches on (eavesdropping is a form of spontaneous
   * speech) and inside active hours. A pause is checked by runTurn itself.
   */
  function eavesdropAllowed(config, t) {
    return eavesdropBlock(config, t) === null;
  }

  /** Why eavesdropAllowed says no: `warmup`, `off` (a switch) or `asleep` (outside active hours); null when it says yes. */
  function eavesdropBlock(config, t) {
    if (isWarmingUp()) return 'warmup';
    const features = config.features ?? {};
    if (features.spontaneous === false || features.eavesdrop === false) return 'off';
    return isActiveHour(localHour(t, config.bot.timezone), config.spontaneous.activeHours) ? null : 'asleep';
  }

  /** Eavesdrop on a freshly observed message and maybe jump in after a delay. */
  function onMessage(channel, normalized) {
    // /nep pause: no eavesdrop scheduling while paused.
    if (store.state.data.paused) return;

    const config = hot.config;
    const cfg = config.spontaneous;
    const t = now();
    // A memory warmup run, a switch off or the persona asleep: no eavesdrop scheduling.
    if (!eavesdropAllowed(config, t)) return;
    if (normalized.self || normalized.bot) return;
    if (channel.guild.id !== getGuildId()) return;
    if (!passesFilters(channel, config, cfg, t)) return;
    if (rng() >= cfg.eavesdropChance) return;

    const delay = between(cfg.eavesdropDelayMs, rng);
    const timer = setTimeout(() => {
      eavesdropTimers.delete(timer);
      // Up to eavesdropDelayMs later: the same checks again, on the config read now.
      const current = hot.config;
      if (!eavesdropAllowed(current, now())) return;
      turns
        .runTurn({ channel, mode: 'auto', chooseMode: makeChooseMode(current.spontaneous) })
        .catch((err) => log.error('spontaneous: eavesdrop turn failed', { channel: channel.id, error: err }));
    }, delay);
    timer.unref?.();
    eavesdropTimers.add(timer);
  }

  /**
   * The eavesdrop roll for a fresh message in a read-only channel: true when
   * a noticed comment on `channel` may follow, so the caller
   * (src/discord/events.js) arms a settle wait that ends in runNoticed. The
   * same rails as any eavesdrop (not paused, eavesdropAllowed, a member's
   * message of the served guild), the route to a destination that passes
   * every rail of unprompted words (noticedRoute), then one roll of
   * spontaneous.eavesdropChance. A hit logs `spontaneous: noticed`.
   * Schedules nothing itself.
   * @param {object} channel  The discord.js channel the message was written in.
   * @param {object} normalized
   * @returns {boolean}
   */
  function noticeElsewhere(channel, normalized) {
    if (store.state.data.paused) return false;
    const config = hot.config;
    const cfg = config.spontaneous;
    const t = now();
    if (!eavesdropAllowed(config, t)) return false;
    if (normalized.self || normalized.bot) return false;
    if (channel.guild?.id !== getGuildId()) return false;
    const { destination } = noticedRoute(channel, config, cfg, t);
    if (!destination) return false;
    if (rng() >= cfg.eavesdropChance) return false;
    log.info('spontaneous: noticed', { source: channel.id, destination: destination.id });
    return true;
  }

  /**
   * Run the noticed comment on `source` an eavesdrop hit led to, once its
   * settle wait is over. Every rail is read again now, as noticeElsewhere
   * read it (the destination resolved now), and the source must still hold
   * something newer than its seen mark; then the turn runs in the
   * destination with `source` (`reason: 'noticed'`) and the eavesdrop
   * chooser (one new member message after the mark is enough). The tick
   * schedule is left as it is. Never rejects.
   * @param {object} source  The discord.js channel the persona read.
   * @returns {Promise<{ outcome: string, reason?: string }>}  A rail that refused gives `not-now`
   *   (`paused` while paused) with its code in `reason`: `paused`, `warmup`, `off`, `asleep`, `channel`,
   *   `no-destination`, `audience`, `no-prompt`, `cannot-send`, `gap`, `busy` or `seen`. Otherwise the
   *   turn's own result.
   */
  async function runNoticed(source) {
    if (store.state.data.paused) return { outcome: 'paused', reason: 'paused' };
    const config = hot.config;
    const cfg = config.spontaneous;
    const t = now();
    const refuse = (reason) => ({ outcome: 'not-now', reason });
    const blocked = eavesdropBlock(config, t);
    if (blocked) return refuse(blocked);
    const guildId = getGuildId();
    if (!guildId || source.guild?.id !== guildId) return refuse('channel');
    const { destination, reason } = noticedRoute(source, config, cfg, t);
    if (!destination) return refuse(reason);
    if (!hasUnseen(lastActivity(source), seenOf(source.id))) return refuse('seen');

    log.info('spontaneous: firing a turn', { guildId, channel: destination.id, source: source.id });
    try {
      const result = await turns.runTurn(noticedTurn(source, destination, cfg, 'eavesdrop'));
      log.info('spontaneous: turn finished', { guildId, channel: destination.id, source: source.id, outcome: result?.outcome });
      return result ?? { outcome: 'error' };
    } catch (err) {
      log.error('spontaneous: turn failed', { guildId, source: source.id, error: err });
      return { outcome: 'error' };
    }
  }

  /** Force a turn right now, bypassing the schedule (owner command: `/nep interject`, `/nep initiate`). */
  function force(channel, mode) {
    return turns.runTurn({ channel, mode, forced: true });
  }

  function status() {
    return { ...(store.state.data.spontaneous ?? {}) };
  }

  function stop() {
    for (const timer of eavesdropTimers) clearTimeout(timer);
    eavesdropTimers.clear();
  }

  return { tick, onMessage, noticeElsewhere, runNoticed, force, status, stop };
}
