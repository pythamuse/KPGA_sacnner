import type { DecisionEvidence } from '../recognition/markDensity';
import {
  BASELINE_ALIGNMENT_RADIUS,
  HIGH_ABSOLUTE_SIGNAL,
  HIGH_RELATIVE_CONTRAST,
  PHOTO_BINARY_FLOOR,
  STRUCTURED_MARK_MIN_COMPONENT_RATIO,
  STRUCTURED_MARK_MIN_DIAGONAL_RATIO,
} from '../recognition/markDensityConstants';

export type RemarkCause = 'faint' | 'offset' | 'shape';

const FAINT_REFUSALS = new Set(['absolute-floor', 'ink-invariant', 'photo-binary-floor']);
const BASELINE_REFUSALS = new Set([
  'absolute-floor',
  'gap',
  'mark-shape',
  'relative-contrast',
  'ink-invariant',
  'photo-binary-floor',
  'photo-binary-refused',
]);

function finiteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function formatNumber(value: number | undefined): string {
  if (!finiteNumber(value)) return '∞';
  return value.toFixed(3);
}

function formatScore(value: number, wholePercent = false): string {
  if (!Number.isFinite(value)) return '∞';
  const percent = value * 100;
  if (wholePercent) return `${Math.round(percent)}%`;
  // Keep small signals readable while avoiding a distracting trailing .0 on
  // the larger percentages reviewers scan first.
  return percent >= 10 && Number.isInteger(Math.round(percent * 10) / 10)
    ? `${Math.round(percent)}%`
    : `${percent.toFixed(1)}%`;
}

function formatMultiple(value: number): string {
  if (!Number.isFinite(value)) return '∞×';
  return `${value.toFixed(1)}×`;
}

function candidateLabel(
  candidate: { index: number; label?: string },
  candidateLabels: string[],
): string {
  return candidate.label || candidateLabels[candidate.index] || String(candidate.index);
}

function rankingText(
  evidence: DecisionEvidence,
  candidateLabels: string[],
  wholePercent = false,
): string {
  if (!evidence.winner) return '';
  const winner = `1위 '${candidateLabel(evidence.winner, candidateLabels)}' ${formatScore(evidence.winner.score, wholePercent)}`;
  if (!evidence.runnerUp) return winner;
  return `${winner} · 2위 '${candidateLabels[evidence.runnerUp.index] || String(evidence.runnerUp.index)}' ${formatScore(evidence.runnerUp.score, wholePercent)}`;
}

function usesBaselineEvidence(evidence: DecisionEvidence): boolean {
  return Boolean(evidence.offset || evidence.shape)
    || (evidence.refused || []).some((token) => BASELINE_REFUSALS.has(token));
}

function thresholdsFor(evidence: DecisionEvidence): { score: number; gap: number; contrast: number } {
  if (evidence.thresholds) return evidence.thresholds;
  const refused = evidence.refused || [];
  const photoFloor = refused.includes('photo-binary-floor')
    || refused.includes('photo-binary-refused');
  const baseline = usesBaselineEvidence(evidence);
  return {
    score: photoFloor ? PHOTO_BINARY_FLOOR : baseline ? HIGH_ABSOLUTE_SIGNAL : 0.35,
    gap: baseline ? 0.004 : 0.12,
    contrast: HIGH_RELATIVE_CONTRAST,
  };
}

/** Maps an internal refusal token to the short Korean phrase shown to reviewers. */
export function refusalLabel(token: string): string {
  if (token.startsWith('rescued:')) return `구제됨(${token.slice('rescued:'.length)})`;
  if (token.startsWith('medium-')) return '중간 신뢰 경로 미달';
  if (token.startsWith('form-bounds:')) return '양식 경계 미검증';

  switch (token) {
    case 'absolute-floor': return '잉크가 옅음';
    case 'gap': return '1·2위 차이 부족';
    case 'mark-shape': return '표시 모양이 불규칙';
    case 'relative-contrast': return '빈 양식 대비 부족';
    case 'ink-invariant': return '빈 양식보다 옅음(잡음 가능)';
    case 'band-structure': return '줄무늬 구조';
    case 'cancel-crossing': return '취소 표시로 보이는 교차 획';
    case 'photo-binary-floor':
    case 'photo-binary-refused':
      return '사진 이진 판정 미달';
    case 'grid-unverified': return '격자 검증 안 됨';
    case 'no-candidates': return '후보 없음';
    default: return token;
  }
}

function refusalDetail(token: string, evidence: DecisionEvidence): string {
  const thresholds = thresholdsFor(evidence);
  const score = evidence.winner?.score;

  switch (token) {
    case 'absolute-floor':
      return `${refusalLabel(token)}(${formatNumber(score)} < ${formatNumber(thresholds.score)})`;
    case 'photo-binary-floor':
      return `${refusalLabel(token)}(${formatNumber(score)} < ${formatNumber(PHOTO_BINARY_FLOOR)})`;
    case 'gap':
      return `${refusalLabel(token)}(${formatNumber(evidence.gap)} < ${formatNumber(thresholds.gap)})`;
    case 'relative-contrast':
      return `${refusalLabel(token)}(${formatNumber(evidence.relativeContrast)} < ${formatNumber(thresholds.contrast)})`;
    case 'mark-shape': {
      if (!evidence.shape) return refusalLabel(token);
      const checks = [];
      if (evidence.shape.componentRatio < STRUCTURED_MARK_MIN_COMPONENT_RATIO) {
        checks.push(`성분 ${formatNumber(evidence.shape.componentRatio)} < ${formatNumber(STRUCTURED_MARK_MIN_COMPONENT_RATIO)}`);
      }
      if (evidence.shape.diagonalRatio < STRUCTURED_MARK_MIN_DIAGONAL_RATIO) {
        checks.push(`대각 ${formatNumber(evidence.shape.diagonalRatio)} < ${formatNumber(STRUCTURED_MARK_MIN_DIAGONAL_RATIO)}`);
      }
      return checks.length > 0
        ? `${refusalLabel(token)}(${checks.join(' · ')})`
        : refusalLabel(token);
    }
    case 'ink-invariant':
      // This gate compares actual ink with blank-form ink, not the score with
      // a floor. Those two measurements are intentionally not duplicated in
      // DecisionEvidence, so do not print a misleading threshold comparison.
      return refusalLabel(token);
    default:
      return refusalLabel(token);
  }
}

/**
 * Turns the stored evidence into one reviewer-facing Korean line. It is pure
 * and deliberately independent of the recognition result or any UI state.
 */
export function describeEvidence(evidence: DecisionEvidence, candidateLabels: string[]): string {
  const contested = evidence.contested || evidence.outcome === 'contested';
  const ranking = rankingText(evidence, candidateLabels, contested);
  const refused = evidence.refused || [];

  if (contested) {
    const contestedText = `경합 — ${ranking || '두 칸 모두 표시 흔적'}${ranking ? ' (두 칸 모두 표시 흔적)' : ''}`;
    // A contested row can also have been refused outright -- the cancelled-mark
    // veto does exactly that (Task/CANCEL_VETO_2026-09-03.md). Without this the
    // reason never reached the screen: the reviewer saw the ranking and a blank
    // cell, with nothing saying the winning mark looks struck out.
    const reasons = refused
      .filter((token) => !token.startsWith('rescued:'))
      .map((token) => refusalDetail(token, evidence));
    return reasons.length > 0 ? `${contestedText} · 보류 — ${reasons.join(' · ')}` : contestedText;
  }

  if (evidence.outcome === 'refused') {
    const reasons = refused.map((token) => refusalDetail(token, evidence));
    return `보류 — ${reasons.length > 0 ? reasons.join(' · ') : '판정 근거 없음'}`;
  }

  const parts = [ranking];
  if (finiteNumber(evidence.relativeContrast)) {
    parts.push(`여유 ${formatMultiple(evidence.relativeContrast)}`);
  }
  if (evidence.offset && finiteNumber(evidence.offset.x) && finiteNumber(evidence.offset.y)) {
    parts.push(`자리 편차 ${Math.hypot(evidence.offset.x, evidence.offset.y).toFixed(2)}`);
  }
  const rescued = refused
    .filter((token) => token.startsWith('rescued:'))
    .map((token) => refusalLabel(token));
  parts.push(...rescued);

  return parts.filter(Boolean).join(' · ') || '자동 입력 근거 확인됨';
}

/** Classifies the three reviewer-visible causes that warrant a closer look. */
export function remarkCause(evidence: DecisionEvidence): RemarkCause[] {
  const causes: RemarkCause[] = [];
  const refused = evidence.refused || [];

  if (refused.some((token) => FAINT_REFUSALS.has(token))) {
    causes.push('faint');
  }

  if (
    evidence.offset
    && (Math.abs(evidence.offset.x) >= BASELINE_ALIGNMENT_RADIUS
      || Math.abs(evidence.offset.y) >= BASELINE_ALIGNMENT_RADIUS)
  ) {
    causes.push('offset');
  }

  if (
    refused.includes('mark-shape')
    || (evidence.shape !== undefined
      && (evidence.shape.componentRatio < STRUCTURED_MARK_MIN_COMPONENT_RATIO
        || evidence.shape.diagonalRatio < STRUCTURED_MARK_MIN_DIAGONAL_RATIO))
  ) {
    causes.push('shape');
  }

  return causes;
}
