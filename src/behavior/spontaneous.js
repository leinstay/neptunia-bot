// The persona does not only answer when called: at chaotic, unpredictable
// intervals it either cuts into a conversation that is clearly alive right
// now ('interject') or starts a topic itself in a channel that has gone
// quiet ('initiate'). It can also eavesdrop on a single fresh message and
// jump in a few seconds/minutes later, as if it had just noticed it.
//
// Pure decision functions (delay, active hours, mode, channel pick) take an
// injected `rng`/`now` and are unit-tested directly. The factory below is the
// only place that touches discord.js, the schedule on disk and the turn
// runner.

import { localHour } from '../discord/format.js';
import { readableChannels, canSend, lastActivity, channelAllowed } from '../discord/collect.js';
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

  function passesFilters(channel, config, cfg, t) {
    // One attention (mention.oneAtATime, default on): while a turn is
    // running anywhere, a spontaneous tick or an eavesdrop must treat every
    // channel as unavailable, not just the one already busy -- runTurn
    // enforces the same rail itself, this just avoids attempting it.
    const oneAtATime = config.mention?.oneAtATime !== false;
    return (
      channelAllowed(channel, config.bot) &&
      canSend(channel) &&
      (cfg.channels.length === 0 || cfg.channels.includes(channel.id)) &&
      t - turns.lastPostAt(channel.id) >= cfg.minGapMinutes * MINUTE_MS &&
      !turns.isBusy(channel.id) &&
      !(oneAtATime && turns.isAnyBusy())
    );
  }

  function channelCandidates(guild, config, cfg, t) {
    return readableChannels(guild, config.bot)
      .filter((channel) => passesFilters(channel, config, cfg, t) && !isChannelDead(channel, t, cfg))
      .map((channel) => ({ channel, lastActivity: lastActivity(channel) }));
  }

  function makeChooseMode(cfg) {
    return (history, ts) => chooseMode(history, ts, cfg, rng);
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

    const channel = pickChannel(channelCandidates(guild, config, cfg, t), t, rng);

    if (!channel) {
      schedule[guildId] = t + between(REWAKE_MINUTES, rng) * MINUTE_MS;
      store.state.markDirty();
      log.info('spontaneous: no eligible channel', { guildId });
      return;
    }

    // Reschedule before awaiting the turn, so a slow turn cannot double-fire.
    schedule[guildId] = t + nextDelayMs(cfg, rng);
    store.state.markDirty();

    running.add(guildId);
    log.info('spontaneous: firing a turn', { guildId, channel: channel.id });
    try {
      const result = await turns.runTurn({ channel, mode: 'auto', chooseMode: makeChooseMode(cfg) });
      log.info('spontaneous: turn finished', { guildId, channel: channel.id, outcome: result.outcome });
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
    if (isWarmingUp()) return false;
    const features = config.features ?? {};
    if (features.spontaneous === false || features.eavesdrop === false) return false;
    return isActiveHour(localHour(t, config.bot.timezone), config.spontaneous.activeHours);
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

  return { tick, onMessage, force, status, stop };
}
