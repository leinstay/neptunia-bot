// The mentor's report to the owner: a short card for the admin channel and a
// text file with everything behind it (every situation, every answer, the
// facts measured by code, the points per axis and the mentor's comment), and
// the one-line summary of the latest run for `/nep mentor status`. The
// card and the file are operator-facing English, like the other command
// replies of the bot; the mentor model's comments are shown verbatim. Pure:
// a stored run object in, text out.

import { AXES } from './judge.js';

/** Discord's hard limit is 2000; the card stays well under it. */
const CARD_MAX = 1800;
const CASE_TEXT_MAX = 300;
const REASONS_MAX = 300;
const ERROR_MAX = 200;
const RULE = '='.repeat(60);

/** `text` cut to `max` characters with an ellipsis when it was longer. */
function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
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
 * `by situation: 1: 9 · 2: 3 · 3: -`, the median overall of every situation;
 * null for a run stored before the medians by situation or with none of them.
 */
function bySituationLine(run) {
  if (!Array.isArray(run?.situationMedians) || run.situationMedians.length === 0) return null;
  const parts = (run.situations ?? []).map((s) => `${s?.n}: ${num(situationMedian(run, s?.n)?.overall)}`);
  return parts.length ? `by situation: ${parts.join(' · ')}` : null;
}

/** Every answer of a run, flat. */
function answersOf(run) {
  return (run?.situations ?? []).flatMap((s) => s?.answers ?? []);
}

/** How the run ended, in a few words. */
function outcome(run) {
  if (run?.error) return `error: ${clip(run.error, ERROR_MAX)}`;
  if (run?.stopped === 'budget') return 'stopped: the mentor daily token budget ran out';
  if (run?.stopped === 'owner') return 'stopped by the owner';
  if (run?.stopped === 'disabled') return 'stopped: the mentor was disabled during the run';
  if (run?.stopped) return `stopped: ${clip(run.stopped, ERROR_MAX)}`;
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
 * median overall of every situation (`-` for one with no scored answer; the
 * line is left out for a run stored without them), how many answers were
 * scored, situations kept and dropped, repeated phrases, tokens spent and the
 * budget left, and the command that shows the details.
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
  if (!run?.passed && Array.isArray(run?.reasons) && run.reasons.length > 0) {
    lines.push(`why: ${clip(run.reasons.join('; '), REASONS_MAX)}`);
  }
  lines.push(`answers scored: ${scored} of ${answers.length} · situations: ${run?.situations?.length ?? 0} kept, ${run?.dropped ?? 0} dropped`);
  if (Array.isArray(run?.repeated) && run.repeated.length > 0) {
    lines.push(`phrases repeated across situations: ${run.repeated.length}`);
  }
  lines.push(`tokens: ${num(run?.tokens?.spent)} spent, ${num(run?.tokens?.left)} left today`);
  lines.push(`details: /nep mentor show ${run?.caseId}`);
  return clip(lines.join('\n'), CARD_MAX);
}

/** The lines of one answer in the file. */
function answerLines(answer, target) {
  const lines = [`--- ${answer.id} ---`];
  if (target === 'memory') {
    if (answer.parseOk === false) {
      lines.push('stored: nothing (the answer was not parsed as JSON)');
    } else if (!answer.texts?.length) {
      lines.push('stored: nothing');
    } else {
      lines.push('stored:');
      for (const item of answer.texts) lines.push(`  ${item.path}: ${item.text}`);
    }
  } else {
    if (answer.messages?.length) {
      lines.push('messages:');
      for (const message of answer.messages) lines.push(`  ${String(message).replace(/\n/g, '\n  ')}`);
    }
    if (answer.reactions?.length) lines.push(`reactions: ${answer.reactions.join(' ')}`);
    if (answer.silent) lines.push('silent');
  }
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
 * The file attached to the card: the case, the verdict, the reference, every
 * situation with its transcript (its header carries its median overall and
 * goal, `-` for none, unless the run was stored without them) and every
 * answer with its facts, points per axis and the mentor's comment.
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
  lines.push('', 'Case:', String(run?.caseText ?? ''));
  lines.push('', `Reference: ${run?.reference?.profile?.messages ?? 0} messages measured, ${run?.reference?.samples ?? 0} sample lines given`);
  lines.push(JSON.stringify(run?.reference?.profile ?? {}, null, 1));
  if (Array.isArray(run?.repeated) && run.repeated.length > 0) {
    lines.push('', 'Phrases repeated across situations:');
    for (const { phrase, count } of run.repeated) lines.push(`- "${phrase}" x${count}`);
  }
  lines.push('', `Situations: ${run?.situations?.length ?? 0} kept, ${run?.dropped ?? 0} dropped`);
  const hasMedians = Array.isArray(run?.situationMedians);
  for (const situation of run?.situations ?? []) {
    lines.push('', `${RULE}`, `Situation ${situation.n}: ${situation.title ?? ''}`);
    if (hasMedians) {
      const medians = situationMedian(run, situation.n);
      lines.push(`medians: overall ${num(medians?.overall)} · goal ${num(medians?.goal)}`);
    }
    lines.push(RULE, String(situation.transcript ?? ''));
    if (!situation.answers?.length) {
      lines.push('', '(no answers)');
      continue;
    }
    for (const answer of situation.answers) lines.push('', ...answerLines(answer, run?.target));
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
