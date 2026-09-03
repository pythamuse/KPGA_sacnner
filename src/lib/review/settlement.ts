import type {
  RecognitionDraft,
  RecognitionValueSource,
} from '../recognition/detectCheckmarks';

/** The 23 fields whose values can be recognized and reviewed. */
export const REVIEW_FIELD_KEYS = [
  'basic.age', 'basic.gender', 'basic.schoolType', 'basic.grade',
  'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07', 'cagi.q08', 'cagi.q09',
  'satisfaction.q01', 'satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06', 'satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10',
] as const;

type SettlementDraft = Pick<RecognitionDraft, 'basic' | 'cagi' | 'satisfaction'> & {
  confidence?: RecognitionDraft['confidence'];
  source?: {
    recognitionValueSource?: Record<string, RecognitionValueSource>;
    recognitionContested?: Record<string, boolean>;
    recognitionEvidence?: Record<string, { refused?: string[] } | undefined>;
  };
};

/** Reads one review field's value out of a draft, whatever group it sits in. */
function fieldValue(draft: SettlementDraft, key: string): unknown {
  const [group, name] = key.split('.');
  if (group === 'basic') return (draft.basic as Record<string, unknown> | undefined)?.[name];
  if (group === 'cagi') return (draft.cagi as Record<string, unknown> | undefined)?.[name];
  return (draft.satisfaction as Record<string, unknown> | undefined)?.[name];
}

/**
 * Fields the cancelled-mark veto left empty on purpose, in page order.
 *
 * These carry recognition evidence but no value, so they are absent from
 * `unconfirmedMachineFields` and therefore from `contestedUnconfirmedFields`
 * and `bulkConfirmableFields` -- which is correct, an empty cell must never be
 * bulk-confirmable. They still need naming, because a reviewer who sees a blank
 * cell has no way to know the recognizer withheld a value rather than finding
 * nothing (Task/CANCEL_VETO_2026-09-03.md).
 */
export function cancelRefusedFields(draft: SettlementDraft): string[] {
  return REVIEW_FIELD_KEYS.filter((key) => {
    const value = fieldValue(draft, key);
    if (value !== undefined && value !== null && value !== '') return false;
    return (draft.source?.recognitionEvidence?.[key]?.refused || []).includes('cancel-crossing');
  });
}

/** Whether a source records an explicit reviewer decision. */
export function isSettledSource(source: RecognitionValueSource | undefined): boolean {
  return source === 'manual' || source === 'confirmed' || source === 'blank_ok';
}

/**
 * Returns machine-originated values that still need a reviewer decision.
 * Empty fields are deliberately excluded: unresolved blanks keep the existing
 * validation path and are not part of this save gate.
 */
export function unconfirmedMachineFields(draft: SettlementDraft): string[] {
  return REVIEW_FIELD_KEYS.filter((key) => {
    const [group, name] = key.split('.');
    const value = group === 'basic'
      ? (draft.basic as Record<string, unknown> | undefined)?.[name]
      : group === 'cagi'
        ? (draft.cagi as Record<string, unknown> | undefined)?.[name]
        : (draft.satisfaction as Record<string, unknown> | undefined)?.[name];
    const source = draft.source?.recognitionValueSource?.[key];

    return value !== undefined
      && value !== null
      && value !== ''
      && (source === 'auto' || source === 'restored');
  });
}

/**
 * Returns unresolved machine values whose recognition evidence was contested,
 * in the same page order as the general settlement list.
 */
export function contestedUnconfirmedFields(draft: SettlementDraft): string[] {
  return unconfirmedMachineFields(draft).filter(
    (key) => draft.source?.recognitionContested?.[key] === true,
  );
}

/**
 * Returns the safe subset for conditional bulk confirmation.
 *
 * A high-confidence value is eligible only when it is still machine-originated
 * and its recognition evidence was not contested. The filter deliberately
 * starts from `unconfirmedMachineFields`, so empty values and settled sources
 * cannot enter this action by accident.
 */
export function bulkConfirmableFields(draft: SettlementDraft): string[] {
  const contested = new Set(contestedUnconfirmedFields(draft));

  return unconfirmedMachineFields(draft).filter(
    (key) => !contested.has(key) && draft.confidence?.[key] === 'high',
  );
}
