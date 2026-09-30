// The custom emoji history backfill: the analyzer counts members' custom emoji
// only from the batches it consumes (src/memory/update.js), so on a server
// with a long history the `<emoji>` block would show the server's first emoji
// in server order until enough batches pass. This reads the last
// `context.customEmoji.backfillMessages` messages of every readable channel
// over the Discord API -- no LLM, no token budget -- and counts them into
// guild.json's `emojiUsage` at once (src/memory/emoji-usage.js), starting from
// a cleared ranking, then stamps `emojiBackfill: { at, channels, messages }`
// so it never counts the same history twice. Runs once at startup
// (`startIfNeeded`) and again only on the owner's `/nep emoji rescan` (`run`
// with `force`).

import { readableChannels, fetchHistoryWindow } from '../discord/collect.js';
import { log as defaultLog } from '../log.js';

/** How many messages one `store.recordEmojiUsage` call takes. */
const CHUNK = 500;

/** Default of `context.customEmoji.backfillMessages` when the key is missing. */
const DEFAULT_BACKFILL_MESSAGES = 500;

/**
 * The emoji history backfill for the served guild.
 * @param {object} deps
 * @param {object} deps.hot     src/hot.js view; `config.context.customEmoji`, `config.bot`,
 *   `config.media.embedTextChars`, `config.features.customEmoji` read at use.
 * @param {object} deps.store   src/memory/store.js.
 * @param {object} deps.client  The discord.js Client (`user.id`, `guilds.cache`).
 * @param {object} [deps.log]   src/log.js-shaped logger.
 */
export function createEmojiBackfill({ hot, store, client, log = defaultLog }) {
  let running = false;

  function skipped(reason) {
    log.info('emoji-backfill: skipped', { reason });
    return { ok: false, reason };
  }

  /**
   * Read the history and rebuild `emojiUsage` from it. Every run that goes
   * ahead CLEARS `emojiUsage` and recounts it from the history window alone:
   * the window already holds the messages the analyzer counted since the
   * feature went live, so adding on top would count them twice (counts the
   * analyzer added for messages older than the window are dropped). Without
   * `force` that happens only on the first run -- it is a no-op once
   * `emojiBackfill.at` is set (the startup run). With `force` it ignores the
   * stamp: the owner's explicit `/nep emoji rescan`.
   * Channels are read one after another, 100 messages per page (see
   * src/discord/collect.js#fetchHistoryWindow; discord.js waits out rate
   * limits). Messages of bots and of the persona are skipped, as are those
   * still in the analyzer buffer (the analyzer counts them when it consumes
   * them). Clearing, counting and stamping happen together after every
   * channel is read. Skips (never throws) when paused, when
   * `backfillMessages` is 0, when already stamped (no `force`), while another
   * run is in flight, or when the guild is not in the client's cache; an
   * unexpected error is thrown.
   * @param {string} guildId
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<{ ok: true, channels: number, messages: number, emoji: number } | { ok: false, reason: string }>}
   */
  async function run(guildId, { force = false } = {}) {
    if (running) return skipped('running');
    if (store.state?.data?.paused) return skipped('paused');
    const limit = hot.config.context?.customEmoji?.backfillMessages ?? DEFAULT_BACKFILL_MESSAGES;
    if (!Number.isInteger(limit) || limit <= 0) return skipped('disabled');
    if (!force && store.getGuild(guildId).emojiBackfill?.at) return skipped('done');

    running = true;
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return skipped('no-guild');

      const selfId = client.user?.id;
      const channels = readableChannels(guild, hot.config.bot);
      const collected = [];
      for (const channel of channels) {
        let messages = [];
        try {
          messages = await fetchHistoryWindow(channel, {
            limit,
            minTs: 0,
            selfId,
            embedTextChars: hot.config.media?.embedTextChars,
          });
        } catch (err) {
          log.warn('emoji-backfill: channel read failed', { channel: channel.id, error: err });
        }
        for (const message of messages) {
          if (message.self || message.bot) continue;
          collected.push({ id: message.id, ts: message.ts, emojis: message.emojis ?? [] });
        }
      }

      // From here on nothing awaits: the analyzer cannot consume a batch in between.
      if (store.state?.data?.paused) return skipped('paused');
      const buffered = new Set(store.getBuffer(guildId).map((message) => message?.id));
      const members = collected.filter((message) => !buffered.has(message.id)).sort((a, b) => a.ts - b.ts);
      const emojiCfg = hot.config.context?.customEmoji ?? {};
      const opts = { storeMax: emojiCfg.storeMax ?? 200, halfLifeDays: emojiCfg.halfLifeDays ?? 30 };

      // Always from a cleared ranking: the window already holds what the analyzer counted so far.
      store.clearEmojiUsage(guildId);
      let emoji = 0;
      for (let i = 0; i < members.length; i += CHUNK) {
        emoji += store.recordEmojiUsage(guildId, members.slice(i, i + CHUNK), opts);
      }
      store.setEmojiBackfill(guildId, { at: new Date().toISOString(), channels: channels.length, messages: members.length });
      store.flush();

      const counts = { channels: channels.length, messages: members.length, emoji };
      log.info('emoji-backfill: done', counts);
      return { ok: true, ...counts };
    } finally {
      running = false;
    }
  }

  /**
   * The startup run: once, when `features.customEmoji` is on (a missing key
   * counts as on) and the guild has no `emojiBackfill` stamp yet. Meant to be
   * called without awaiting; resolves either way, errors are logged, never thrown.
   * @param {string} guildId
   * @returns {Promise<void>}
   */
  async function startIfNeeded(guildId) {
    try {
      if (hot.config.features?.customEmoji === false) {
        skipped('feature-off');
        return;
      }
      await run(guildId);
    } catch (err) {
      log.error('emoji-backfill: failed', { error: err });
    }
  }

  /** Whether a backfill is reading history right now. */
  function isRunning() {
    return running;
  }

  return { run, startIfNeeded, isRunning };
}
