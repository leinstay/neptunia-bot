// The mentor's report to the owner: a short card for the admin channel and a
// text file with everything behind it (every situation, every answer, the
// facts measured by code, the points per axis, the mentor's comment and its
// diagnosis when a run has one), and the one-line summary of the latest run
// for `/nep mentor status`. The card and the file are operator-facing
// English, like the other command replies of the bot; the mentor model's
// comments and diagnosis are shown verbatim. Pure: a stored run object in,
// text out.

import { AXES } from './judge.js';

/** Discord's hard limit is 2000; the card stays well under it. */
const CARD_MAX = 1800;
const CASE_TEXT_MAX = 300;
const REASONS_MAX = 300;
const ERROR_MAX = 200;
const DIAGNOSIS_CARD_MAX = 300;
const DIAGNOSIS_PREFIX = 'diagnosis: ';
const BY_SITUATION_MIN = 40;
const RULE = '='.repeat(60);

/**
 * `text` cut to `max` characters with an ellipsis when it was longer
 * (src/mentor/mentor.js clips a run's error with it too).
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
export function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

/** How a run stopped early, by its stop code (`run.stopped`). */
const STOP_PHRASES = {
  budget: 'stopped: the mentor daily token budget ran out',
  owner: 'stopped by the owner',
  disabled: 'stopped: the mentor was disabled during the run',
};

/**
 * The one operator phrase of a stop code ('budget' | 'owner' | 'disabled'):
 * the card's outcome, a diagnosis that could not be asked and a case a check
 * skipped all say it the same way. Another code reads `stopped: <code>`.
 * @param {unknown} code
 * @returns {string}
 */
export function stopPhrase(code) {
  return Object.hasOwn(STOP_PHRASES, String(code)) ? STOP_PHRASES[code] : `stopped: ${clip(code, ERROR_MAX)}`;
}

/** A median or a point as text; '-' when there is none. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-';
}

/** `human 6 · character - · rules 8 · goal 7 · overall 7` for a score or the medians. */
function axesLine(values) {
  return AXES.map((axis) => `${axis} ${num(values?.[axis])}`).join(' · ');
}

/**
 * The medians of situation `n` from a run's `situationMedians`; null when the
 * situation had no scored answer.
 */
function situationMedian(run, n) {
  return run.situationMedians.find((m) => m?.n === n) ?? null;
}

/**
 * Whether a stored situation is a real moment of the chat (it carries its anchor id).
 * @param {unknown} situation
 * @returns {boolean}
 */
export function isAnchor(situation) {
  return situation?.anchor !== undefined && situation?.anchor !== null;
}

/**
 * `by situation: 1 (anchor): 3 · 2: 9 · 3: -`, the median overall of every
 * situation, a real moment marked; null for a run stored before the medians
 * by situation or with none of them.
 */
function bySituationLine(run) {
  if (!Array.isArray(run?.situationMedians) || run.situationMedians.length === 0) return null;
  const parts = (run.situations ?? []).map((s) => `${s?.n}${isAnchor(s) ? ' (anchor)' : ''}: ${num(situationMedian(run, s?.n)?.overall)}`);
  return parts.length ? `by situation: ${parts.join(' · ')}` : null;
}

/** `5 kept (2 anchors)`, or `3 kept` for a run without real moments. */
function keptText(run) {
  const situations = run?.situations ?? [];
  const anchors = situations.filter(isAnchor).length;
  return anchors ? `${situations.length} kept (${anchors} anchor${anchors === 1 ? '' : 's'})` : `${situations.length} kept`;
}

/** Every answer of a run, flat. */
function answersOf(run) {
  return (run?.situations ?? []).flatMap((s) => s?.answers ?? []);
}

/** How the run ended, in a few words. */
function outcome(run) {
  if (run?.error) return `error: ${clip(run.error, ERROR_MAX)}`;
  if (run?.stopped) return stopPhrase(run.stopped);
  return run?.passed ? 'passed' : 'failed';
}

/** One short line for a check card. */
function checkOutcome(run) {
  if (run?.error) return `error (${clip(run.error, 80)})`;
  if (run?.stopped) return `stopped (${clip(run.stopped, 20)})`;
  return `${run?.passed ? 'passed' : 'failed'}, overall ${num(run?.medians?.overall)}`;
}

/**
 * The card posted to the admin channel after a run: the case (clipped to 300
 * characters), its target, the verdict or how the run ended, the medians, the
 * median overall of every situation (a real moment marked `(anchor)`, `-` for one with no scored answer; the
 * line is left out for a run stored without them), the mentor's diagnosis
 * summary when the run has one (clipped to 300 characters, or to the room the
 * other lines leave), how many answers were scored, situations kept and dropped, repeated phrases, tokens spent and the
 * budget left, and the command that shows the details. When the lines would
 * pass the limit the by-situation line is clipped first. A `repair` block
 * left on a run stored by an earlier version is ignored.
 * Never longer than 1800 characters.
 * @param {object} run  A run object as stored by `cases.saveRun`.
 * @returns {string}
 */
export function renderCard(run) {
  const answers = answersOf(run);
  const scored = answers.filter((a) => a?.score).length;
  const lines = [
    `Mentor ${run?.kind === 'check' ? 'check' : 'run'}: case ${run?.caseId} (${run?.target}) -- ${outcome(run)}`,
    `> ${clip(run?.caseText, CASE_TEXT_MAX).replace(/\n/g, ' ')}`,
    `medians: ${axesLine(run?.medians)}`,
  ];
  const bySituation = bySituationLine(run);
  if (bySituation) lines.push(bySituation);
  const summary = diagnosisSummary(run);
  const diagnosisAt = summary ? lines.length : -1;
  if (!run?.passed && Array.isArray(run?.reasons) && run.reasons.length > 0) {
    lines.push(`why: ${clip(run.reasons.join('; '), REASONS_MAX)}`);
  }
  lines.push(`answers scored: ${scored} of ${answers.length} · situations: ${keptText(run)}, ${run?.dropped ?? 0} dropped`);
  if (Array.isArray(run?.repeated) && run.repeated.length > 0) {
    lines.push(`phrases repeated across situations: ${run.repeated.length}`);
  }
  lines.push(`tokens: ${num(run?.tokens?.spent)} spent, ${num(run?.tokens?.left)} left today`);
  lines.push(`details: /nep mentor show ${run?.caseId}`);
  // The median of every situation grows with their number: it gives up room before the other lines do.
  const overflow = lines.join('\n').length - CARD_MAX;
  const bySituationAt = bySituation ? lines.indexOf(bySituation) : -1;
  if (overflow > 0 && bySituationAt >= 0) lines[bySituationAt] = clip(bySituation, Math.max(BY_SITUATION_MIN, bySituation.length - overflow));
  if (diagnosisAt >= 0) {
    // The summary takes what room the other lines leave, at most its own limit; none left, no line.
    const room = CARD_MAX - lines.join('\n').length - 1 - DIAGNOSIS_PREFIX.length;
    if (room > 3) lines.splice(diagnosisAt, 0, `${DIAGNOSIS_PREFIX}${clip(summary, Math.min(DIAGNOSIS_CARD_MAX, room))}`);
  }
  return clip(lines.join('\n'), CARD_MAX);
}

/** The diagnosis summary of a run on one line, or '' when it has none. */
function diagnosisSummary(run) {
  const summary = run?.diagnosis?.summary;
  return typeof summary === 'string' ? summary.replace(/\s*\n\s*/g, ' ').trim() : '';
}

/** The lines of one answer in the file. */
function answerLines(answer) {
  const lines = [`--- ${answer.id} ---`];
  if (answer.messages?.length) {
    lines.push('messages:');
    for (const message of answer.messages) lines.push(`  ${String(message).replace(/\n/g, '\n  ')}`);
  }
  if (answer.reactions?.length) lines.push(`reactions: ${answer.reactions.join(' ')}`);
  if (answer.silent) lines.push('silent');
  lines.push(`facts: ${JSON.stringify(answer.facts ?? {})}`);
  if (answer.score) {
    lines.push(`points: ${axesLine(answer.score)}`);
    lines.push(`comment: ${answer.score.comment ?? ''}`);
  } else {
    lines.push('points: not scored');
  }
  return lines;
}

/**
 * `worn: <shape> x<count> ("<example>", ...); ...` -- the devices the variety
 * pass named for a situation; `worn: nothing named` for an empty list.
 */
function wornLine(worn) {
  const items = worn
    .filter((p) => p && typeof p.shape === 'string')
    .map((p) => `${p.shape} x${num(p.count)} (${(Array.isArray(p.examples) ? p.examples : []).map((e) => `"${e}"`).join(', ')})`);
  return `worn: ${items.length ? items.join('; ') : 'nothing named'}`;
}

/** A multi-line text indented under a list item. */
function indented(text) {
  return String(text ?? '').replace(/\n/g, '\n    ');
}

/** The lines of the mentor's diagnosis in the file: its summary, the causes, the proposed changes. */
function diagnosisLines(diagnosis) {
  const lines = ["Diagnosis (the mentor's opinion, not verified):", String(diagnosis.summary ?? '')];
  const causes = Array.isArray(diagnosis.causes) ? diagnosis.causes : [];
  const changes = Array.isArray(diagnosis.changes) ? diagnosis.changes : [];
  lines.push('', causes.length ? 'Causes:' : 'Causes: none named');
  for (const cause of causes) {
    lines.push(`- ${cause.layer}${cause.excerpt ? `: "${indented(cause.excerpt)}"` : ''}`);
    lines.push(`  why: ${indented(cause.why)}`);
  }
  lines.push('', changes.length ? 'Proposed changes:' : 'Proposed changes: none');
  for (const change of changes) {
    lines.push(`- ${change.layer}${change.target ? `, ${change.target}` : ''}`);
    lines.push(`  from: ${change.from ? `"${indented(change.from)}"` : '(an addition)'}`);
    lines.push(`  to: "${indented(change.to)}"`);
    lines.push(`  why: ${indented(change.why)}`);
  }
  return lines;
}

/**
 * The file attached to the card: the case, the verdict, the reference, every
 * situation with its transcript (its header carries its anchor id for a real moment, then its median overall and
 * goal, `-` for none, unless the run was stored without them; a real moment
 * shows the persona's original answer after its transcript) and every
 * answer with its facts, points per axis and the mentor's comment. A run with
 * a diagnosis gets its section after the case (summary, causes, proposed
 * changes, marked as the mentor's unverified opinion); a diagnosis that
 * failed is named with its reason in the header. A `repair` block left on a
 * run stored by an earlier version is ignored.
 * @param {object} run  A run object as stored by `cases.saveRun` (with its `id`).
 * @returns {{ name: string, text: string }}
 */
export function renderFile(run) {
  const lines = [
    `Mentor ${run?.kind === 'check' ? 'check' : 'run'} ${run?.id ?? '(not saved)'} -- case ${run?.caseId} (${run?.target})`,
    `started ${run?.startedAt ?? '-'}, finished ${run?.finishedAt ?? '-'}`,
    `models: mentor ${run?.models?.mentor ?? '-'}, talk ${run?.models?.talk ?? '-'}, analyzer ${run?.models?.analyzer ?? '-'}`,
    `outcome: ${run?.error ? `error: ${run.error}` : outcome(run)}`,
  ];
  if (Array.isArray(run?.reasons) && run.reasons.length > 0) lines.push(`reasons: ${run.reasons.join('; ')}`);
  lines.push(`medians: ${axesLine(run?.medians)}`);
  lines.push(`tokens: ${num(run?.tokens?.spent)} spent, ${num(run?.tokens?.left)} left today`);
  if (!run?.diagnosis && run?.diagnosisError) lines.push(`diagnosis: not available (${clip(run.diagnosisError, ERROR_MAX)})`);
  lines.push('', 'Case:', String(run?.caseText ?? ''));
  if (run?.diagnosis) lines.push('', ...diagnosisLines(run.diagnosis));
  lines.push('', `Reference: ${run?.reference?.profile?.messages ?? 0} messages measured, ${run?.reference?.samples ?? 0} sample lines given`);
  lines.push(JSON.stringify(run?.reference?.profile ?? {}, null, 1));
  if (Array.isArray(run?.repeated) && run.repeated.length > 0) {
    lines.push('', 'Phrases repeated across situations:');
    for (const { phrase, count } of run.repeated) lines.push(`- "${phrase}" x${count}`);
  }
  lines.push('', `Situations: ${keptText(run)}, ${run?.dropped ?? 0} dropped`);
  const hasMedians = Array.isArray(run?.situationMedians);
  for (const situation of run?.situations ?? []) {
    const marker = isAnchor(situation) ? ` (anchor ${situation.anchor})` : '';
    lines.push('', `${RULE}`, `Situation ${situation.n}${marker}: ${situation.title ?? ''}`);
    if (hasMedians) {
      const medians = situationMedian(run, situation.n);
      lines.push(`medians: overall ${num(medians?.overall)} · goal ${num(medians?.goal)}`);
    }
    // What the variety pass named in the persona's own lines of this situation, on one line.
    if (Array.isArray(situation.worn)) lines.push(wornLine(situation.worn));
    lines.push(RULE, String(situation.transcript ?? ''));
    if (isAnchor(situation) && Array.isArray(situation.original) && situation.original.length > 0) {
      lines.push('', 'original answer:', ...situation.original.map((text) => `  ${String(text).replace(/\n/g, '\n  ')}`));
    }
    if (!situation.answers?.length) {
      lines.push('', '(no answers)');
      continue;
    }
    for (const answer of situation.answers) lines.push('', ...answerLines(answer));
  }
  return { name: `mentor-case-${run?.caseId}-${run?.id ?? 'unsaved'}.txt`, text: `${lines.join('\n')}\n` };
}

/**
 * The one card posted after `check`: one line per checked case with its
 * verdict and median `overall` (or how its run ended), then the skipped cases
 * with the reason, the tokens spent and the budget left. Lines that would
 * push the card past 1800 characters are counted instead of shown.
 * @param {object[]} runs  The check runs, as stored.
 * @param {{ caseId: number, reason: string }[]} skipped
 * @returns {string}
 */
export function renderCheckCard(runs, skipped) {
  const list = runs ?? [];
  const skip = skipped ?? [];
  const spent = list.reduce((sum, run) => sum + (Number(run?.tokens?.spent) || 0), 0);
  const left = list.length ? list[list.length - 1]?.tokens?.left : undefined;
  const head = `Mentor check: ${list.length} checked, ${skip.length} skipped`;
  const tail = [`tokens: ${spent} spent, ${num(left)} left today`, 'details: /nep mentor show <id>'];
  const body = [
    ...list.map((run) => `case ${run?.caseId}: ${checkOutcome(run)}`),
    ...skip.map((item) => `case ${item.caseId}: skipped (${clip(item.reason, 80)})`),
  ];
  const room = CARD_MAX - head.length - tail.join('\n').length - 60;
  const shown = [];
  let used = 0;
  for (const line of body) {
    if (used + line.length + 1 > room) break;
    shown.push(line);
    used += line.length + 1;
  }
  if (shown.length < body.length) shown.push(`... and ${body.length - shown.length} more`);
  return clip([head, ...shown, ...tail].join('\n'), CARD_MAX);
}

/** How a run ended, for the `last:` line of `/nep mentor status`. */
function lastOutcome(run) {
  if (run.error) return `error (${clip(String(run.error).replace(/\s+/g, ' '), 60)})`;
  if (run.stopped) return `stopped (${clip(run.stopped, 20)})`;
  return run.passed ? 'passed' : 'failed';
}

/** An ISO time as `YYYY-MM-DD HH:MM` in UTC; '-' when it does not parse. */
function minuteUtc(value) {
  const ms = Date.parse(value ?? '');
  if (!Number.isFinite(ms)) return '-';
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * The last line of `/nep mentor status`: the most recent finished run in one
 * line -- its case, how it ended (`passed`, `failed`, `stopped (<reason>)` or
 * `error (<reason clipped to 60 characters>)`), the median overall, how many
 * answers were scored, the tokens it spent and when it finished (UTC).
 * @param {object|null|undefined} run  A run object as stored by `cases.saveRun`; nothing for no run.
 * @returns {string}
 */
export function renderLastRun(run) {
  if (!run) return 'last: no run yet';
  const answers = answersOf(run);
  const scored = answers.filter((a) => a?.score).length;
  return (
    `last: case ${run.caseId}, ${lastOutcome(run)}, overall ${num(run.medians?.overall)}, ` +
    `${scored} of ${answers.length} answers scored, ${num(run.tokens?.spent)} tokens, finished ${minuteUtc(run.finishedAt)} UTC`
  );
}

/**
 * The file attached to the check card: the file of every run, one after another.
 * @param {object[]} runs  The check runs, as stored.
 * @param {number} stamp   A time in ms, for the file name.
 * @returns {{ name: string, text: string }}
 */
export function renderCheckFile(runs, stamp) {
  const text = (runs ?? []).map((run) => renderFile(run).text).join(`\n${RULE}\n${RULE}\n\n`);
  return { name: `mentor-check-${stamp}.txt`, text: text || 'No case was checked.\n' };
}
