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
  source?: {
    recognitionValueSource?: Record<string, RecognitionValueSource>;
  };
};

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
