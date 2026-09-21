// Decides what goes into an LLM request and what is cut so the request stays
// under the token cap. Sections are handed over in PRIORITY order (most
// important first); each takes what it needs from the remaining budget, up to
// its own optional cap, and whatever does not fit is dropped item by item.
// Rendering order is the caller's business — priority and position in the
// prompt are independent.

/**
 * @typedef {object} Section
 * @property {string} name
 * @property {string[]} items        Independent pieces; one is kept or dropped whole.
 * @property {'first'|'newest'} [keep]  Which end survives trimming: 'first' keeps
 *   items from the start (ranked lists), 'newest' keeps items from the end (chat logs).
 * @property {number} [cap]          Max tokens this section may take.
 * @property {boolean} [required]    Required sections are never trimmed; if they
 *   alone exceed the limit, fitSections throws.
 */

/**
 * Thrown by `fitSections` when the sections marked `required` alone already
 * exceed `limit` — i.e. the request cannot be built at all, not even by
 * trimming. A dedicated class (rather than matching the message text) lets a
 * caller — src/memory/update.js#analyze — reliably tell this apart from a
 * generic build/provider error and classify it as the same 'token-limit'
 * reason as a `TokenLimitError` from src/llm/openrouter.js.
 */
export class SectionsTooLargeError extends Error {}

/**
 * Fit `sections` into `limit` tokens. `cost(text)` returns the token price of
 * one item. Returns `{ kept, stats, used }` where `kept[name]` is the surviving
 * items in their original order.
 */
export function fitSections(sections, limit, cost) {
  const kept = {};
  const stats = {};
  let remaining = limit;

  for (const section of sections) {
    if (!section.required) continue;
    const used = section.items.reduce((sum, item) => sum + cost(item), 0);
    remaining -= used;
    kept[section.name] = [...section.items];
    stats[section.name] = { used, kept: section.items.length, dropped: 0 };
  }
  if (remaining < 0) {
    throw new SectionsTooLargeError(`required prompt sections exceed the token limit by ${-remaining}`);
  }

  for (const section of sections) {
    if (section.required) continue;
    const budget = Math.min(section.cap ?? Infinity, remaining);
    const order = section.keep === 'newest' ? [...section.items].reverse() : section.items;
    const taken = [];
    let used = 0;
    for (const item of order) {
      const price = cost(item);
      // A chat log must stay contiguous: once one message does not fit, stop.
      if (used + price > budget) {
        if (section.keep === 'newest') break;
        continue;
      }
      taken.push(item);
      used += price;
    }
    if (section.keep === 'newest') taken.reverse();
    remaining -= used;
    kept[section.name] = taken;
    stats[section.name] = { used, kept: taken.length, dropped: section.items.length - taken.length };
  }

  return { kept, stats, used: limit - remaining };
}
