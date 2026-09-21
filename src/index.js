// Entry point: wires config, hot reload, the persistent store, the
// OpenRouter client, discord.js and the turn/spontaneous/memory subsystems
// together, and owns the process lifecycle (startup checks, timers, graceful
// shutdown). No decision logic lives here — everything is imported from
// src/behavior, src/memory, src/llm and src/discord.

import path from 'node:path';
import { Client, Events, GatewayIntentBits } from 'discord.js';

import { ROOT_DIR, loadDotEnv, need } from './config.js';
import { createHot } from './hot.js';
import { log } from './log.js';
import { createStore } from './memory/store.js';
import { createCalibrator } from './llm/tokens.js';
import { createLlm } from './llm/openrouter.js';
import { createTurnRunner } from './behavior/turn.js';
import { createSpontaneous } from './behavior/spontaneous.js';
import { createMemoryUpdater } from './memory/update.js';
import { createWarmup } from './memory/warmup.js';
import { createDescriber } from './memory/describe.js';
import { createImageFetcher } from './discord/fetch-image.js';
import { createAdmin } from './admin.js';
import { createTagHistory } from './behavior/mention.js';
import { createMessageHandler } from './discord/events.js';
import { resolveGuild } from './discord/guild.js';
import { isValidCommandName, registerCommands, createInteractionHandler } from './discord/commands.js';

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

if (!isValidCommandName(hot.config.bot.commandName)) {
  fail(
    `index: invalid bot.commandName "${hot.config.bot.commandName}" — must match ^[a-z0-9_-]{1,32}$ ` +
      '(config.local.json).',
  );
}

const store = createStore({ dataDir: path.join(ROOT_DIR, 'data') });
const calibrator = createCalibrator(store.state.data.calibration);
const llm = createLlm({ apiKey: openrouterKey, getConfig: () => hot.config, calibrator, state: store.state });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// This instance serves exactly one Discord server. `instance.guildId` is set
// once, right after ClientReady resolves it (see below), and every component
// that needs it reads it through `getGuildId` instead of caching it, so a
// switch to a different guild always requires a restart, never a silent swap.
const instance = { guildId: null };
const getGuildId = () => instance.guildId;

// Shared so a picture attached on consecutive turns, or described more than
// once, is only ever downloaded once within the fetcher's LRU window.
const imageFetcher = createImageFetcher();
const describer = createDescriber({ hot, store, llm, imageFetcher });
const turns = createTurnRunner({ hot, store, llm, calibrator, client, describer, imageFetcher });
const spontaneous = createSpontaneous({ hot, store, client, turns, getGuildId });
const memory = createMemoryUpdater({
  hot,
  store,
  llm,
  calibrator,
  getSelfName: (guildId) => client.guilds.cache.get(guildId)?.members.me?.displayName ?? client.user?.username ?? 'bot',
});
const warmup = createWarmup({ hot, store, client, memory, getGuildId, describer });
const admin = createAdmin({ hot, store, client, spontaneous, calibrator, getGuildId, warmup });
const tagHistory = createTagHistory();

const onMessage = createMessageHandler({
  hot,
  store,
  client,
  turns,
  spontaneous,
  memory,
  tagHistory,
  getGuildId,
  isWarmingUp: () => warmup.isBlocking(),
  describer,
});

const onInteraction = createInteractionHandler({ hot, admin, getGuildId });

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

let lastCommandName = hot.config.bot.commandName;
let lastAdminCommandsOn = hot.config.features?.adminCommands !== false;

client.once(Events.ClientReady, async () => {
  const guilds = [...client.guilds.cache.values()].map((guild) => ({ id: guild.id, name: guild.name }));
  const resolved = resolveGuild(hot.config.bot.guildId, guilds);
  if (resolved.error) fail(`index: ${resolved.error}`);

  instance.guildId = resolved.guildId;
  if (!hot.config.bot.guildId) {
    log.info('index: bot.guildId is not set, using the only guild the bot is in — pin it in config.local.json', {
      guildId: instance.guildId,
    });
  }

  log.info('index: ready', { guild: instance.guildId, tag: client.user.tag });

  const guild = client.guilds.cache.get(instance.guildId);
  await registerCommands(guild, hot.config);

  // Before the persona is allowed to speak: run the memory warm-up if one is
  // due (config.warmup.enabled and not already done/aborted). Not awaited —
  // events.js mutes the persona for the duration via isWarmingUp().
  if (warmup.isBlocking()) {
    warmup
      .run()
      .then((result) => {
        log.info('index: warm-up run ended', {
          done: result?.done ?? false,
          aborted: result?.aborted ?? false,
          tokensUsed: result?.tokensUsed ?? 0,
          requests: result?.requests ?? 0,
        });
      })
      .catch((err) => log.error('index: warm-up run failed', { error: err }));
  }

  // The live analyzer must never run concurrently with the warm-up, and
  // spontaneous speech makes no sense while the persona is still mute — both
  // wrappers just no-op while a warm-up is due or running.
  every(30_000, () => (warmup.isBlocking() ? undefined : spontaneous.tick()), 'spontaneous.tick');
  // The tick still runs on schedule even with the switch off, so flipping it
  // back on later needs no restart; it is the wrapper here that no-ops.
  every(
    60_000,
    () => (warmup.isBlocking() ? undefined : hot.config.features?.memory !== false ? memory.tick() : undefined),
    'memory.tick',
  );
  every(30_000, () => store.flush(), 'store.flush');
});

// A running instance never switches servers live: bot.guildId is only read at
// startup. If the owner later points it at a different, non-empty guild while
// the process is up, keep serving the original one and just say so.
hot.on('change', ({ what }) => {
  if (what !== 'config' || !instance.guildId) return;
  const configured = hot.config.bot.guildId;
  if (configured && configured !== instance.guildId) {
    log.warn('index: bot.guildId changed while running, restart required to switch servers', {
      serving: instance.guildId,
      configured,
    });
  }

  // The command tree (and whether it is registered at all) depends on
  // bot.commandName and features.adminCommands — re-push it only when one of
  // those actually changed, never on every unrelated config edit.
  const commandName = hot.config.bot.commandName;
  const adminCommandsOn = hot.config.features?.adminCommands !== false;
  if (commandName !== lastCommandName || adminCommandsOn !== lastAdminCommandsOn) {
    lastCommandName = commandName;
    lastAdminCommandsOn = adminCommandsOn;
    const guild = client.guilds.cache.get(instance.guildId);
    if (guild) {
      registerCommands(guild, hot.config).catch((err) => log.error('index: failed to re-register commands', { error: err }));
    }
  }
});

client.on('messageCreate', onMessage);
client.on('interactionCreate', onInteraction);

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
