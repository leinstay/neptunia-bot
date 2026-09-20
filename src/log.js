// Minimal structured logger: one JSON object per line, written to stdout.
// No dependency, no levels config — callers filter downstream (journald, etc).

// JSON.stringify(new Error()) is "{}" — serialise errors explicitly, also when nested in meta
// (callers usually pass `{ error: err, ... }`).
function serializeError(err) {
  const out = { name: err.name, message: err.message };
  if (err.code !== undefined) out.code = err.code;
  if (err.statusCode !== undefined) out.statusCode = err.statusCode;
  if (err.stack) out.stack = err.stack.split('\n').slice(0, 8).join('\n');
  if (err.cause instanceof Error) out.cause = serializeError(err.cause);
  return out;
}

function normalizeMeta(meta) {
  if (meta === undefined) return {};
  if (meta instanceof Error) return { error: serializeError(meta) };
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const out = {};
    for (const [key, value] of Object.entries(meta)) {
      out[key] = value instanceof Error ? serializeError(value) : value;
    }
    return out;
  }
  return { value: meta };
}

function write(level, msg, meta) {
  const entry = {
    level,
    time: new Date().toISOString(),
    msg: String(msg),
    ...normalizeMeta(meta),
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export const log = {
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};
