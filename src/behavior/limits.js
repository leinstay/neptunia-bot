// Limit notices: when a rail (daily request cap, token cap, image caps,
// private reply caps) refuses a directly requested action, the bot posts one
// plain line naming the limit and the numbers, so the requester knows it was
// a limit and not silence in character. The wording lives in labels.json
// (`limits.notice`); the limit name is the config key. See
// docs/en/prompt-contract.md. The pure helpers come first; `postLimitNotice`
// and `mirrorDryRun` are the one copy of the posting side, shared by the turn
// runner (src/behavior/turn.js) and the message pipeline
// (src/discord/events.js).

import { fill } from '../discord/format.js';
import { log } from '../log.js';

/**
 * The notice line: `labels.limits.notice` with `{limit}` (the config key),
 * `{used}` and `{cap}` filled. An empty string when the label is missing, so
 * a deployment without it simply posts nothing.
 * @param {object} labels
 * @param {{ key: string, used: number, cap: number }} limit
 * @returns {string}
 */
export function limitNotice(labels, { key, used, cap }) {
  const template = labels?.limits?.notice;
  if (typeof template !== 'string' || !template) return '';
  return fill(template, { limit: key, used, cap });
}

/**
 * Whether `content` is a line `limitNotice` produced from the current label:
 * the template with every `{name}` placeholder matching any non-empty text
 * and everything else matched literally, anchored at both ends (surrounding
 * whitespace ignored). Such a line is bookkeeping, not the persona's speech,
 * so the caller keeps it out of memory and follow-up windows. False when the
 * label is missing.
 * @param {object} labels
 * @param {unknown} content
 * @returns {boolean}
 */
export function isLimitNotice(labels, content) {
  const template = labels?.limits?.notice;
  if (typeof template !== 'string' || !template) return false;
  if (typeof content !== 'string' || !content) return false;
  const pattern = template
    .split(/(\{\w+\})/)
    .map((part, index) => (index % 2 === 1 ? '.+?' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${pattern}$`, 'su').test(content.trim());
}

/**
 * The limit a rail error carries (`DailyCapError`, `TokenLimitError`,
 * `ImageCapError` set `key`, `used`, `cap`), or null for any other error.
 * @param {unknown} err
 * @returns {{ key: string, used: number, cap: number } | null}
 */
export function limitOf(err) {
  if (!err || typeof err !== 'object') return null;
  const { key, used, cap } = err;
  if (typeof key !== 'string' || !key) return null;
  if (!Number.isFinite(used) || !Number.isFinite(cap)) return null;
  return { key, used, cap };
}

/**
 * How a dry-run mirror header names `channel`: `#name` for a server
 * channel, `private` for a private chat (a DM channel has no name).
 * @param {{ name?: string|null }} channel
 * @returns {string}
 */
export function mirrorChannelLabel(channel) {
  return channel?.name ? `#${channel.name}` : 'private';
}

/**
 * Post one readable dry-run mirror message (`header`, a newline, `body`)
 * into `dryRunChannelId` (`bot.dryRunChannelId`, read by the caller now),
 * no mentions resolved. The channel is fetched fresh every time, so pointing
 * the mirror elsewhere needs no restart. An empty id posts nothing. Never
 * throws: a fetch or send failure is logged and swallowed, so a
 * misconfigured mirror never costs the persona anything.
 * @param {{ client: { channels: { fetch: Function } }, dryRunChannelId: string, header: string, body: string }} args
 * @returns {Promise<boolean>} whether the mirror message was sent
 */
export async function mirrorDryRun({ client, dryRunChannelId, header, body }) {
  if (!dryRunChannelId) return false;
  try {
    const mirror = await client.channels.fetch(dryRunChannelId);
    if (!mirror) return false;
    await mirror.send({ content: `${header}\n${body}`, allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    log.warn('dry-run: mirror failed', { dryRunChannelId, error: err });
    return false;
  }
}

/**
 * Post the limit notice for `limit` in `channel`: one plain message, no
 * mentions, quoting `trigger` as a Discord reply when `asReply` (the caller
 * passes false for a follow-up, which never posts as a reply). With
 * `features.dryRun` it is logged and mirrored (`bot.dryRunChannelId`)
 * instead of sent. `labels` and `config` are the caller's `hot.prompts.labels`
 * and `hot.config`, read at the moment of use. A missing label or limit posts
 * nothing. Never throws: a failed send is logged.
 * @param {{ channel: object, trigger?: { id?: string }|null, limit: { key: string, used: number, cap: number }|null,
 *   asReply: boolean, labels: object, config: object, client: object }} args
 * @returns {Promise<'sent'|'dry-run'|'none'|'failed'>}
 */
export async function postLimitNotice({ channel, trigger, limit, asReply, labels, config, client }) {
  const text = limit ? limitNotice(labels, limit) : '';
  if (!text) return 'none';
  try {
    if (config?.features?.dryRun === true) {
      log.info('dry-run: would notify limit', { channel: channel.id, key: limit.key, used: limit.used, cap: limit.cap });
      await mirrorDryRun({
        client,
        dryRunChannelId: config.bot?.dryRunChannelId || '',
        header: `[dry-run] ${mirrorChannelLabel(channel)} · limit`,
        body: text,
      });
      return 'dry-run';
    }
    const replyId = asReply ? (trigger?.id ?? null) : null;
    await channel.send({
      content: text,
      reply: replyId ? { messageReference: replyId, failIfNotExists: false } : undefined,
      allowedMentions: { parse: [] },
    });
    log.info('limits: notice sent', { channel: channel.id, key: limit.key });
    return 'sent';
  } catch (err) {
    log.warn('limits: notice failed', { channel: channel.id, error: err });
    return 'failed';
  }
}
