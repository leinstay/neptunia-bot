// Parses the model's tagged output (contract: prompts/format.md) into actions.
//   <think>…</think>          hidden planning, discarded
//   <msg reply="#87">…</msg>   a chat message, optionally a reply to message #87
//   <react to="#87">💀</react> a reaction on message #87
//   <skip/>                    stay silent
// The parser is forgiving: a missing tag wrapper falls back to a single plain
// message, an unterminated <think> (output cut by max_tokens) means silence.

const MAX_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 1900;
const MAX_FALLBACK_CHARS = 600;

function parseIndex(value) {
  const match = /(\d+)/.exec(value ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * @returns {{ skip: boolean, messages: {text: string, replyTo: number|null}[],
 *             reactions: {to: number, emoji: string}[], think: string }}
 */
export function parseOutput(raw) {
  const result = { skip: false, messages: [], reactions: [], think: '' };
  let text = String(raw ?? '');

  text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (all, inner) => {
    result.think += inner.trim();
    return '';
  });
  if (/<think>/i.test(text)) {
    result.skip = true;
    return result;
  }

  for (const match of text.matchAll(/<msg(\s[^>]*)?>([\s\S]*?)<\/msg>/gi)) {
    const body = match[2].trim();
    if (!body) continue;
    const reply = /reply\s*=\s*"([^"]*)"/i.exec(match[1] ?? '');
    result.messages.push({
      text: body.slice(0, MAX_MESSAGE_CHARS),
      replyTo: reply ? parseIndex(reply[1]) : null,
    });
  }

  for (const match of text.matchAll(/<react\s+to\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/react>/gi)) {
    const to = parseIndex(match[1]);
    const emoji = match[2].trim();
    if (to !== null && emoji && emoji.length <= 16) result.reactions.push({ to, emoji });
  }

  result.messages = result.messages.slice(0, MAX_MESSAGES);

  if (result.messages.length === 0 && result.reactions.length === 0) {
    const leftover = text.replace(/<skip\s*\/?>/gi, '').trim();
    const hasTags = /<\/?(msg|react|skip)\b/i.test(text);
    if (!hasTags && leftover && leftover.length <= MAX_FALLBACK_CHARS) {
      result.messages.push({ text: leftover, replyTo: null });
    } else {
      result.skip = true;
    }
  }

  return result;
}

/** Extract the first JSON object from a model reply, tolerating code fences and chatter. */
export function parseJsonObject(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the model reply');
  return JSON.parse(text.slice(start, end + 1));
}
