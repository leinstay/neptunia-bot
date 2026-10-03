// The mentor's run: the manual sub-process that measures one behaviour the
// owner wants from the persona (a "case"). The mentor model invents chat
// situations that put the case to the test; the persona answers each in a
// sandbox (live prompts, rules and memory; nothing posted, nothing stored);
// the mentor model scores every answer on several axes against a reference
// of how the people in the chat really write; the run is saved with the case
// and a report goes to the owner's admin channel when one is configured (the
// owner commands `status` and `show` read it without one). When a run fails,
// or one of its situations scores under the pass score, the mentor model is
// asked once more for its opinion of the cause and of what it would change
// (the diagnosis, saved with the run and marked as unverified: advice for
// the owner, never applied); that step never fails a run. The mentor only
// measures: it changes nothing.
//
// A case may carry real moments of the chat ("anchors", src/mentor/anchor.js):
// each is a situation of its own, numbered before the invented ones and
// replayed from its stored messages at its own time, with today's prompts and
// today's memory minus what was written at or after its trigger (so the
// persona cannot remember how the exchange ended; `mentor.anchor.hideLaterMemory`,
// src/mentor/moment.js). The situations request shows them to the mentor model as
// `<examples>`, and an anchor's score request carries the persona's original
// answer as `<original>`. Wherever an anchor's chat does not fit a request,
// its oldest messages give way; the trigger never does. An anchor's media
// render with what the persona saw of them then (the describer's captions and
// watched summaries stored with it, else found in the describer's cache as it
// stood when she answered; src/mentor/anchor.js#replayMedia), everywhere its
// transcript appears; the cache is only read.
//
// A reply-target situation exercises the variety pass as a live turn does
// (src/behavior/variety.js): the persona's own lines of that situation's
// history go to the same pass, charged to the mentor's budget, and its answer
// becomes the `<worn>` block of every sample of that situation; the patterns
// are saved on the situation record (`worn`). The judge never sees them.
//
// Everything expensive is bounded: the mentor's own daily token budget is
// checked before every request and charged after every completion, the
// per-request token cap of the llm client stays in force, and nothing counts
// against the chat's daily request cap. One run at a time; `stop()` aborts
// the request in flight. Nothing here runs on a timer.
//
// What a model reads comes from the prompt files (`mentor-*`) and labels;
// this module only fills their `{{name}}`-style placeholders and wraps data in
// tagged blocks (tag names documented in the prompt contract). One of those
// prompts, `mentor-signs` (the known signs of model-written text), is not a
// system prompt: it travels as the `<signs>` block of every mentor request,
// right after `<samples>`, and is simply left out when missing or empty.

import { block, fillPromptTemplate, learnedConfig, learnedText } from '../behavior/prompt.js';
import { classifierTextModel } from '../behavior/mention.js';
import { buildVarietyRequest, parseVariety, selectOwnLines, varietyOn, varietySettings } from '../behavior/variety.js';
import { fill, formatTranscript, renderTranscript } from '../discord/format.js';
import { TokenLimitError } from '../llm/openrouter.js';
import { estimateMessages, estimateTokens } from '../llm/tokens.js';
import { log } from '../log.js';
import { DAY_MS } from '../time.js';
import { anchorSituations, replayMedia, resolveAnchor } from './anchor.js';
import { MentorBudgetError } from './budget.js';
import { parseDiagnosis, parseScores, parseSituations, verdict } from './judge.js';
import { hiddenLater, momentCutoff, momentView } from './moment.js';
import { answerFacts, repeatedPhrases, sampleLines, styleProfile } from './reference.js';
import { renderCard, renderCheckCard, renderCheckFile, renderFile } from './report.js';
import { answerMemory, answerReply, liveView, situationHistory } from './sandbox.js';

const ERROR_MAX = 200;
/** Tokens kept free in a mentor request for the tags and separators around a fitted transcript. */
const FIT_SLACK = 50;

/** The system prompt of the diagnosis; optional (without it a run is saved without a diagnosis). */
const DIAGNOSE_PROMPT = 'mentor-diagnose';

/** The prompt files of each target. */
const PROMPTS = {
  reply: { situations: 'mentor-situations', score: 'mentor-score' },
  memory: { situations: 'mentor-situations-memory', score: 'mentor-score-memory' },
};

/** A positive number from the config, else `fallback` (the config.json default). */
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * How a run ended early: `kind` 'stopped' ('budget' | 'owner' | 'disabled':
 * `features.mentor` or `mentor.model` was turned off during the run) or
 * 'error' (a short reason).
 */
class RunEnd extends Error {
  constructor(kind, reason) {
    super(reason);
    this.kind = kind;
    this.reason = reason;
  }
}

/** Any failure as a RunEnd; `null` for one that must be reported as unexpected. */
function endOf(err) {
  if (err instanceof RunEnd) return err;
  if (err instanceof TokenLimitError || err?.key === 'llm.maxRequestTokens') return new RunEnd('error', 'request over the token cap');
  if (Number.isInteger(err?.statusCode)) return new RunEnd('error', `a model request failed: HTTP ${err.statusCode}`);
  const message = String(err?.message ?? err ?? 'unexpected failure');
  return new RunEnd('error', message.length > ERROR_MAX ? `${message.slice(0, ERROR_MAX - 3)}...` : message);
}

/** Why a diagnosis request failed, as a short fixed reason (never an error's own text). */
function diagnosisFailure(err) {
  if (err instanceof RunEnd && err.kind === 'stopped') {
    if (err.reason === 'owner') return 'stopped by the owner';
    return err.reason === 'budget' ? 'budget' : 'disabled';
  }
  if (err instanceof TokenLimitError || err?.key === 'llm.maxRequestTokens') return 'request over the token cap';
  return 'request failed';
}

/** A median `goal` for comparison: a missing one counts as higher than any score. */
function goalKey(entry) {
  return typeof entry?.goal === 'number' ? entry.goal : Infinity;
}

/**
 * The situation the diagnosis looks at: the one with the lowest median
 * `overall`, whatever its kind (a real moment or an invented situation).
 * Ties: the lower median `goal` (a missing goal counts as higher than any),
 * then a real moment (`n` in `anchorNs`) before an invented one, then the
 * lower `n`. Entries without a numeric `overall` are skipped; null when none
 * is left. Pure.
 * @param {{ n: number, overall: number|null, goal?: number|null }[]} situationMedians
 * @param {Set<number>} [anchorNs]  The `n` of every situation that is a real moment.
 * @returns {object|null}
 */
export function worstSituation(situationMedians, anchorNs = new Set()) {
  const scored = (Array.isArray(situationMedians) ? situationMedians : []).filter((entry) => typeof entry?.overall === 'number');
  const kind = (entry) => (anchorNs.has(entry.n) ? 0 : 1);
  let worst = null;
  for (const entry of scored) {
    if (!worst) {
      worst = entry;
      continue;
    }
    const order = entry.overall - worst.overall || goalKey(entry) - goalKey(worst) || kind(entry) - kind(worst) || entry.n - worst.n;
    if (order < 0) worst = entry;
  }
  return worst;
}

/** Whether a stored situation record is a real moment of the chat (it carries its anchor id). */
function isAnchorRecord(record) {
  return record?.anchor !== undefined && record?.anchor !== null;
}

/** A stored situation as the diagnosis request shows it. */
function worstRecord(record, target) {
  const answers = record.answers.map((a) =>
    target === 'memory'
      ? { id: a.id, texts: a.texts, parseOk: a.parseOk, facts: a.facts, score: a.score }
      : { id: a.id, messages: a.messages, reactions: a.reactions, silent: a.silent, facts: a.facts, score: a.score },
  );
  return { n: record.n, title: record.title, transcript: record.transcript, answers };
}

function emptyMedians() {
  return { human: null, character: null, rules: null, goal: null, overall: null };
}

/**
 * The mentor for one bot. Every value is read at the moment of use:
 * `hot.config.mentor` (`model`, `maxOutputTokens`, `outputTokenWeight`,
 * `timeoutMs`, `situations`, `situationLines`, `samples`, `check.samples`,
 * `pass`, `reference`, `feedbackExamples`, `diagnose`, `anchor.samples`, `anchor.hideLaterMemory`),
 * `hot.config.features.mentor`
 * (must be exactly true; checked at the start, then again before every
 * situation and every mentor request together with `mentor.model`: either
 * one turned off ends the run as `stopped: 'disabled'`),
 * `hot.config.memory.mainChannelIds`, `hot.config.bot.dryRunChannelId`, and
 * the `mentor-*` prompts (`mentor-signs` optional: the `<signs>` block of
 * every mentor request, omitted when missing or empty; `mentor-diagnose`
 * optional: without it a run that needs a diagnosis is saved without one).
 * @param {object} deps
 * @param {{ config: object, prompts: object }} deps.hot
 * @param {object} deps.store             The memory store (read only, through `liveView`).
 * @param {{ complete: Function }} deps.llm
 * @param {{ channels: { fetch: (id: string) => Promise<object|null> } }} deps.client
 * @param {object} deps.cases             From `createCaseStore`.
 * @param {object} deps.budget            From `createMentorBudget`.
 * @param {() => (string|null)} deps.getGuildId
 * @param {() => ({ id: string, name: string }|null)} deps.getSelf  The persona's user id and display name.
 * @param {Function} deps.fetchHistoryWindow  src/discord/collect.js#fetchHistoryWindow.
 * @param {Function} [deps.fetchMoment]  src/discord/collect.js#fetchMoment, for `resolveAnchor`.
 *   Without it no moment can be read.
 * @param {{ ratio: number, apply: (n: number) => number }} [deps.calibrator]  The live calibrator: the
 *   sandboxes measure tokens with its ratio (read at the moment of use) and never feed it.
 *   Without it, tokens are measured as they are.
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.rng]
 * @returns {{ run: (caseId: number) => Promise<{ started: true, done: Promise<object> }>,
 *   check: () => Promise<{ started: true, cases: number, done: Promise<object[]> }>,
 *   resolveAnchor: (ref: string, context?: { channelId?: string }) => Promise<object>,
 *   stop: () => { ok: boolean }, status: () => object, isRunning: () => boolean,
 *   waitIdle: () => Promise<void> }}
 *   A case's anchors (real moments, src/mentor/anchor.js) are situations of their own in a run and
 *   a check: answered from their stored history, numbered first, scored with their `<original>`;
 *   the situations request shows them as `<examples>`.
 *   `run` / `check` reject with an operator-facing Error before anything is spent when the mentor is
 *   off, has no model, the case or a required prompt is missing, a run is in flight or the budget is spent.
 *   `done` never rejects: a failure ends the run with `error`, which is saved and reported.
 */
export function createMentor({ hot, store, llm, client, cases, budget, getGuildId, getSelf, fetchHistoryWindow, fetchMoment, calibrator, now = Date.now, rng = Math.random }) {
  let current = null;

  // ---- guards ----------------------------------------------------------------

  function guard(guildId) {
    const config = hot.config;
    if (config.features?.mentor !== true) throw new Error('the mentor is not enabled (features.mentor)');
    if (!config.mentor?.model) throw new Error('no mentor model is set (mentor.model)');
    if (current) throw new Error('a mentor run is already in flight');
    if (!guildId) throw new Error('the bot serves no guild yet');
  }

  function guardBudget() {
    if (!budget.canSpend(1)) {
      const { used, cap } = budget.snapshot();
      throw new MentorBudgetError(undefined, { used, cap });
    }
  }

  function requirePrompt(name) {
    if (!hot.prompts?.[name]) throw new Error(`mentor prompt missing: ${name}`);
  }

  // ---- the run context -------------------------------------------------------

  function begin(kind, caseIds) {
    const controller = new AbortController();
    current = { kind, caseIds, caseId: caseIds[0] ?? null, controller, signal: controller.signal, spent: 0, phase: 'starting', startedAt: now() };
    return current;
  }

  function checkAborted(ctx) {
    if (ctx.signal.aborted) throw new RunEnd('stopped', 'owner');
  }

  /** The switches, read now: the mentor turned off or its model cleared ends the run. */
  function checkEnabled(config = hot.config) {
    if (config.features?.mentor !== true || !config.mentor?.model) throw new RunEnd('stopped', 'disabled');
  }

  function charge(ctx, usage, estimated) {
    const amount = budget.charge(usage, estimated);
    ctx.spent += amount;
    return amount;
  }

  /**
   * One request to the mentor model: the switches and the budget first (the
   * prompt plus the most the answer may cost, `maxOutputTokens` at
   * `outputTokenWeight`), charged after; an abort ends the run. `as` sends
   * the request for another role through the same rails and budget (the
   * variety pass: its model, role, output cap and timeout); omitted, the
   * mentor's own.
   */
  async function askMentor(ctx, system, user, as = {}) {
    const config = hot.config;
    checkEnabled(config);
    const cfg = config.mentor ?? {};
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    const maxOutputTokens = as.maxOutputTokens ?? cfg.maxOutputTokens;
    const estimate = estimateMessages(messages);
    const outputWeight = Number.isFinite(cfg.outputTokenWeight) && cfg.outputTokenWeight >= 0 ? cfg.outputTokenWeight : 5;
    const possibleOutput = positive(maxOutputTokens, 6000) * outputWeight;
    if (!budget.canSpend(estimate + possibleOutput)) throw new RunEnd('stopped', 'budget');
    checkAborted(ctx);
    let completion;
    try {
      completion = await llm.complete(messages, {
        model: as.model ?? cfg.model,
        role: as.role ?? 'mentor',
        maxOutputTokens,
        timeoutMs: as.timeoutMs ?? cfg.timeoutMs,
        countAgainstDailyCap: false,
        skipCalibration: true,
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal.aborted) throw new RunEnd('stopped', 'owner');
      throw err;
    }
    charge(ctx, completion?.usage ?? null, completion?.estimated ?? estimate);
    return completion?.text ?? '';
  }

  // ---- the reference ---------------------------------------------------------

  /** Ids of the channels to read: `memory.mainChannelIds`, else the stored channel with the most messages. */
  function referenceChannelIds(view) {
    const main = hot.config.memory?.mainChannelIds;
    if (Array.isArray(main) && main.length > 0) return main.map(String);
    const busiest = [...view.memory.listChannels()].sort((a, b) => (b?.messageCount ?? 0) - (a?.messageCount ?? 0))[0];
    return busiest ? [String(busiest.id)] : [];
  }

  /** The channel the situations are set in: the first reference channel, as stored. */
  function sandboxChannel(view, id) {
    const entry = view.memory.listChannels().find((c) => String(c?.id) === id);
    return { id, name: entry?.name || null, category: entry?.category ?? null, topic: entry?.topic ?? null };
  }

  /**
   * The people's messages of the reference channels, measured and sampled. A
   * channel whose window came back empty does not count as readable; no
   * message of people at all ends the run before any request.
   */
  async function readReference(ctx, view, selfId) {
    const config = hot.config;
    const refCfg = config.mentor?.reference ?? {};
    const ids = referenceChannelIds(view);
    if (ids.length === 0) throw new RunEnd('error', 'no readable channel for the reference');
    const limit = Math.max(1, Math.floor(positive(refCfg.maxMessages, 3000) / ids.length));
    const minTs = now() - positive(refCfg.days, 7) * DAY_MS;
    const messages = [];
    let readable = 0;
    for (const id of ids) {
      checkAborted(ctx);
      let channel = null;
      try {
        channel = await client.channels.fetch(id);
      } catch {
        channel = null;
      }
      if (!channel) {
        log.warn('mentor: a reference channel cannot be read', { channel: id });
        continue;
      }
      let window;
      try {
        window = await fetchHistoryWindow(channel, {
          limit,
          minTs,
          selfId,
          embedTextChars: config.media?.embedTextChars,
          videoSites: config.media?.video?.sites,
        });
      } catch (err) {
        log.warn('mentor: a reference channel cannot be read', { channel: id, name: err?.name });
        continue;
      }
      // fetchHistoryWindow logs a failed page and returns [] rather than throwing.
      if (!Array.isArray(window) || window.length === 0) {
        log.warn('mentor: a reference channel gave no messages', { channel: id });
        continue;
      }
      readable += 1;
      for (const message of window) if (!message?.self && !message?.bot) messages.push(message);
    }
    if (readable === 0) throw new RunEnd('error', 'no readable channel for the reference');
    if (messages.length === 0) throw new RunEnd('error', 'the reference is empty');
    const samples = sampleLines(messages, Math.max(0, Math.floor(Number(refCfg.samples ?? 60)) || 0), rng);
    log.info('mentor: reference read', { channels: readable, messages: messages.length, samples: samples.length });
    const profile = styleProfile(messages, { rarePer1000: refCfg.rarePer1000, rareMinAuthors: refCfg.rareMinAuthors });
    return { profile, samples, channel: sandboxChannel(view, ids[0]) };
  }

  // ---- request blocks --------------------------------------------------------

  function feedbackText(guildId) {
    const n = hot.config.mentor?.feedbackExamples ?? 10;
    const list = cases.recentFeedback(guildId, n).map((f) => ({ case: f.caseText, reason: f.reason }));
    return list.length ? JSON.stringify(list) : '';
  }

  /**
   * The blocks every mentor request shares. `signs` is the `mentor-signs`
   * prompt, read now and filled; a missing or empty prompt leaves it out.
   */
  function commonBlocks(item, reference, feedback, selfName) {
    return {
      case: block('case', item.text),
      reference: block('reference', JSON.stringify(reference.profile, null, 1)),
      // One sample per line: a line break inside a sample would read as two samples.
      samples: block('samples', reference.samples.map((s) => s.replace(/\s*\n\s*/g, ' ')).join('\n')),
      signs: block('signs', fillPromptTemplate(hot.prompts?.['mentor-signs'], templateValues(selfName)).trim()),
      feedback: block('feedback', feedback),
    };
  }

  function templateValues(selfName) {
    const cfg = hot.config.mentor ?? {};
    const [minLines, maxLines] = Array.isArray(cfg.situationLines) ? cfg.situationLines : [];
    return { name: selfName, count: cfg.situations, minLines, maxLines };
  }

  // ---- the request budget ----------------------------------------------------

  /**
   * What a mentor request may hold: the per-request token cap the llm client
   * enforces (`llm.maxRequestTokens`) with the talk path's `llm.safetyMargin`.
   */
  function requestLimit() {
    const cfg = hot.config.llm ?? {};
    const margin = Number.isFinite(cfg.safetyMargin) && cfg.safetyMargin > 0 && cfg.safetyMargin <= 1 ? cfg.safetyMargin : 0.9;
    return Math.floor(positive(cfg.maxRequestTokens, 50000) * margin);
  }

  /** A raw token estimate as the llm client's rail measures it (the live calibrator, read now). */
  function calibrated(raw) {
    return typeof calibrator?.apply === 'function' ? calibrator.apply(raw) : raw;
  }

  /** Tokens left in a request of `system` and `user` before `requestLimit`. */
  function roomLeft(system, user) {
    const used = calibrated(
      estimateMessages([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]),
    );
    return requestLimit() - used - FIT_SLACK;
  }

  /**
   * The transcript of `items` within `room` tokens (as `measureText` counts
   * them): the oldest messages are left out until it fits; the last one, the
   * trigger, always stays. `dropped` counts what was left out.
   */
  function fittedTranscript(items, room, measureText = (text) => calibrated(estimateTokens(text))) {
    const timezone = hot.config.bot?.timezone;
    const labels = hot.prompts.labels;
    let start = 0;
    let text = renderTranscript(items, timezone, labels);
    while (start < items.length - 1 && measureText(text) > room) {
      start += 1;
      text = renderTranscript(items.slice(start), timezone, labels);
    }
    return { text, dropped: start };
  }

  /** A label of `labels.mentor`, read now; '' when missing or empty. */
  function mentorLabel(key) {
    const value = hot.prompts.labels?.mentor?.[key];
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * The `<examples>` block of a situations request: every anchor of the case
   * as an `<example>` with its transcript (`<situation>`) and the persona's
   * original answer (`<original>`, one message per line), introduced by
   * `labels.mentor.examples`. Each example gets an equal share of `room`; a
   * transcript over its share loses its oldest messages, never the trigger.
   * '' for a case without anchors.
   */
  function examplesBlock(item, anchors, room, selfName) {
    if (anchors.length === 0) return '';
    const intro = mentorLabel('examples');
    const share = Math.floor((room - calibrated(estimateTokens(intro))) / anchors.length);
    let dropped = 0;
    const examples = anchors.map((situation) => {
      const original = block('original', situation.original.join('\n'));
      const around = calibrated(estimateTokens(block('example', `${block('situation', ' ')}\n${original}`)));
      const fitted = fittedTranscript(transcriptItems(situation.history, selfName, momentMedia(situation)), share - around);
      dropped += fitted.dropped;
      return block('example', [block('situation', fitted.text), original].filter(Boolean).join('\n'));
    });
    if (dropped > 0) log.info('mentor: examples trimmed to the request budget', { caseId: item.id, anchors: anchors.length, dropped });
    return block('examples', [intro, ...examples].filter(Boolean).join('\n'));
  }

  function nameOfIn(view) {
    return (id) => view.memory.getUser(id)?.names?.[0] ?? null;
  }

  /** The learned items as the persona sees them in `<about_chat>`, or ''. */
  function learnedLine(view) {
    if (view.config.features?.memory === false) return '';
    const a = view.prompts.labels?.aboutChat;
    if (!a?.learned) return '';
    const text = learnedText(view.memory.getGuild()?.learned, a, learnedConfig(view.config), nameOfIn(view));
    return text ? fill(a.learned, { text }) : '';
  }

  // ---- steps -----------------------------------------------------------------

  /**
   * One situations request for `item`, `mentor.situations` of them.
   * A case with anchors shows them last, as `<examples>`, fitted to what the
   * request has room for.
   */
  async function inventSituations(ctx, { item, view, reference, feedback, self }) {
    const cfg = hot.config.mentor ?? {};
    const profiles = view.memory.listUserProfiles().filter((p) => p?.id);
    const members = profiles.map((p) => `${p.names?.[0] ?? p.id} (id:${p.id})`).join('\n');
    const blocks = commonBlocks(item, reference, feedback, self.name);
    const system = fillPromptTemplate(hot.prompts[PROMPTS[item.target].situations], templateValues(self.name));
    const parts = [blocks.case, block('members', members), blocks.reference, blocks.samples, blocks.signs, blocks.feedback].filter(Boolean);
    const examples = examplesBlock(item, anchorSituations(item), roomLeft(system, parts.join('\n\n')), self.name);
    const user = [...parts, examples].filter(Boolean).join('\n\n');
    ctx.phase = 'situations';
    const text = await askMentor(ctx, system, user);
    const lines = Array.isArray(cfg.situationLines) ? cfg.situationLines : [6, 15];
    const parsed = parseSituations(text, { knownIds: profiles.map((p) => String(p.id)), lines, count: positive(cfg.situations, 5) });
    const names = new Map(profiles.map((p) => [String(p.id), p.names?.[0] ?? null]));
    // A line without a name gets the member's stored name, as a real message would carry it.
    const situations = parsed.situations.map((s) => ({
      ...s,
      lines: s.lines.map((line) => (line.authorId === 'self' || line.authorName ? line : { ...line, authorName: names.get(line.authorId) ?? line.authorId })),
    }));
    log.info('mentor: situations', { caseId: item.id, kept: situations.length, dropped: parsed.dropped });
    return { situations, dropped: parsed.dropped };
  }

  /**
   * The transcript items of `history` as the persona's chat renders them (see `fittedTranscript`);
   * `media` (a real moment's, see `momentMedia`) renders its media as she saw them.
   */
  function transcriptItems(history, selfName, media = null) {
    const config = hot.config;
    return formatTranscript(history, {
      timezone: config.bot?.timezone,
      gapMinutes: config.context?.gapMarkerMinutes,
      maxChars: config.context?.maxMessageChars,
      selfName,
      labels: hot.prompts.labels,
      mode: 'chat',
      seeReactions: config.features?.seeReactions !== false,
      reactionsPerMessage: config.context?.reactionsPerMessage,
      descriptions: media?.descriptions,
      videos: media?.videos,
    });
  }

  /** The describer's cache of the guild, read only; null when the store or the guild has none. */
  function mediaCacheOf(guildId) {
    if (!guildId || typeof store?.getMediaCache !== 'function') return null;
    return store.getMediaCache(guildId) ?? null;
  }

  /**
   * What the persona saw of a real moment's media (src/mentor/anchor.js#replayMedia): the
   * descriptions stored with its messages, else the describer's cache as it stood when she
   * answered (`situation.at`), read now and never written. `media.video.sites` is read now.
   */
  function momentMedia(situation) {
    return replayMedia(situation.history, {
      cache: mediaCacheOf(getGuildId()),
      sites: hot.config.media?.video?.sites,
      before: Number.isFinite(situation.at) ? situation.at : null,
    });
  }

  /**
   * The channel an anchor is replayed in: its stored entry, else what its
   * trigger carries (the channel as it was at fetch time).
   */
  function anchorChannel(view, history) {
    const trigger = history[history.length - 1] ?? {};
    const id = String(trigger.channelId ?? '');
    const entry = view.memory.listChannels().find((c) => String(c?.id) === id);
    return {
      id,
      name: entry?.name || trigger.channelName || null,
      category: entry?.category ?? trigger.channelCategory ?? null,
      topic: entry?.topic ?? trigger.channelTopic ?? null,
    };
  }

  /** One sandbox answer as the run stores it, with its facts. */
  function answerRecord(answer, id, target, profile) {
    if (target === 'memory') {
      const texts = answer.texts ?? [];
      const facts = answerFacts({ messages: texts.map((t) => ({ text: t.text })) }, profile);
      return { id, texts, parseOk: answer.parseOk === true, facts, score: null };
    }
    const facts = answerFacts({ messages: answer.messages ?? [] }, profile);
    return {
      id,
      messages: (answer.messages ?? []).map((m) => m.text),
      reactions: (answer.reactions ?? []).map((r) => r.emoji),
      silent: Boolean(answer.skip),
      facts,
      score: null,
    };
  }

  /**
   * The variety pass of one reply-target situation, as a live turn runs it
   * (src/behavior/variety.js): the persona's own lines of the situation's
   * history (`variety.window` of them, newest kept, no age limit: the
   * situation's own timeline is what counts), at least `variety.minLines`,
   * sent through `askMentor` on the `classifier.text` model (charged to the
   * mentor's budget, never to the chat's daily cap). Null -- no pass, no
   * block, nothing saved -- with `features.variety` off, no `variety` prompt,
   * too few own lines, a failed request or an answer that is not the expected
   * JSON; a stop or a spent budget ends the run as usual. Logs counts only.
   */
  async function wornFor(ctx, { history, view, record }, self, caseId) {
    const config = view.config;
    const prompt = view.prompts?.variety;
    if (!varietyOn(config) || typeof prompt !== 'string' || !prompt.trim()) return null;
    const settings = varietySettings(config);
    const lines = selectOwnLines({ history, window: settings.window });
    if (lines.length < settings.minLines) return null;
    const request = buildVarietyRequest({ prompt, selfName: self.name, lines, config });
    let text;
    try {
      text = await askMentor(ctx, request.messages[0].content, request.messages[1].content, {
        model: classifierTextModel(config),
        role: 'classifier.text',
        maxOutputTokens: settings.maxOutputTokens,
        timeoutMs: settings.timeoutMs,
      });
    } catch (err) {
      if (err instanceof RunEnd) throw err;
      log.warn('mentor: variety pass failed', { caseId, n: record.n, lines: lines.length, name: err?.name, status: err?.statusCode ?? null });
      return null;
    }
    const parsed = parseVariety(text, request.texts, view.config);
    log.info('mentor: variety pass', { caseId, n: record.n, lines: lines.length, parse: parsed.ok ? 'ok' : 'error', kept: parsed.patterns.length, dropped: parsed.dropped });
    return parsed.ok ? parsed.patterns : null;
  }

  /** Answers every prepared situation on its own view (`entry.view`: a real moment's is filtered to its time). */
  async function answerAll(ctx, { target, prepared, self, reference, caseId = null }) {
    let previous = 1;
    for (const entry of prepared) {
      const { situation, record, history, at, channel, view, media, samples } = entry;
      checkEnabled();
      if (!budget.canSpend(previous)) throw new RunEnd('stopped', 'budget');
      checkAborted(ctx);
      ctx.phase = `answers ${record.n}/${prepared.length}`;
      let charged = 0;
      const onUsage = (usage, estimated) => {
        charged += charge(ctx, usage, estimated);
      };
      // One variety pass per situation, its block shared by every sample; the patterns go on the record.
      const worn = target === 'reply' ? await wornFor(ctx, entry, self, caseId) : null;
      if (worn) record.worn = worn;
      const result =
        target === 'memory'
          ? await answerMemory({ view, batch: history, selfName: self.name, llm, samples, now: at, signal: ctx.signal, onUsage })
          : await answerReply({
              view,
              situation,
              selfId: self.id,
              selfName: self.name,
              channel: channel ?? reference.channel,
              llm,
              samples,
              now: at,
              signal: ctx.signal,
              onUsage,
              descriptions: media?.descriptions,
              videos: media?.videos,
              worn,
            });
      record.answers = result.answers.map((answer, i) => answerRecord(answer, `s${record.n}a${i + 1}`, target, reference.profile));
      // What the persona (or the analyzer) was given, for the diagnosis; kept off the run: it is large.
      entry.request = result.request;
      if (result.stopped || ctx.signal.aborted) throw new RunEnd('stopped', 'owner');
      previous = Math.max(1, charged);
    }
  }

  /**
   * Scores every answer of `records`. The judge's yardstick -- the
   * `<character>`, `<rules>` and `<learned>` blocks -- comes from `view`, the
   * view the answers were made on. A real moment (a record with `anchor`) also carries `<original>`: the
   * persona's original answer, introduced by `labels.mentor.original`. With
   * `items` (the transcript items of each record) a transcript over what the
   * request has room for loses its oldest messages, never the trigger.
   * `judges` maps a record to its own view (a real moment's: the memory as it
   * stood at its time, see src/mentor/moment.js); the `<learned>` block of
   * that record is built from it.
   */
  async function scoreAll(ctx, { target, records, repeated, item, view, judges = new Map(), self, reference, feedback, items = new Map() }) {
    const labels = view.prompts.labels ?? {};
    const intended = Array.isArray(labels.mentor?.intended) ? labels.mentor.intended.filter((s) => typeof s === 'string' && s.trim()) : [];
    const character = target === 'reply' ? block('character', fillPromptTemplate(view.prompts['character-card'], { name: self.name })) : '';
    const rules = block('rules', fillPromptTemplate(view.prompts.rules, { name: self.name }));
    const system = fillPromptTemplate(hot.prompts[PROMPTS[item.target].score], templateValues(self.name));
    const answersTag = target === 'memory' ? 'stored' : 'answers';

    for (const situation of records) {
      if (situation.answers.length === 0) continue;
      const learned = block('learned', learnedLine(judges.get(situation) ?? view));
      let pending = situation.answers.map((a) => a.id);
      // One request with every answer, then once more for the ones the reply left out.
      for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
        ctx.phase = `scores ${situation.n}/${records.length}`;
        const asked = situation.answers.filter((a) => pending.includes(a.id));
        const shown =
          target === 'memory'
            ? asked.map((a) => ({ id: a.id, texts: a.texts, parseOk: a.parseOk }))
            : asked.map((a) => ({ id: a.id, messages: a.messages, reactions: a.reactions, silent: a.silent }));
        const facts = Object.fromEntries(asked.map((a) => [a.id, a.facts]));
        facts.repeated = repeated;
        // Built per request, the re-ask included, so a prompt edited mid-run is read at once.
        const blocks = commonBlocks(item, reference, feedback, self.name);
        const original = isAnchorRecord(situation)
          ? block('original', [mentorLabel('original'), ...(situation.original ?? [])].filter(Boolean).join('\n'))
          : '';
        const before = [blocks.case, blocks.reference, blocks.samples, blocks.signs, block('intended', intended.join('\n')), blocks.feedback, character, rules, learned];
        const after = [original, block(answersTag, JSON.stringify(shown)), block('facts', JSON.stringify(facts))];
        const recordItems = items.get(situation);
        let transcript = situation.transcript;
        if (recordItems) {
          const fitted = fittedTranscript(recordItems, roomLeft(system, [...before, ...after].filter(Boolean).join('\n\n')));
          transcript = fitted.text;
          if (fitted.dropped > 0) log.info('mentor: a situation trimmed to the request budget', { caseId: item.id, n: situation.n, dropped: fitted.dropped });
        }
        const user = [...before, block('situation', transcript), ...after].filter(Boolean).join('\n\n');
        const text = await askMentor(ctx, system, user);
        const { scores, missing } = parseScores(text, pending);
        for (const answer of asked) if (scores.has(answer.id)) answer.score = scores.get(answer.id);
        pending = missing;
      }
    }
  }

  /** The scores of `records` grouped by situation, and the verdict over them (a real moment held to the pass score). */
  function verdictOf(records) {
    // One group per situation, in order, so a situation's place in the verdict is its `n`.
    const groups = records.map((s) => s.answers.map((a) => a.score).filter(Boolean));
    const scores = groups.flat();
    const anchorNs = records.flatMap((s, i) => (isAnchorRecord(s) ? [i + 1] : []));
    return { scores, groups, verdict: verdict(scores, hot.config.mentor?.pass, groups, anchorNs) };
  }

  /**
   * Answer `situations` (invented lines, or anchors from
   * src/mentor/anchor.js#anchorSituations) on `view` (as `item`'s target: the
   * reply or the memory sandbox) with `samples` samples each, a real moment with
   * `anchorSamples` (default: `samples`; a run and a check pass
   * `mentor.anchor.samples`), then score every answer: the one measuring
   * step of a run and a check. A real moment is answered and judged on
   * `view` as it stood before its trigger (src/mentor/moment.js#momentView:
   * memory written at or after it hidden) unless
   * `mentor.anchor.hideLaterMemory` is false (read now); a run and a check
   * alike go through here. `hidden` counts what was hidden, by
   * kind, and the moments it was hidden for (`situations`). Throws what the
   * steps throw (a stop, a failed request); `into` receives `records`,
   * `prepared`, `hidden` and `repeated` as soon as each exists, so a caller
   * keeps what was measured before the throw.
   * @returns {Promise<{ records: object[], scores: object[], groups: object[][], verdict: object,
   *   repeated: object[], prepared: object[], hidden: object }>}
   */
  async function measureOn(ctx, { item, view, situations, samples, anchorSamples = samples, reference, feedback, self, into = {} }) {
    const timezone = hot.config.bot?.timezone;
    const hideLater = hot.config.mentor?.anchor?.hideLaterMemory !== false;
    const hidden = { situations: 0 };
    const prepared = situations.map((situation, i) => {
      // A real moment (see src/mentor/anchor.js) is replayed from its stored history, at its own time and channel.
      const anchored = Array.isArray(situation?.history);
      const at = anchored && Number.isFinite(situation.at) ? situation.at : now();
      const { history } = situationHistory(situation, { selfId: self.id, selfName: self.name, now: at, channel: reference.channel });
      // A real moment's media render as she saw them, in its transcript and in her request alike.
      const media = anchored ? momentMedia(situation) : null;
      const items = transcriptItems(history, self.name, media);
      const transcript = renderTranscript(items, timezone, hot.prompts.labels);
      const record = anchored
        ? { n: i + 1, title: situation.title ?? '', anchor: situation.anchor, original: situation.original ?? [], transcript, answers: [] }
        : { n: i + 1, title: situation.title ?? '', lines: situation.lines, transcript, answers: [] };
      // A real moment sees the memory as it stood before its trigger (src/mentor/moment.js), the judge too.
      const cutoff = anchored && hideLater ? momentCutoff(situation) : null;
      const entry = {
        situation,
        record,
        history,
        items,
        media,
        at,
        samples: anchored ? anchorSamples : samples,
        channel: anchored ? anchorChannel(view, history) : reference.channel,
        view,
      };
      if (cutoff !== null) {
        entry.view = momentView(view, cutoff);
        hidden.situations += 1;
        for (const [kind, count] of Object.entries(hiddenLater(view, cutoff))) hidden[kind] = (hidden[kind] ?? 0) + count;
      }
      return entry;
    });
    const records = prepared.map((p) => p.record);
    into.prepared = prepared;
    into.records = records;
    into.hidden = hidden;
    await answerAll(ctx, { target: item.target, prepared, self, reference, caseId: item.id });
    let repeated = [];
    if (item.target === 'reply') {
      // Tagged with their situation: a phrase shared only by the samples of one situation is no habit.
      const all = records.flatMap((s) => s.answers.map((a) => ({ situation: s.n, messages: a.messages.map((text) => ({ text })) })));
      repeated = repeatedPhrases(all);
    }
    into.repeated = repeated;
    const items = new Map(prepared.map((p) => [p.record, p.items]));
    const judges = new Map(prepared.map((p) => [p.record, p.view]));
    await scoreAll(ctx, { target: item.target, records, repeated, item, view, judges, self, reference, feedback, items });
    return { records, ...verdictOf(records), repeated, prepared, hidden };
  }

  // ---- the diagnosis ---------------------------------------------------------

  /**
   * Whether a finished run gets a diagnosis: a run (not a check) that ended
   * normally, with `mentor.diagnose` on (a missing key counts as on), that
   * failed or has a situation whose median `overall` is under the pass score.
   */
  function needsDiagnosis(run) {
    if (run.kind !== 'run' || run.stopped || run.error) return false;
    const cfg = hot.config.mentor ?? {};
    if (cfg.diagnose === false) return false;
    const passScore = Number.isFinite(cfg.pass?.score) ? cfg.pass.score : 7;
    return !run.passed || run.situationMedians.some((m) => typeof m?.overall === 'number' && m.overall < passScore);
  }

  /**
   * One mentor request for its opinion of the worst situation: what it thinks
   * caused the failure and what it would change. Sets `run.diagnosis`; on any
   * failure `run.diagnosis` is null and `run.diagnosisError` a short reason.
   * Never throws: the run is measured already.
   */
  async function diagnose(ctx, run, item, measured) {
    const { reference, feedback, self, prepared } = measured;
    const fail = (reason) => {
      run.diagnosis = null;
      run.diagnosisError = reason;
      log.warn('mentor: diagnosis failed', { caseId: item.id, reason });
    };
    const template = hot.prompts?.[DIAGNOSE_PROMPT];
    if (typeof template !== 'string' || !template.trim()) return fail('prompt missing');
    const anchorNs = new Set(run.situations.filter(isAnchorRecord).map((s) => s.n));
    const worst = worstSituation(run.situationMedians, anchorNs);
    const entry = worst ? prepared.find((p) => p.record.n === worst.n) : null;
    if (!entry?.request) return fail('no situation to diagnose');
    let text;
    try {
      const blocks = commonBlocks(item, reference, feedback, self.name);
      const verdictJson = { passed: run.passed, medians: run.medians, situations: run.situationMedians, reasons: run.reasons };
      const seen = [block('system', entry.request.system), block('user', entry.request.user)].filter(Boolean).join('\n');
      const system = fillPromptTemplate(template, templateValues(self.name));
      const before = [blocks.case, block('verdict', JSON.stringify(verdictJson)), blocks.signs, blocks.feedback];
      const after = [block('seen', seen)];
      const shown = worstRecord(entry.record, run.target);
      if (entry.items) {
        // The transcript is the part of <worst> that grows with a real moment: it gives way first.
        const room = roomLeft(system, [...before, ...after].filter(Boolean).join('\n\n')) - calibrated(estimateTokens(JSON.stringify({ ...shown, transcript: '' })));
        shown.transcript = fittedTranscript(entry.items, room, (t) => calibrated(estimateTokens(JSON.stringify(t)))).text;
      }
      const user = [...before, block('worst', JSON.stringify(shown)), ...after].filter(Boolean).join('\n\n');
      ctx.phase = 'diagnosis';
      text = await askMentor(ctx, system, user);
    } catch (err) {
      return fail(diagnosisFailure(err));
    }
    const diagnosis = parseDiagnosis(text);
    if (!diagnosis) return fail('invalid answer');
    run.diagnosis = diagnosis;
    log.info('mentor: diagnosis', { caseId: item.id, causes: diagnosis.causes.length, changes: diagnosis.changes.length });
  }

  // ---- one case --------------------------------------------------------------

  /**
   * One case measured from start to end; never throws. `shared` carries what
   * a check reuses across its cases (the reference). `stored` holds the
   * situations a check replays; a run invents new ones.
   */
  async function measure(ctx, guildId, item, { kind, samples, anchorSamples, stored, shared }) {
    const config = hot.config;
    const startedMs = now();
    const spentBefore = ctx.spent;
    ctx.caseId = item.id;
    const run = {
      caseId: item.id,
      caseText: item.text,
      target: item.target,
      kind,
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: null,
      models: {
        mentor: config.mentor?.model ?? null,
        talk: config.llm?.model ?? null,
        analyzer: config.memory?.model ?? config.llm?.model ?? null,
      },
      reference: { profile: null, samples: 0 },
      situations: [],
      dropped: 0,
      repeated: [],
      medians: emptyMedians(),
      situationMedians: [],
      passed: false,
      reasons: [],
      tokens: { spent: 0, left: 0 },
    };
    log.info('mentor: run started', { kind, caseId: item.id, target: item.target, anchors: Array.isArray(item.anchors) ? item.anchors.length : 0 });
    // What the diagnosis needs once the run is measured; set only when scoring finished.
    let measured = null;
    // What measureOn built before a stop or a failure: the run keeps the situations answered so far.
    const into = {};

    try {
      const self = getSelf();
      if (!self?.id) throw new RunEnd('error', 'the bot user is not ready');
      const view = liveView({ hot, store, guildId, calibrator });
      if (!shared.reference) {
        ctx.phase = 'reference';
        shared.reference = await readReference(ctx, view, self.id);
      }
      const reference = shared.reference;
      run.reference = { profile: reference.profile, samples: reference.samples.length };
      const feedback = feedbackText(guildId);

      let situations = stored;
      if (kind === 'run') {
        // The case's real moments first, then the invented situations: `n` continues after the anchors.
        const anchored = anchorSituations(item);
        const invented = await inventSituations(ctx, { item, view, reference, feedback, self });
        run.dropped = invented.dropped;
        situations = [...anchored, ...invented.situations];
        if (situations.length === 0) throw new RunEnd('error', 'no valid situation');
      }

      const done = await measureOn(ctx, { item, view, situations, samples, anchorSamples, reference, feedback, self, into });
      if (!done.records.some((s) => s.answers.some((a) => a.score))) throw new RunEnd('error', 'no answer was scored');
      measured = { reference, feedback, self, prepared: done.prepared };
    } catch (err) {
      const end = endOf(err);
      if (!(err instanceof RunEnd)) log.warn('mentor: the run failed', { caseId: item.id, name: err?.name, status: err?.statusCode });
      if (end.kind === 'stopped') run.stopped = end.reason;
      else run.error = end.reason;
    }
    if (into.records) run.situations = into.records;
    if (into.repeated) run.repeated = into.repeated;
    // Counts only: how much later memory the real moments were answered without.
    if (into.hidden?.situations > 0) log.info('mentor: later memory hidden', { kind, caseId: item.id, ...into.hidden });

    const { scores, verdict: result } = verdictOf(run.situations);
    run.medians = result.medians;
    run.situationMedians = result.situations;
    run.reasons = result.reasons;
    run.passed = !run.stopped && !run.error && result.passed;
    if (measured && needsDiagnosis(run)) await diagnose(ctx, run, item, measured);
    run.finishedAt = new Date(now()).toISOString();
    run.tokens = { spent: ctx.spent - spentBefore, left: budget.left() };

    let saved = run;
    try {
      saved = cases.saveRun(guildId, run);
    } catch (err) {
      log.error('mentor: the run could not be saved', { caseId: item.id, name: err?.name });
    }
    const answers = run.situations.reduce((n, s) => n + s.answers.length, 0);
    log.info('mentor: run finished', {
      kind,
      caseId: item.id,
      runId: saved.id ?? null,
      passed: run.passed,
      stopped: run.stopped ?? null,
      failed: Boolean(run.error),
      situations: run.situations.length,
      dropped: run.dropped,
      answers,
      scored: scores.length,
      tokens: run.tokens.spent,
      tokensLeft: run.tokens.left,
      durationMs: now() - startedMs,
    });
    return saved;
  }

  // ---- the report ------------------------------------------------------------

  /**
   * Posts the report to the admin channel when one is configured. Without one
   * this is the normal state: the run is already saved and the owner reads it
   * through `/nep mentor status` and `/nep mentor show`, so nothing is posted
   * and nothing is warned about. Only a configured channel that fails warns.
   */
  async function post(content, file, meta) {
    const channelId = hot.config.bot?.dryRunChannelId || '';
    if (!channelId) {
      log.info('mentor: report saved', meta);
      return;
    }
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) throw new Error('the admin channel was not found');
      await channel.send({
        content,
        files: [{ attachment: Buffer.from(file.text, 'utf8'), name: file.name }],
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      log.warn('mentor: the report could not be posted', { ...meta, name: err?.name, status: err?.statusCode });
    }
  }

  /** Runs `work` in the background; `current` is released whatever happens. Kept as `ctx.done`. */
  function background(ctx, work, fallback) {
    ctx.done = (async () => {
      try {
        return await work();
      } catch (err) {
        log.error('mentor: unexpected failure', { kind: ctx.kind, error: err });
        return fallback;
      } finally {
        if (current === ctx) current = null;
      }
    })();
    return ctx.done;
  }

  // ---- the API ---------------------------------------------------------------

  /**
   * Measure one case: invent situations, answer them in the sandbox, score,
   * save, report. Resolves at once with `{ started: true, done }`.
   * @param {number} caseId
   */
  async function run(caseId) {
    const guildId = getGuildId();
    guard(guildId);
    const item = cases.get(guildId, caseId);
    if (!item) throw new Error(`no case ${caseId}`);
    if (item.state === 'retired') throw new Error(`case ${item.id} is retired`);
    const prompts = PROMPTS[item.target];
    if (!prompts) throw new Error(`case ${item.id} has an unknown target`);
    requirePrompt(prompts.situations);
    requirePrompt(prompts.score);
    guardBudget();

    const ctx = begin('run', [item.id]);
    const done = background(
      ctx,
      async () => {
        const samples = positive(hot.config.mentor?.samples, 3);
        const anchorSamples = positive(hot.config.mentor?.anchor?.samples, 5);
        const saved = await measure(ctx, guildId, item, { kind: 'run', samples, anchorSamples, stored: [], shared: {} });
        await post(renderCard(saved), renderFile(saved), { caseId: item.id });
        return saved;
      },
      null,
    );
    return { started: true, done };
  }

  /**
   * Replay every active case's anchors (as the case holds them now) and the
   * invented situations of its last run with
   * `mentor.check.samples` samples (a real moment with `mentor.anchor.samples`), no new situations; one run of kind
   * 'check' saved per case and one combined card. Resolves at once with
   * `{ started: true, cases, done }`.
   */
  async function check() {
    const guildId = getGuildId();
    guard(guildId);
    const plan = [];
    const skipped = [];
    for (const item of cases.list(guildId)) {
      const anchored = anchorSituations(item);
      let last = null;
      try {
        last = cases.lastRun(guildId, item.id);
      } catch {
        skipped.push({ caseId: item.id, reason: 'its last run cannot be read' });
        continue;
      }
      if (!last && anchored.length === 0) {
        skipped.push({ caseId: item.id, reason: 'never run' });
        continue;
      }
      // The case's real moments as they are stored now, then the invented situations of its last run.
      const invented = (Array.isArray(last?.situations) ? last.situations : [])
        .filter((s) => !isAnchorRecord(s) && Array.isArray(s?.lines) && s.lines.length > 0)
        .map((s) => ({ title: s.title ?? '', lines: s.lines }));
      const situations = [...anchored, ...invented];
      if (situations.length === 0) {
        skipped.push({ caseId: item.id, reason: 'no stored situations' });
        continue;
      }
      plan.push({ item, situations });
    }
    if (plan.length === 0) throw new Error('no case has a run to check');
    for (const { item } of plan) {
      if (!PROMPTS[item.target]) throw new Error(`case ${item.id} has an unknown target`);
      requirePrompt(PROMPTS[item.target].score);
    }
    guardBudget();

    const ctx = begin('check', plan.map((p) => p.item.id));
    const done = background(
      ctx,
      async () => {
        const runs = [];
        const shared = {};
        for (const { item, situations } of plan) {
          const last = runs[runs.length - 1];
          if (last?.stopped === 'owner' || ctx.signal.aborted) {
            skipped.push({ caseId: item.id, reason: 'stopped by the owner' });
            continue;
          }
          if (last?.stopped === 'disabled') {
            skipped.push({ caseId: item.id, reason: 'the mentor was disabled' });
            continue;
          }
          if (last?.stopped === 'budget') {
            skipped.push({ caseId: item.id, reason: 'budget' });
            continue;
          }
          const samples = positive(hot.config.mentor?.check?.samples, 1);
          const anchorSamples = positive(hot.config.mentor?.anchor?.samples, 5);
          runs.push(await measure(ctx, guildId, item, { kind: 'check', samples, anchorSamples, stored: situations, shared }));
        }
        await post(renderCheckCard(runs, skipped), renderCheckFile(runs, now()), { cases: runs.length, skipped: skipped.length });
        return runs;
      },
      [],
    );
    return { started: true, cases: plan.length, done };
  }

  /**
   * Read one moment of the chat for a case (src/mentor/anchor.js#resolveAnchor):
   * `ref` is a message link or id (a bare id means `context.channelId`);
   * `mentor.anchor.contextMessages` and the media settings are read now.
   * Each message keeps what the persona saw of its media: the describer's
   * captions and watched summaries cached by the time she answered, read
   * from the store's media cache and never written. Spends no tokens and
   * needs no switch; rejects with an operator-facing Error when the moment
   * is refused. Logs counts only.
   * @param {string} ref
   * @param {{ channelId?: string|null }} [context]
   * @returns {Promise<{ channelId: string, messageId: string, triggerId: string, history: object[], original: string[],
   *   media: { described: number, none: number } }>}
   */
  async function readAnchor(ref, { channelId } = {}) {
    const guildId = getGuildId();
    if (!guildId) throw new Error('the bot serves no guild yet');
    const self = getSelf();
    if (!self?.id) throw new Error('the bot user is not ready');
    if (typeof fetchMoment !== 'function') throw new Error('reading a moment is not available');
    const config = hot.config;
    const anchor = await resolveAnchor({
      ref,
      guildId,
      contextChannelId: channelId ?? null,
      selfId: self.id,
      client,
      fetchMoment,
      limit: Math.floor(positive(config.mentor?.anchor?.contextMessages, 30)),
      embedTextChars: config.media?.embedTextChars,
      videoSites: config.media?.video?.sites,
      mediaCache: mediaCacheOf(guildId),
    });
    log.info('mentor: moment read', {
      messages: anchor.history.length,
      original: anchor.original.length,
      mediaDescribed: anchor.media.described,
      mediaWithout: anchor.media.none,
    });
    return anchor;
  }

  /** Abort the request in flight; the run ends as `stopped: 'owner'`. */
  function stop() {
    if (!current) return { ok: false };
    current.controller.abort();
    return { ok: true };
  }

  /**
   * Resolves once nothing runs: at once when idle, else when the run in
   * flight has ended (saved and reported). Never rejects. `/nep pause` calls
   * it after `stop()`.
   * @returns {Promise<void>}
   */
  function waitIdle() {
    return current ? current.done.then(() => undefined) : Promise.resolve();
  }

  /** What is running right now, for `/nep mentor status`. */
  function status() {
    if (!current) return { running: false };
    return {
      running: true,
      kind: current.kind,
      caseId: current.caseId,
      caseIds: [...current.caseIds],
      phase: current.phase,
      startedAt: new Date(current.startedAt).toISOString(),
      tokens: current.spent,
      stopping: current.signal.aborted,
    };
  }

  return { run, check, resolveAnchor: readAnchor, stop, status, waitIdle, isRunning: () => current !== null };
}
