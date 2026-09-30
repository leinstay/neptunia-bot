// The mentor's repair loop. A failed run ends with a diagnosis: the mentor
// model's unverified opinion of which piece of the persona's context caused
// the weak answers. This loop turns that opinion into at most one change,
// and only one that was measured to help:
//
//   1. ablation -- a suspect is proven by answering the weak situations again
//      WITHOUT that piece (an overlay view, nothing written) and measuring the
//      gain; a `missing` cause has nothing to remove and counts as proven;
//   2. edit -- the mentor model is asked for ONE edit against the proven cause
//      (the `mentor-fix` prompt), checked against what an edit may touch;
//   3. verification -- the edit, again only on an overlay, must pass fresh
//      situations of the same case and must not drop any other case's stored
//      situations by more than the tolerance;
//   4. apply -- only then the change store writes it, recorded for undo.
//
// An attempt that proves nothing, whose edit is refused, or that fails its
// verification moves on to the next suspects, up to `mentor.fix.maxAttempts`.
// Every request goes through the run's own helpers (src/mentor/mentor.js), so
// the switches, the mentor budget, the owner's stop and the charging are the
// run's; a stop ends the loop with what it has and never touches the measured
// run. Nothing is written unless `features.mentorAutoFix` is exactly true at
// the moment of the write.

import { fillPromptTemplate } from '../behavior/prompt.js';
import { log } from '../log.js';
import { ablationEdits, gainOf } from './ablate.js';
import { parseEdit, verdict } from './judge.js';
import { editToOverlay, overlayView } from './overlay.js';

const FIX_PROMPT = 'mentor-fix';
/** Every layer an answer may name: parsed with all of them so a closed layer is refused with its reason. */
const EDIT_LAYERS = ['rules', 'prompt', 'card', 'self', 'learned', 'guild', 'profile'];
/** The layers an edit may touch at most (never the card), and the config.json default. */
const OPEN_LAYERS = ['rules', 'prompt', 'self', 'learned', 'guild', 'profile'];
const DEFAULT_FILES = ['rules', 'system-prompt', 'format', 'reply', 'interject', 'initiate', 'address', 'memory', 'profile'];
/**
 * The memory writer's prompts. An edit there cannot change a reply (no reply
 * situation could verify it), and a memory case can be verified only by an
 * edit there.
 */
const WRITER_FILES = new Set(['memory', 'profile', 'server', 'channel']);
/** Layers whose pieces an edit may rewrite but never delete. */
const NO_DELETION = new Set(['rules', 'prompt', 'profile']);
/** Layers held to `mentor.fix.maxGrowthChars`. */
const GROWTH_CAPPED = new Set(['rules', 'prompt']);
/** The longest note about the persona or in-joke an edit may write. */
const ITEM_MAX = 200;
/** How `failureOf` names a stop (the switches, the budget, the owner): not a failure worth a warning. */
const STOPS = new Set(['budget', 'disabled', 'stopped by the owner']);

/** Wrap `body` in `<tag>`; '' for an empty body (the run's request builders do the same). */
function block(tag, body) {
  return body ? `<${tag}>\n${body}\n</${tag}>` : '';
}

/** A positive integer from the config, else `fallback`. */
function count(value, fallback) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/** A non-negative number from the config, else `fallback`. */
function amount(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** A prompt file name without a trailing `.md`. */
function promptName(value) {
  return typeof value === 'string' ? value.trim().replace(/\.md$/i, '') : '';
}

/** Length in characters (code points), as the memory store counts them. */
function length(text) {
  return [...String(text ?? '')].length;
}

/**
 * The loop's settings, read now from the live config. What an edit may touch
 * depends on the case's `target`: a memory case only the `prompt` layer and
 * only the memory writer's files of `mentor.fix.files`; any other case every
 * allowed layer and the files that are not the memory writer's.
 */
function settings(config, target) {
  const mentor = config.mentor ?? {};
  const fix = mentor.fix ?? {};
  let layers = Array.isArray(fix.layers) ? fix.layers.filter((layer) => OPEN_LAYERS.includes(layer)) : OPEN_LAYERS;
  let files = (Array.isArray(fix.files) ? fix.files : DEFAULT_FILES).map(promptName).filter(Boolean);
  if (target === 'memory') {
    layers = layers.filter((layer) => layer === 'prompt');
    files = files.filter((file) => WRITER_FILES.has(file));
  } else {
    files = files.filter((file) => !WRITER_FILES.has(file));
  }
  return {
    suspects: count(mentor.suspects, 2),
    ablationGain: Number.isFinite(mentor.ablationGain) ? mentor.ablationGain : 1,
    ablationSamples: count(mentor.ablationSamples, 2),
    maxAttempts: count(fix.maxAttempts, 3),
    maxGrowthChars: amount(fix.maxGrowthChars, 300),
    layers: [...new Set(layers)],
    files: [...new Set(files)],
    verifySituations: count(mentor.verify?.situations, 3),
    verifySamples: count(mentor.verify?.samples, 2),
    regressionSituations: count(mentor.regression?.situations, 2),
    tolerance: amount(mentor.regression?.tolerance, 1),
    passScore: Number.isFinite(mentor.pass?.score) ? mentor.pass.score : 7,
    learnedChars: count(config.memory?.learnedChars, 160),
  };
}

/** Ends the loop with a fixed reason (not a failure of the run). */
class LoopEnd extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * The diagnosis's causes as suspects, in order. A cause gets `ref` from the
 * first proposed change of the same layer: its `target` without `.md` for a
 * prompt, the member id of `<userId>.<field>` for a profile.
 */
function suspectsOf(diagnosis) {
  const changes = Array.isArray(diagnosis?.changes) ? diagnosis.changes : [];
  return (Array.isArray(diagnosis?.causes) ? diagnosis.causes : []).map((cause) => {
    const suspect = { layer: cause.layer, excerpt: cause.excerpt ?? '', why: cause.why ?? '' };
    const target = changes.find((change) => change?.layer === cause.layer)?.target;
    if (cause.layer === 'prompt' && promptName(target)) suspect.ref = promptName(target);
    if (cause.layer === 'profile' && typeof target === 'string') {
      const id = target.trim().split('.')[0];
      if (/^\d+$/.test(id)) suspect.ref = id;
    }
    return suspect;
  });
}

/**
 * The situations an ablation replays: those of the run whose median
 * `overall` is under the pass score, all of them when none is; and the
 * verdict of the run's own scores over exactly those ("before").
 */
function weakOf(run, passScore, passCfg) {
  const weak = new Set((run.situationMedians ?? []).filter((m) => typeof m?.overall === 'number' && m.overall < passScore).map((m) => m.n));
  const records = (run.situations ?? []).filter((s) => (weak.size === 0 || weak.has(s.n)) && Array.isArray(s.lines) && s.lines.length > 0);
  const groups = records.map((s) => (s.answers ?? []).map((a) => a.score).filter(Boolean));
  return { situations: records.map((s) => ({ title: s.title ?? '', lines: s.lines })), before: verdict(groups.flat(), passCfg, groups) };
}

/** Why an edit may not be made, by the loop's own limits; null when it may. */
function refusalOf(edit, cfg) {
  if (!cfg.layers.includes(edit.layer)) return 'layer not allowed';
  if (edit.layer === 'prompt' && !cfg.files.includes(edit.target)) return 'file not allowed';
  if (NO_DELETION.has(edit.layer) && !edit.to.trim()) return 'deletion not allowed';
  if (GROWTH_CAPPED.has(edit.layer) && length(edit.to) - length(edit.from) > cfg.maxGrowthChars) return 'growth over the cap';
  if (edit.layer === 'learned' && length(edit.to.trim()) > cfg.learnedChars) return 'text too long';
  const item = edit.layer === 'self' || (edit.layer === 'guild' && edit.target === 'injokes');
  if (item && length(edit.to.trim()) > ITEM_MAX) return 'text too long';
  return null;
}

/**
 * The repair loop for one mentor. Every value is read at the moment of use:
 * `hot.config.features.mentorAutoFix` (checked before every attempt and
 * before the write), `hot.config.mentor` (`suspects`, `ablationGain`,
 * `ablationSamples`, `fix.maxAttempts`, `fix.maxGrowthChars`, `fix.layers`
 * -- the card is never allowed --, `fix.files` -- narrowed by the case's
 * target: a reply case never edits the memory writer's prompts (`memory`,
 * `profile`, `server`, `channel`), a memory case edits only those and only
 * through the `prompt` layer --, `verify.situations`,
 * `verify.samples`, `regression.situations`, `regression.tolerance`,
 * `pass`), `hot.config.memory.learnedChars` and the `mentor-fix` prompt.
 * @param {object} deps
 * @param {{ config: object, prompts: object }} deps.hot
 * @param {object} deps.cases              From `createCaseStore` (other cases and their last runs, read only).
 * @param {{ apply: Function }} deps.changes  From `createChangeStore`.
 * @param {(guildId: string) => object} deps.baseView  The live view of the guild (src/mentor/sandbox.js#liveView).
 * @param {Function} deps.measureOn        mentor.js: answer situations on a view and score them.
 * @param {Function} deps.askMentor        mentor.js: one checked, charged request to the mentor model.
 * @param {Function} deps.inventSituations mentor.js: one situations request.
 * @param {Function} deps.commonBlocks     mentor.js: the blocks every mentor request shares.
 * @param {(selfName: string) => object} deps.templateValues  mentor.js: the placeholders of the mentor prompts.
 * @param {(target: string) => boolean} deps.canScore  Whether a case of this target can be scored now.
 * @param {(err: unknown) => string} deps.failureOf  A stop or a failure as a short fixed reason.
 * @returns {{ attempt: (ctx: object, run: object, input: { guildId: string, item: object, reference: object,
 *   feedback: string, self: { id: string, name: string }, seen: string }) => Promise<object> }}
 *   `attempt` runs the whole loop for a failed run and resolves with its record (never rejects):
 *   `{ attempts: [{ n, suspects: [{ layer, excerpt, located, gain, confirmed }], edit, refused,
 *   verify: { fresh, regression: [{ caseId, held, situations: [{ n, before, after }] }], skipped } | null,
 *   accepted }], applied: { changeId, layer, target, summary } | null, reason, tokens }`.
 */
export function createRepair({ hot, cases, changes, baseView, measureOn, askMentor, inventSituations, commonBlocks, templateValues, canScore, failureOf }) {
  /** Stop when the switch of the loop (or of the mentor) is off now. */
  function checkSwitch() {
    const features = hot.config.features ?? {};
    if (features.mentorAutoFix !== true || features.mentor !== true) throw new LoopEnd('disabled');
  }

  /** One suspect removed and measured; a `missing` cause is proven without it. */
  async function ablate(ctx, suspect, { base, item, weak, input, cfg, n }) {
    const shown = { layer: suspect.layer, excerpt: suspect.excerpt };
    if (suspect.layer === 'missing') return { ...shown, located: null, gain: null, confirmed: true };
    // A `ref` taken from a change aimed at another cause of the same layer must not hide the excerpt.
    const edits = ablationEdits(suspect, base) ?? (suspect.ref ? ablationEdits({ ...suspect, ref: undefined }, base) : null);
    if (!edits) return { ...shown, located: false, gain: null, confirmed: false };
    const phase = `repair ${n}: ablation`;
    ctx.phase = phase;
    const measured = await measureOn(ctx, {
      item,
      view: overlayView(base, edits),
      situations: weak.situations,
      samples: cfg.ablationSamples,
      reference: input.reference,
      feedback: input.feedback,
      self: input.self,
      phase,
    });
    const gain = gainOf(weak.before, measured.verdict);
    return { ...shown, located: true, gain, confirmed: typeof gain === 'number' && gain >= cfg.ablationGain };
  }

  /** The mentor's one edit against a proven cause, parsed; null for an answer that is no edit. */
  async function askEdit(ctx, run, { item, input, suspect, gain, cfg, n }) {
    ctx.phase = `repair ${n}: edit`;
    const template = hot.prompts?.[FIX_PROMPT];
    if (typeof template !== 'string' || !template.trim()) throw new LoopEnd('prompt missing');
    const blocks = commonBlocks(item, input.reference, input.feedback, input.self.name);
    const verdictJson = { passed: run.passed, medians: run.medians, situations: run.situationMedians, reasons: run.reasons };
    const cause = { layer: suspect.layer, excerpt: suspect.excerpt, why: suspect.why, gain };
    const allowed = { layers: cfg.layers, files: cfg.files, maxGrowthChars: cfg.maxGrowthChars };
    const user = [
      blocks.case,
      block('verdict', JSON.stringify(verdictJson)),
      blocks.signs,
      blocks.feedback,
      block('cause', JSON.stringify(cause)),
      block('seen', input.seen),
      block('allowed', JSON.stringify(allowed)),
    ]
      .filter(Boolean)
      .join('\n\n');
    const text = await askMentor(ctx, fillPromptTemplate(template, templateValues(input.self.name)), user);
    const edit = parseEdit(text, EDIT_LAYERS);
    if (edit?.layer === 'prompt') edit.target = promptName(edit.target);
    return edit;
  }

  /** The regression of one other case on the edited view, or a reason to skip it (null: not in scope). */
  async function regressionOf(ctx, other, { guildId, view, input, cfg, phase }) {
    let last;
    try {
      last = cases.lastRun(guildId, other.id);
    } catch {
      return { skipped: true };
    }
    const stored = (Array.isArray(last?.situations) ? last.situations : []).filter((s) => Array.isArray(s?.lines) && s.lines.length > 0);
    if (stored.length === 0) return null;
    const medians = Array.isArray(last.situationMedians) ? last.situationMedians : [];
    if (medians.length === 0 || !canScore(other.target)) return { skipped: true };
    const replay = stored.slice(0, cfg.regressionSituations);
    const measured = await measureOn(ctx, {
      item: other,
      view,
      situations: replay.map((s) => ({ title: s.title ?? '', lines: s.lines })),
      samples: 1,
      reference: input.reference,
      feedback: input.feedback,
      self: input.self,
      phase,
    });
    const situations = replay.map((s, i) => {
      const n = Number.isInteger(s.n) ? s.n : i + 1;
      const before = medians.find((m) => m?.n === n)?.overall;
      const after = measured.verdict.situations.find((m) => m.n === i + 1)?.overall;
      return { n, before: typeof before === 'number' ? before : null, after: typeof after === 'number' ? after : null };
    });
    // A situation with no stored median has nothing to hold to; one left unscored now does not hold.
    const held = situations.every((s) => s.before === null || (s.after !== null && s.after >= s.before - cfg.tolerance));
    return { entry: { caseId: other.id, held, situations } };
  }

  /** Fresh situations of the case, then every other case's stored ones, on the edited view. True when both hold. */
  async function verifyEdit(ctx, { guildId, item, view, input, cfg, n, verify }) {
    const phase = `repair ${n}: verify`;
    ctx.phase = phase;
    const invented = await inventSituations(ctx, { item, view, reference: input.reference, feedback: input.feedback, self: input.self, count: cfg.verifySituations, phase });
    const fresh =
      invented.situations.length > 0
        ? (await measureOn(ctx, { item, view, situations: invented.situations, samples: cfg.verifySamples, reference: input.reference, feedback: input.feedback, self: input.self, phase })).verdict
        : verdict([], hot.config.mentor?.pass, []);
    verify.fresh = { passed: fresh.passed, medians: fresh.medians, situations: fresh.situations };
    if (!fresh.passed) return false;

    const regressionPhase = `repair ${n}: regression`;
    ctx.phase = regressionPhase;
    for (const other of cases.list(guildId)) {
      if (other.id === item.id) continue;
      const result = await regressionOf(ctx, other, { guildId, view, input, cfg, phase: regressionPhase });
      if (!result) continue;
      if (result.skipped) {
        verify.skipped.push(other.id);
        continue;
      }
      verify.regression.push(result.entry);
      if (!result.entry.held) return false;
    }
    return true;
  }

  /**
   * The whole loop for a failed run, after its diagnosis. Never rejects and
   * never changes the run: it resolves with the loop's record, which the run
   * stores as `repair`.
   * @param {object} ctx  The run context (signal, spent, phase).
   * @param {object} run  The measured run, with `diagnosis`.
   * @param {{ guildId: string, item: object, reference: object, feedback: string,
   *   self: { id: string, name: string }, seen: string }} input
   * @returns {Promise<object>}
   */
  async function attempt(ctx, run, input) {
    const { guildId, item } = input;
    const spentBefore = ctx.spent;
    const record = { attempts: [], applied: null, reason: null, tokens: 0 };
    const finish = (reason) => {
      record.reason = reason;
      record.tokens = ctx.spent - spentBefore;
      log.info('mentor: repair ended', { caseId: item.id, reason, attempts: record.attempts.length });
      return record;
    };

    const suspects = suspectsOf(run.diagnosis);
    if (suspects.length === 0) return finish('no diagnosis');
    const fixPrompt = hot.prompts?.[FIX_PROMPT];
    if (typeof fixPrompt !== 'string' || !fixPrompt.trim()) return finish('prompt missing');
    // Per suspect: `done` once it was not proven or an edit was asked for it; `result` once measured.
    const state = suspects.map((suspect) => ({ suspect, done: false, result: null }));
    const weak = weakOf(run, settings(hot.config, item.target).passScore, hot.config.mentor?.pass);

    try {
      for (;;) {
        const cfg = settings(hot.config, item.target);
        const candidates = state.filter((s) => !s.done).slice(0, cfg.suspects);
        if (candidates.length === 0) return finish('no suspect left');
        if (record.attempts.length >= cfg.maxAttempts) return finish('max attempts');
        checkSwitch();
        const n = record.attempts.length + 1;
        const entry = { n, suspects: [], edit: null, refused: null, verify: null, accepted: false };
        record.attempts.push(entry);
        const logAttempt = () =>
          log.info('mentor: repair attempt', { caseId: item.id, n, confirmed: entry.suspects.filter((s) => s.confirmed).length, accepted: entry.accepted });

        // 1. Ablation: the first proven suspect is repaired; other proven ones wait for a later attempt.
        const base = baseView(guildId);
        let chosen = null;
        for (const candidate of candidates) {
          candidate.result ??= await ablate(ctx, candidate.suspect, { base, item, weak, input, cfg, n });
          entry.suspects.push({ ...candidate.result });
          if (!candidate.result.confirmed) candidate.done = true;
          else chosen ??= candidate;
        }
        if (!chosen) {
          logAttempt();
          continue;
        }
        chosen.done = true;

        // 2. One edit against it, within what an edit may touch.
        const edit = await askEdit(ctx, run, { item, input, suspect: chosen.suspect, gain: chosen.result.gain, cfg, n });
        if (!edit) {
          entry.refused = 'invalid answer';
          logAttempt();
          continue;
        }
        entry.edit = { layer: edit.layer, target: edit.target, from: edit.from, to: edit.to, why: edit.why };
        const view = baseView(guildId);
        const refusal = refusalOf(edit, cfg);
        const edits = refusal ? null : editToOverlay(edit, view);
        entry.refused = refusal ?? edits.error ?? null;
        if (entry.refused) {
          logAttempt();
          continue;
        }

        // 3. Verification on the edited view.
        entry.verify = { fresh: null, regression: [], skipped: [] };
        entry.accepted = await verifyEdit(ctx, { guildId, item, view: overlayView(view, edits), input, cfg, n, verify: entry.verify });
        if (!entry.accepted) {
          logAttempt();
          continue;
        }

        // 4. The write, only while the switch is on and nobody stopped the run.
        checkSwitch();
        if (ctx.signal?.aborted) throw new LoopEnd('stopped by the owner');
        let result;
        try {
          result = changes.apply(guildId, { ...entry.edit }, { caseId: item.id });
        } catch (err) {
          log.warn('mentor: a repair could not be applied', { caseId: item.id, errorName: err?.name });
          throw new LoopEnd('apply failed');
        }
        if (!result?.ok) {
          // Verified, but nothing was written: the attempt is not accepted and carries the store's reason.
          entry.accepted = false;
          entry.refused = typeof result?.reason === 'string' ? result.reason : 'refused';
          logAttempt();
          continue;
        }
        logAttempt();
        const change = result.change;
        record.applied = { changeId: change.id, layer: change.layer, target: change.target ?? null, summary: change.summary };
        log.info('mentor: repair applied', { caseId: item.id, changeId: change.id, layer: change.layer });
        return finish('applied');
      }
    } catch (err) {
      const reason = err instanceof LoopEnd ? err.reason : failureOf(err);
      if (!(err instanceof LoopEnd) && !STOPS.has(reason)) log.warn('mentor: the repair loop failed', { caseId: item.id, errorName: err?.name, statusCode: err?.statusCode });
      return finish(reason);
    }
  }

  return { attempt };
}
