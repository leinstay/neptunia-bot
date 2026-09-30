// The mentor's repair loop. A failed run ends with a diagnosis: the mentor
// model's unverified opinion of which piece of the persona's context caused
// the weak answers. This loop turns that opinion into at most one change,
// and only one that was measured to help:
//
//   0. control -- the weak situations are answered again on the UNCHANGED
//      view, once per loop: re-sampling alone moves a low score up, so a gain
//      is measured against this, never against the run's own low scores; a
//      control that passes means the failure did not reproduce;
//   1. ablation -- a suspect is proven by answering the weak situations again
//      WITHOUT that piece (an overlay view, nothing written) and measuring the
//      gain over the control; a `missing` cause has nothing to remove and
//      counts as proven;
//   2. edit -- the mentor model is asked for ONE edit against the proven cause
//      (the `mentor-fix` prompt), checked against what an edit may touch and
//      against the proven cause itself: the same piece, or for a cause in a
//      closed layer (the card) or a `missing` one, only an added rule;
//   3. verification -- the edit, again only on an overlay, must pass fresh
//      situations of the same case (at least `mentor.verify.minSituations`)
//      and must not drop any other case's stored situations by more than the
//      tolerance;
//   4. apply -- only then the change store writes it, recorded for undo.
//
// A weak real moment of the chat (an anchor, src/mentor/anchor.js) is
// replayed from its stored messages in the control and every ablation, as is
// another case's moment in the regression, each with the memory as it stood
// before its trigger (mentor.js#measureOn, src/mentor/moment.js); the fresh
// situations of the verification are invented with the case's moments in
// view (`<examples>`).
//
// Every measure is scored by a judge reading the LIVE rules, card and learned
// items, so an edit never moves the yardstick it is measured by. An attempt
// that proves nothing, whose edit is refused, or that fails its verification
// moves on to the next suspects, up to `mentor.fix.maxAttempts`. Every request
// goes through the run's own helpers (src/mentor/mentor.js), so the switches,
// the mentor budget, the owner's stop and the charging are the run's; a stop
// ends the loop with what it has and never touches the measured run.
// `features.mentorAutoFix` is checked before every step that spends (the
// control, each ablation, the edit request, the verification, each case of
// the regression) and again right before the write; nothing is written
// unless it is exactly true at that moment.

import { listRules } from '../admin.js';
import { fillPromptTemplate } from '../behavior/prompt.js';
import { log } from '../log.js';
import { ablationEdits, gainOf, locateSuspect } from './ablate.js';
import { anchorSituation, isUsableAnchor } from './anchor.js';
import { parseEdit, verdict } from './judge.js';
import { editToOverlay, overlayView } from './overlay.js';

const FIX_PROMPT = 'mentor-fix';
/** Every layer an answer may name: parsed with all of them so a closed layer is refused with its reason. */
const EDIT_LAYERS = ['rules', 'prompt', 'card', 'self', 'learned', 'guild', 'profile'];
/** The layers an edit may touch at most (never the card). */
const OPEN_LAYERS = ['rules', 'prompt', 'self', 'learned', 'guild', 'profile'];
/** The config.json defaults: the profile layer is open only where a deployment lists it. */
const DEFAULT_LAYERS = ['rules', 'prompt', 'self', 'learned', 'guild'];
const DEFAULT_FILES = ['system-prompt', 'format', 'reply', 'memory', 'profile'];
/**
 * The memory writer's prompts. An edit there cannot change a reply (no reply
 * situation could verify it), and a memory case can be verified only by an
 * edit there.
 */
const WRITER_FILES = new Set(['memory', 'profile', 'server', 'channel']);
/**
 * The prompts the reply sandbox renders: an edit anywhere else (`interject`,
 * `initiate`, `address`, ...) changes nothing a reply case could verify.
 */
const REPLY_FILES = new Set(['system-prompt', 'format', 'reply']);
/** Layers whose pieces an edit may rewrite but never delete. */
const NO_DELETION = new Set(['rules', 'prompt', 'profile']);
/** The guild strings: rewritten, never emptied. */
const GUILD_STRINGS = new Set(['patterns', 'starters']);
/** Layers held to `mentor.fix.maxGrowthChars`. */
const GROWTH_CAPPED = new Set(['rules', 'prompt']);
/** The longest note about the persona or in-joke an edit may write. */
const ITEM_MAX = 200;
/** How `failureOf` names a stop (the switches, the budget, the owner): not a failure worth a warning. */
const STOPS = new Set(['budget', 'disabled', 'stopped by the owner']);
const CONTROL_PHASE = 'repair: control';
const NOT_THE_CAUSE = 'not the proven cause';
/** Put after an edit's `from` to see which rule it falls in; never part of a prompt. */
const MARK = '\u0000';

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
 * allowed layer and, of `mentor.fix.files`, only the prompts the reply
 * sandbox renders (`REPLY_FILES`).
 */
function settings(config, target) {
  const mentor = config.mentor ?? {};
  const passScore = Number.isFinite(mentor.pass?.score) ? mentor.pass.score : 7;
  const fix = mentor.fix ?? {};
  let layers = Array.isArray(fix.layers) ? fix.layers.filter((layer) => OPEN_LAYERS.includes(layer)) : DEFAULT_LAYERS;
  let files = (Array.isArray(fix.files) ? fix.files : DEFAULT_FILES).map(promptName).filter(Boolean);
  if (target === 'memory') {
    layers = layers.filter((layer) => layer === 'prompt');
    files = files.filter((file) => WRITER_FILES.has(file));
  } else {
    files = files.filter((file) => REPLY_FILES.has(file));
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
    verifyMinSituations: count(mentor.verify?.minSituations, 2),
    regressionSituations: count(mentor.regression?.situations, 2),
    tolerance: amount(mentor.regression?.tolerance, 1),
    passScore,
    // A real moment's threshold, as src/mentor/judge.js#verdict holds it: `pass.anchorScore` when it is a number.
    anchorScore: Number.isFinite(mentor.pass?.anchorScore) ? mentor.pass.anchorScore : passScore,
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
 * A stored situation record as a situation to replay: a real moment (a record
 * with `anchor`) from the stored history of that anchor of `item`, invented
 * lines as they are; null when it cannot be replayed (no lines, or an anchor
 * the case no longer holds).
 */
function replayOf(record, item) {
  if (record?.anchor !== undefined && record?.anchor !== null) {
    const anchor = (Array.isArray(item?.anchors) ? item.anchors : []).find((a) => a?.id === record.anchor);
    return anchor && isUsableAnchor(anchor) ? { ...anchorSituation(anchor), title: record.title ?? '' } : null;
  }
  return Array.isArray(record?.lines) && record.lines.length > 0 ? { title: record.title ?? '', lines: record.lines } : null;
}

/** Whether a stored situation record is a real moment of the chat (it carries its anchor id). */
function isAnchorRecord(record) {
  return record?.anchor !== undefined && record?.anchor !== null;
}

/**
 * Whether a situation's medians are weak: its median `overall` or its median
 * `goal` is under its threshold -- `cfg.anchorScore` for a real moment,
 * `cfg.passScore` for an invented situation. A missing median is not weak on
 * its axis.
 */
function isWeak(medians, anchor, cfg) {
  const threshold = anchor ? cfg.anchorScore : cfg.passScore;
  return ['overall', 'goal'].some((axis) => typeof medians?.[axis] === 'number' && medians[axis] < threshold);
}

/**
 * The situations an ablation (and its control) replays: the weak ones of the
 * run (`isWeak`), all of them when none is; a real moment is replayed from
 * its stored history (see `replayOf`). `anchors` says, in the same order,
 * which replayed situation is a real moment.
 */
function weakOf(run, cfg, item) {
  const records = run.situations ?? [];
  const anchorNs = new Set(records.filter(isAnchorRecord).map((s) => s.n));
  const weak = new Set((run.situationMedians ?? []).filter((m) => isWeak(m, anchorNs.has(m?.n), cfg)).map((m) => m.n));
  const replays = records
    .filter((s) => weak.size === 0 || weak.has(s.n))
    .map((s) => ({ situation: replayOf(s, item), anchor: isAnchorRecord(s) }))
    .filter((r) => r.situation);
  return { situations: replays.map((r) => r.situation), anchors: replays.map((r) => r.anchor) };
}

/**
 * Whether the control reproduced the failure: at least one replayed situation
 * is still weak on it (`isWeak`). A replayed situation the control left
 * without a median `overall` cannot show it recovered and counts as still
 * weak; with nothing to replay the failure counts as reproduced.
 */
function reproducedOn(controlVerdict, weak, cfg) {
  if (weak.situations.length === 0) return true;
  return weak.situations.some((_, i) => {
    const medians = controlVerdict.situations.find((m) => m.n === i + 1);
    return typeof medians?.overall !== 'number' || isWeak(medians, weak.anchors[i], cfg);
  });
}

/** Why an edit may not be made, by the loop's own limits; null when it may. */
function refusalOf(edit, cfg) {
  if (!cfg.layers.includes(edit.layer)) return 'layer not allowed';
  if (edit.layer === 'prompt' && !cfg.files.includes(edit.target)) return 'file not allowed';
  if (NO_DELETION.has(edit.layer) && !edit.to.trim()) return 'deletion not allowed';
  if (edit.layer === 'guild' && GUILD_STRINGS.has(edit.target) && !edit.to.trim()) return 'deletion not allowed';
  if (GROWTH_CAPPED.has(edit.layer) && length(edit.to) - length(edit.from) > cfg.maxGrowthChars) return 'growth over the cap';
  if (edit.layer === 'learned' && length(edit.to.trim()) > cfg.learnedChars) return 'text too long';
  const item = edit.layer === 'self' || (edit.layer === 'guild' && edit.target === 'injokes');
  if (item && length(edit.to.trim()) > ITEM_MAX) return 'text too long';
  return null;
}

/**
 * Where a suspect lies in `view` (src/mentor/ablate.js#locateSuspect, with
 * the `ref` dropped when it hides the excerpt) and the edits that remove it;
 * `where` carries the text of the piece for a rule or a list item.
 */
function locate(suspect, view) {
  const variants = suspect.ref ? [suspect, { ...suspect, ref: undefined }] : [suspect];
  for (const variant of variants) {
    const found = locateSuspect(variant, view);
    if (!found) continue;
    const edits = ablationEdits(variant, view);
    if (!edits) return null;
    const where = { ...found };
    const guild = view.memory?.getGuild?.() ?? {};
    if (found.layer === 'rules') where.text = listRules(view.prompts?.rules)[found.index];
    else if (found.layer === 'self') where.text = String(guild.self?.[found.index] ?? '');
    else if (found.layer === 'learned') where.text = String(guild.learned?.[found.index]?.text ?? '');
    else if (found.layer === 'guild' && found.field === 'injokes') where.text = String(guild.injokes?.[found.index] ?? '');
    return { where, edits };
  }
  return null;
}

/**
 * Whether the store would apply `from` inside rule `where.index`: the rule
 * is still the one proven there, `from` is on one line, and its first
 * occurrence in the rules text (the one the change store replaces) ends
 * inside that rule's bullet.
 */
function inRule(rulesText, from, where) {
  if (typeof rulesText !== 'string' || from.includes('\n')) return false;
  const rules = listRules(rulesText);
  if (rules[where.index] !== where.text) return false;
  const at = rulesText.indexOf(from);
  if (at === -1) return false;
  const end = at + from.length;
  const marked = listRules(rulesText.slice(0, end) + MARK + rulesText.slice(end));
  return marked.length === rules.length && marked.findIndex((rule) => rule.includes(MARK)) === where.index;
}

/**
 * Why an edit does not touch the proven cause; null when it does. A cause
 * that is `missing`, or lies in a layer the loop may not edit (the card, or
 * one the config closes), allows only an added rule (layer `rules`, empty
 * `from`). Any other cause allows only an edit of the very piece proven, with
 * a non-empty `from`: the same prompt; the same rule (`from` first found
 * inside its bullet); the same list item (`from` equal to or inside its text);
 * the same guild field; the same member and field.
 */
function causeRefusal(edit, chosen, view, cfg) {
  const where = chosen.where;
  const layer = chosen.suspect.layer === 'missing' ? 'missing' : where?.layer;
  if (!layer) return NOT_THE_CAUSE;
  if (layer === 'missing' || !cfg.layers.includes(layer)) return edit.layer === 'rules' && edit.from === '' ? null : NOT_THE_CAUSE;
  const from = edit.from.trim();
  if (edit.layer !== layer || !from) return NOT_THE_CAUSE;
  let same;
  switch (layer) {
    case 'rules':
      same = inRule(view.prompts?.rules, edit.from, where);
      break;
    case 'prompt':
      same = edit.target === where.name;
      break;
    case 'self':
    case 'learned':
      same = where.text.includes(from);
      break;
    case 'guild':
      same = edit.target === where.field && (where.field !== 'injokes' || where.text.includes(from));
      break;
    case 'profile':
      same = edit.target === `${where.userId}.${where.field}`;
      break;
    default:
      same = false;
  }
  return same ? null : NOT_THE_CAUSE;
}

/**
 * The repair loop for one mentor. Every value is read at the moment of use:
 * `hot.config.features.mentorAutoFix` (checked before the control, every
 * ablation, the edit request, the verification, each case of the regression
 * and the write), `hot.config.mentor` (`suspects`, `ablationGain`,
 * `ablationSamples` -- the samples of the control and of each ablation --,
 * `fix.maxAttempts`, `fix.maxGrowthChars`, `fix.layers` -- the card is never
 * allowed, the default leaves `profile` out --, `fix.files` -- narrowed by
 * the case's target: a reply case only `system-prompt`, `format` and `reply`,
 * a memory case only the memory writer's prompts (`memory`, `profile`,
 * `server`, `channel`) and only through the `prompt` layer --,
 * `verify.situations`, `verify.samples`, `verify.minSituations`,
 * `regression.situations`, `regression.tolerance`, `pass`),
 * `hot.config.memory.learnedChars` and the `mentor-fix` prompt.
 * @param {object} deps
 * @param {{ config: object, prompts: object }} deps.hot
 * @param {object} deps.cases              From `createCaseStore` (other cases and their last runs, read only).
 * @param {{ apply: Function, promptLayers?: Function }} deps.changes  From `createChangeStore`; with
 *   `promptLayers`, an edit of a prompt file is verified on the text `apply` will start from.
 * @param {(guildId: string) => object} deps.baseView  The live view of the guild (src/mentor/sandbox.js#liveView).
 * @param {Function} deps.measureOn        mentor.js: answer situations on a view and score them (with `judgeView`).
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
 *   verify: { fresh: { passed, kept, medians, situations }, regression: [{ caseId, held, situations: [{ n, before, after }] }],
 *   skipped } | null, accepted }], applied: { changeId, layer, target, summary } | null, reason, tokens }`,
 *   plus `control: { medians, situations }` once the control was measured. `reason` 'not reproduced':
 *   on the control every replayed situation reached its threshold on `overall` and `goal` (see `isWeak`).
 */
export function createRepair({ hot, cases, changes, baseView, measureOn, askMentor, inventSituations, commonBlocks, templateValues, canScore, failureOf }) {
  /** Stop when the switch of the loop (or of the mentor) is off now. */
  function checkSwitch() {
    const features = hot.config.features ?? {};
    if (features.mentorAutoFix !== true || features.mentor !== true) throw new LoopEnd('disabled');
  }

  /** What `editToOverlay` reads a prompt file's start text through: the change store's own reader, when it has one. */
  function overlayOptions() {
    return typeof changes?.promptLayers === 'function' ? { promptLayers: (name) => changes.promptLayers(name) } : {};
  }

  /**
   * One suspect removed and measured against the control; a `missing` cause
   * is proven without it. Resolves with the suspect as the record shows it
   * and where it was found.
   */
  async function ablate(ctx, suspect, { base, item, weak, input, cfg, n, control }) {
    const shown = { layer: suspect.layer, excerpt: suspect.excerpt };
    if (suspect.layer === 'missing') return { shown: { ...shown, located: null, gain: null, confirmed: true }, where: null };
    const found = locate(suspect, base);
    if (!found) return { shown: { ...shown, located: false, gain: null, confirmed: false }, where: null };
    const before = await control(base, cfg);
    checkSwitch();
    const phase = `repair ${n}: ablation`;
    ctx.phase = phase;
    const measured = await measureOn(ctx, {
      item,
      view: overlayView(base, found.edits),
      judgeView: base,
      situations: weak.situations,
      samples: cfg.ablationSamples,
      reference: input.reference,
      feedback: input.feedback,
      self: input.self,
      phase,
    });
    const gain = gainOf(before, measured.verdict);
    return { shown: { ...shown, located: true, gain, confirmed: typeof gain === 'number' && gain >= cfg.ablationGain }, where: found.where };
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
  async function regressionOf(ctx, other, { guildId, view, judgeView, input, cfg, phase }) {
    let last;
    try {
      last = cases.lastRun(guildId, other.id);
    } catch {
      return { skipped: true };
    }
    // A real moment of the other case is replayed from its stored history, as in its own run.
    const stored = (Array.isArray(last?.situations) ? last.situations : []).map((s) => ({ record: s, situation: replayOf(s, other) })).filter((s) => s.situation);
    if (stored.length === 0) return null;
    const medians = Array.isArray(last.situationMedians) ? last.situationMedians : [];
    if (medians.length === 0 || !canScore(other.target)) return { skipped: true };
    const replay = stored.slice(0, cfg.regressionSituations);
    checkSwitch();
    const measured = await measureOn(ctx, {
      item: other,
      view,
      judgeView,
      situations: replay.map((s) => s.situation),
      samples: 1,
      reference: input.reference,
      feedback: input.feedback,
      self: input.self,
      phase,
    });
    const situations = replay.map((s, i) => {
      const n = Number.isInteger(s.record.n) ? s.record.n : i + 1;
      const before = medians.find((m) => m?.n === n)?.overall;
      const after = measured.verdict.situations.find((m) => m.n === i + 1)?.overall;
      return { n, before: typeof before === 'number' ? before : null, after: typeof after === 'number' ? after : null };
    });
    // A situation with no stored median has nothing to hold to; one left unscored now does not hold.
    const held = situations.every((s) => s.before === null || (s.after !== null && s.after >= s.before - cfg.tolerance));
    return { entry: { caseId: other.id, held, situations } };
  }

  /**
   * Fresh situations of the case, then every other case's stored ones, on the
   * edited view, scored against `judgeView` (the live view). Accepted when
   * both hold; refused when fewer fresh situations than
   * `mentor.verify.minSituations` were kept (nothing is answered then).
   */
  async function verifyEdit(ctx, { guildId, item, view, judgeView, input, cfg, n, verify }) {
    checkSwitch();
    const phase = `repair ${n}: verify`;
    ctx.phase = phase;
    const invented = await inventSituations(ctx, { item, view, reference: input.reference, feedback: input.feedback, self: input.self, count: cfg.verifySituations, phase });
    const kept = invented.situations.length;
    if (kept < cfg.verifyMinSituations) {
      const none = verdict([], hot.config.mentor?.pass, []);
      verify.fresh = { passed: false, kept, medians: none.medians, situations: none.situations };
      return { accepted: false, refused: 'too few fresh situations' };
    }
    const fresh = (await measureOn(ctx, { item, view, judgeView, situations: invented.situations, samples: cfg.verifySamples, reference: input.reference, feedback: input.feedback, self: input.self, phase })).verdict;
    verify.fresh = { passed: fresh.passed, kept, medians: fresh.medians, situations: fresh.situations };
    if (!fresh.passed) return { accepted: false, refused: null };

    const regressionPhase = `repair ${n}: regression`;
    ctx.phase = regressionPhase;
    for (const other of cases.list(guildId)) {
      if (other.id === item.id) continue;
      const result = await regressionOf(ctx, other, { guildId, view, judgeView, input, cfg, phase: regressionPhase });
      if (!result) continue;
      if (result.skipped) {
        verify.skipped.push(other.id);
        continue;
      }
      verify.regression.push(result.entry);
      if (!result.entry.held) return { accepted: false, refused: null };
    }
    return { accepted: true, refused: null };
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
    const state = suspects.map((suspect) => ({ suspect, done: false, result: null, where: null }));
    const weak = weakOf(run, settings(hot.config, item.target), item);

    // The control: measured the first time an ablation needs it, then reused for every suspect.
    let controlVerdict = null;
    const control = async (base, cfg) => {
      if (controlVerdict) return controlVerdict;
      checkSwitch();
      ctx.phase = CONTROL_PHASE;
      const measured = await measureOn(ctx, {
        item,
        view: base,
        judgeView: base,
        situations: weak.situations,
        samples: cfg.ablationSamples,
        reference: input.reference,
        feedback: input.feedback,
        self: input.self,
        phase: CONTROL_PHASE,
      });
      controlVerdict = measured.verdict;
      record.control = { medians: controlVerdict.medians, situations: controlVerdict.situations };
      const reproduced = reproducedOn(controlVerdict, weak, cfg);
      log.info('mentor: repair control', { caseId: item.id, situations: weak.situations.length, reproduced });
      if (!reproduced) throw new LoopEnd('not reproduced');
      return controlVerdict;
    };

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
          if (!candidate.result) {
            const measured = await ablate(ctx, candidate.suspect, { base, item, weak, input, cfg, n, control });
            candidate.result = measured.shown;
            candidate.where = measured.where;
          }
          entry.suspects.push({ ...candidate.result });
          if (!candidate.result.confirmed) candidate.done = true;
          else chosen ??= candidate;
        }
        if (!chosen) {
          logAttempt();
          continue;
        }
        chosen.done = true;

        // 2. One edit against it, within what an edit may touch and on the proven cause itself.
        checkSwitch();
        const edit = await askEdit(ctx, run, { item, input, suspect: chosen.suspect, gain: chosen.result.gain, cfg, n });
        if (!edit) {
          entry.refused = 'invalid answer';
          logAttempt();
          continue;
        }
        entry.edit = { layer: edit.layer, target: edit.target, from: edit.from, to: edit.to, why: edit.why };
        const view = baseView(guildId);
        const refusal = refusalOf(edit, cfg);
        const edits = refusal ? null : editToOverlay(edit, view, overlayOptions());
        entry.refused = refusal ?? edits.error ?? causeRefusal(edit, chosen, view, cfg);
        if (entry.refused) {
          logAttempt();
          continue;
        }

        // 3. Verification on the edited view, judged against the live one.
        entry.verify = { fresh: null, regression: [], skipped: [] };
        const verified = await verifyEdit(ctx, { guildId, item, view: overlayView(view, edits), judgeView: view, input, cfg, n, verify: entry.verify });
        entry.accepted = verified.accepted;
        entry.refused = verified.refused;
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
