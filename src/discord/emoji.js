// The server's custom emoji in the persona's own output. The model writes
// `:name:` (the way it reads them in the transcript); Discord only shows a
// custom emoji as `<:name:id>` / `<a:name:id>`. The pure functions below turn
// one into the other through a `lookup(name)`, and createEmojiIndex is the
// one thin view over discord.js that backs that lookup: it keeps no copy,
// the guild's emoji cache (kept current by discord.js) is the map.

// Skipped as a whole, never scanned for tokens: code blocks, inline code,
// custom emoji markup already well formed, timestamps, bracketed and bare URLs.
// The second alternative is a `:name:` token; a name followed by `//` is a URL scheme.
const SCAN_RE =
  /(```[\s\S]*?```|``[^`]*?``|`[^`\n]*`|<a?:\w+:\d+>|<t:-?\d+(?::[A-Za-z])?>|<https?:\/\/[^>\s]*>|https?:\/\/\S+)|:([A-Za-z0-9_]{2,32}):(?!\/\/)/g;
const NAME_TOKEN_RE = /^:([A-Za-z0-9_]{2,32}):$/;
const MARKUP_RE = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{1,25})>$/;

/** `<:name:id>` or `<a:name:id>` for one emoji. */
function markup(emoji) {
  return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

/**
 * The emoji called `name` among `emojis`: an exact case-sensitive match first,
 * then a case-insensitive match when it is the only one. Emoji Discord marks
 * unavailable (`available === false`, e.g. a lost boost level) never match.
 * @param {Iterable<{ id: string, name: string, animated?: boolean, available?: boolean }>} emojis
 * @param {string} name
 * @returns {{ id: string, name: string, animated: boolean }|null}
 */
export function matchEmojiName(emojis, name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  let exact = null;
  const loose = [];
  for (const emoji of emojis ?? []) {
    if (!emoji?.id || !emoji.name || emoji.available === false) continue;
    if (emoji.name === name) {
      exact = emoji;
      break;
    }
    if (emoji.name.toLowerCase() === lower) loose.push(emoji);
  }
  const found = exact ?? (loose.length === 1 ? loose[0] : null);
  return found ? { id: found.id, name: found.name, animated: Boolean(found.animated) } : null;
}

/**
 * Replace every `:name:` the index knows with its Discord markup. Unknown or
 * ambiguous names, code (inline and blocks), markup already well formed,
 * timestamps and URLs are left as they are, so the result is idempotent.
 * @param {string} text
 * @param {((name: string) => ({ id: string, name: string, animated: boolean }|null))|null} lookup
 * @returns {string}
 */
export function renderCustomEmoji(text, lookup) {
  const source = String(text ?? '');
  if (typeof lookup !== 'function' || !source.includes(':')) return source;
  const re = new RegExp(SCAN_RE.source, 'g');
  let out = '';
  let last = 0;
  let match;
  while ((match = re.exec(source))) {
    out += source.slice(last, match.index);
    if (match[1] !== undefined) {
      out += match[1];
      last = re.lastIndex;
      continue;
    }
    const emoji = lookup(match[2]);
    if (emoji) {
      out += markup(emoji);
      last = re.lastIndex;
    } else {
      // Keep the opening colon only: the closing one may open the next token.
      out += ':';
      last = match.index + 1;
      re.lastIndex = last;
    }
  }
  return out + source.slice(last);
}

/**
 * The body of a `<react>` as something `message.react()` accepts. A unicode
 * emoji passes through; `:name:` resolves through `lookup`; `<:name:id>` /
 * `<a:name:id>` resolves through `lookup` by name and otherwise keeps its own
 * id. Without a lookup (the switch off, no index) or for an unknown `:name:`
 * the result is null: the reaction is dropped.
 * @param {string} raw
 * @param {((name: string) => ({ id: string, name: string, animated: boolean }|null))|null} lookup
 * @returns {string|null}
 */
export function resolveReactionEmoji(raw, lookup) {
  const body = String(raw ?? '').trim();
  if (!body) return null;
  const token = NAME_TOKEN_RE.exec(body);
  const given = token ? null : MARKUP_RE.exec(body);
  if (!token && !given) return body;
  if (typeof lookup !== 'function') return null;
  const found = lookup(token ? token[1] : given[2]);
  if (found) return markup(found);
  return given ? markup({ animated: given[1] === 'a', name: given[2], id: given[3] }) : null;
}

/**
 * A live name/id view over the served guild's custom emoji. Nothing is
 * copied: every call reads `client.guilds.cache.get(guildId).emojis.cache`,
 * which discord.js keeps current (the GuildExpressions intent delivers the
 * emoji updates). `guildId` may be a getter, read at use.
 * @param {{ guilds: { cache: Map<string, any> } }} client
 * @param {string|(() => (string|null))} guildId
 * @returns {{ byName: (name: string) => ({ id: string, name: string, animated: boolean }|null),
 *             byId: (id: string) => ({ id: string, name: string, animated: boolean }|null),
 *             list: () => { id: string, name: string, animated: boolean }[],
 *             size: () => number }}
 */
export function createEmojiIndex(client, guildId) {
  function cache() {
    const id = typeof guildId === 'function' ? guildId() : guildId;
    return (id && client?.guilds?.cache?.get(id)?.emojis?.cache) || null;
  }
  function plain(emoji) {
    return { id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated) };
  }
  function list() {
    const emojis = cache();
    if (!emojis) return [];
    return [...emojis.values()].filter((e) => e?.id && e.name && e.available !== false).map(plain);
  }
  return {
    byName: (name) => {
      const emojis = cache();
      return emojis ? matchEmojiName(emojis.values(), name) : null;
    },
    byId: (id) => {
      const emoji = cache()?.get(id);
      return emoji && emoji.available !== false ? plain(emoji) : null;
    },
    list,
    size: () => list().length,
  };
}
