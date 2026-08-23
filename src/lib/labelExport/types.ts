import type { CandidateMeasurement } from '../recognition/markDensity';

export type LabelSource = 'manual' | 'confirmed' | 'blank_ok' | 'auto' | 'restored';

export type RegistrationStatus = 'verified' | 'candidate' | 'failed';

/** Candidate measurements retained between recognition and review save. */
export interface RecognitionCandidateMeasurement extends CandidateMeasurement {
  candidateValue: number | string;
  field: string;
  registrationStatus: RegistrationStatus;
  cropSource: string;
  pageInkRatio: number;
  pageIsBinarySource: boolean;
  confidence: 'high' | 'medium' | 'low';
  autoFilled: boolean;
}

export type RecognitionMeasurementsByField = Record<string, RecognitionCandidateMeasurement[]>;

export interface StoredRecognitionMeasurements {
  jobId: string;
  studentIndex: number;
  cagiImageId: string;
  measurements: RecognitionMeasurementsByField;
}

export interface LabelRow extends RecognitionCandidateMeasurement {
  jobId: string;
  studentIndex: number;
  label: 0 | 1;
  labelSource: LabelSource;
}
