// Entry point: wires config, hot reload, the persistent store, the
// OpenRouter client, discord.js and the turn/spontaneous/memory subsystems
// together, and owns the process lifecycle (startup checks, timers, graceful
// shutdown). No decision logic lives here — everything is imported from
// src/behavior, src/memory, src/llm and src/discord.

import path from 'node:path';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';

import { ROOT_DIR, loadDotEnv, need } from './config.js';
import { createHot } from './hot.js';
import { log } from './log.js';
import { createStore } from './memory/store.js';
import { createCalibrator } from './llm/tokens.js';
import { createLlm } from './llm/openrouter.js';
import { createTurnRunner } from './behavior/turn.js';
import { createSpontaneous } from './behavior/spontaneous.js';
import { createMemoryUpdater } from './memory/update.js';
import { createAdmin } from './admin.js';
import { createTagHistory } from './behavior/mention.js';
import { createMessageHandler } from './discord/events.js';

const REQUIRED_PROMPTS = ['system-prompt', 'character-card', 'format', 'reply', 'interject', 'initiate', 'memory'];

/** Print a one-line, secret-free error and terminate with a non-zero exit code. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Like need(), but turns a missing variable into a friendly startup failure. */
function needOrFail(key) {
  try {
    return need(key);
  } catch {
    return fail(`Missing required environment variable ${key} — copy .env.example to .env and fill in the real values.`);
  }
}

loadDotEnv();
const discordToken = needOrFail('DISCORD_TOKEN');
const openrouterKey = needOrFail('OPENROUTER_API_KEY');

const hot = createHot({ rootDir: ROOT_DIR }).watch();

const missingPrompts = REQUIRED_PROMPTS.filter((name) => typeof hot.prompts[name] !== 'string' || !hot.prompts[name]);
const labels = hot.prompts.labels;
const labelsOk = Boolean(labels) && typeof labels === 'object' && Boolean(labels.transcript);
if (!labelsOk) missingPrompts.push('labels');

if (missingPrompts.length > 0) {
  const files = missingPrompts.map((name) => (name === 'labels' ? 'prompts/labels.json' : `prompts/${name}.md`));
  fail(
    `Missing required prompt file(s): ${files.join(', ')} ` +
      '(prompts.local/ may override any of these, file by file).',
  );
}

const store = createStore({ dataDir: path.join(ROOT_DIR, 'data') });
const calibrator = createCalibrator(store.state.data.calibration);
const llm = createLlm({ apiKey: openrouterKey, getConfig: () => hot.config, calibrator, state: store.state });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // required to receive DM messageCreate events
});

const turns = createTurnRunner({ hot, store, llm, calibrator, client });
const spontaneous = createSpontaneous({ hot, store, client, turns });
const memory = createMemoryUpdater({
  hot,
  store,
  llm,
  calibrator,
  getSelfName: (guildId) => client.guilds.cache.get(guildId)?.members.me?.displayName ?? client.user?.username ?? 'bot',
});
const admin = createAdmin({ hot, store, client, spontaneous, calibrator });
const tagHistory = createTagHistory();

const onMessage = createMessageHandler({ hot, store, client, turns, spontaneous, memory, admin, tagHistory });

const timers = [];

/** Run `fn` on an interval; a rejected promise is logged, never left unhandled. */
function every(ms, fn, label) {
  const id = setInterval(() => {
    Promise.resolve()
      .then(fn)
      .catch((err) => log.error(`index: ${label} failed`, { error: err }));
  }, ms);
  id.unref?.();
  timers.push(id);
}

client.once(Events.ClientReady, () => {
  log.info('index: ready', { guilds: client.guilds.cache.size, tag: client.user.tag });
  every(30_000, () => spontaneous.tick(), 'spontaneous.tick');
  // The tick still runs on schedule even with the switch off, so flipping it
  // back on later needs no restart; it is the wrapper here that no-ops.
  every(60_000, () => (hot.config.features?.memory !== false ? memory.tick() : undefined), 'memory.tick');
  every(30_000, () => store.flush(), 'store.flush');
});

client.on('messageCreate', onMessage);

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('index: shutting down', { signal });
  for (const id of timers) clearInterval(id);
  spontaneous.stop();
  hot.close();
  store.flush();
  await client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('index: unhandled rejection', { error: err }));

client.login(discordToken).catch((err) => fail(`Discord login failed: ${err.message}`));
