export interface StudentBasic {
  age?: number;
  gender?: string;
  schoolType?: string;
  grade?: string;
}

export interface StudentCagi {
  q01?: number;
  q02?: number;
  q03?: number;
  q04?: number;
  q05?: number;
  q06?: number;
  q07?: number;
  q08?: number;
  q09?: number;
  [key: string]: number | undefined; // 인덱스 시그니처 추가
}

export interface StudentSatisfaction {
  q01?: number;
  q02?: number;
  q03?: number;
  q04?: number;
  q05?: number;
  q06?: number;
  q07?: number;
  q08?: number;
  q09?: number;
  q10?: number;
  [key: string]: number | undefined; // 인덱스 시그니처 추가
}

export interface StudentSource {
  cagiImageId?: string;
  satisfactionImageId?: string;
}

export type FormTrack = 'youth' | 'adult';

export interface StudentData {
  studentIndex?: number;
  // 미지정 시 'youth'로 취급한다 (기존 청소년 전용 데이터와의 하위 호환).
  track?: FormTrack;
  source: StudentSource;
  basic: StudentBasic;
  cagi: StudentCagi;
  satisfaction: StudentSatisfaction;
  status: 'draft' | 'confirmed' | 'saved';
}

export interface ValidationError {
  code: string;
  message: string;
  field?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}
