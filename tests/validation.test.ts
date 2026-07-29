import { describe, it, expect } from 'vitest';
import { normalizeGender, normalizeSchoolType, normalizeGrade, normalizeAge } from '../src/lib/validation/normalize';
import { validateStudent } from '../src/lib/validation/validateStudent';
import { StudentData } from '../src/lib/validation/types';

describe('데이터 정규화 테스트', () => {
  it('성별 정규화', () => {
    expect(normalizeGender('남')).toBe('남');
    expect(normalizeGender('남자')).toBe('남');
    expect(normalizeGender('남학생')).toBe('남');
    expect(normalizeGender('여')).toBe('여');
    expect(normalizeGender('여자')).toBe('여');
    expect(normalizeGender('여학생')).toBe('여');
    expect(normalizeGender('기타')).toBe('기타');
    expect(normalizeGender('')).toBe('');
    expect(normalizeGender(null)).toBe('');
  });

  it('학교유형 정규화', () => {
    expect(normalizeSchoolType('초등')).toBe('초등학교');
    expect(normalizeSchoolType('초등학교')).toBe('초등학교');
    expect(normalizeSchoolType('중등')).toBe('중학교');
    expect(normalizeSchoolType('중학교')).toBe('중학교');
    expect(normalizeSchoolType('고등')).toBe('고등학교');
    expect(normalizeSchoolType('고등학교')).toBe('고등학교');
    expect(normalizeSchoolType('학교 외 기관')).toBe('학교외기관');
    expect(normalizeSchoolType('학교외기관')).toBe('학교외기관');
  });

  it('학년 정규화', () => {
    expect(normalizeGrade('1')).toBe('1학년');
    expect(normalizeGrade('1학년')).toBe('1학년');
    expect(normalizeGrade('2')).toBe('2학년');
    expect(normalizeGrade('2학년')).toBe('2학년');
    expect(normalizeGrade('해당 없음')).toBe('해당없음');
    expect(normalizeGrade('해당없음')).toBe('해당없음');
  });

  it('나이 정규화', () => {
    expect(normalizeAge('만 14세')).toBe(14);
    expect(normalizeAge('14')).toBe(14);
    expect(normalizeAge(14)).toBe(14);
    expect(normalizeAge('')).toBeUndefined();
    expect(normalizeAge(null)).toBeUndefined();
  });
});

describe('데이터 검증 테스트', () => {
  const validStudent: StudentData = {
    source: {
      cagiImageId: 'img_cagi_1',
      satisfactionImageId: 'img_sat_1'
    },
    basic: {
      age: 14,
      gender: '여자', // 정규화 후 '여'가 됨
      schoolType: '중학교',
      grade: '2학년'
    },
    cagi: {
      q01: 0, q02: 0, q03: 0, q04: 0, q05: 0, q06: 0, q07: 0, q08: 0, q09: 0
    },
    satisfaction: {
      q01: 4, q02: 1, q03: 1, q04: 1, q05: 1, q06: 1, q07: 4, q08: 4, q09: 4, q10: 4
    },
    status: 'draft'
  };

  it('예시 이미지 기준 기대값 통과 (회귀 테스트)', () => {
    const result = validateStudent(validStudent);
    expect(result.ok).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('이미지 누락 시 실패', () => {
    const missingCagi = { ...validStudent, source: { satisfactionImageId: 'img_sat_1' } };
    const result1 = validateStudent(missingCagi);
    expect(result1.ok).toBe(false);
    expect(result1.errors.some(e => e.code === 'MISSING_CAGI_IMAGE')).toBe(true);

    const missingSat = { ...validStudent, source: { cagiImageId: 'img_cagi_1' } };
    const result2 = validateStudent(missingSat);
    expect(result2.ok).toBe(false);
    expect(result2.errors.some(e => e.code === 'MISSING_SATISFACTION_IMAGE')).toBe(true);
  });

  it('잘못된 성별 입력 시 실패', () => {
    const invalidGender = {
      ...validStudent,
      basic: { ...validStudent.basic, gender: '외계인' }
    };
    const result = validateStudent(invalidGender);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_GENDER')).toBe(true);
  });

  it('잘못된 CAGI 문항 값 입력 시 실패', () => {
    const invalidCagi = {
      ...validStudent,
      cagi: { ...validStudent.cagi, q01: 4 } // 0~3만 허용
    };
    const result = validateStudent(invalidCagi);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_CAGI_VALUE')).toBe(true);
  });

  it('잘못된 만족도 문항1 값 입력 시 실패', () => {
    const invalidSatQ1 = {
      ...validStudent,
      satisfaction: { ...validStudent.satisfaction, q01: 0 } // 1~4만 허용
    };
    const result = validateStudent(invalidSatQ1);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_SAT_Q1')).toBe(true);
  });

  it('잘못된 만족도 문항2 (예/아니오) 값 입력 시 실패', () => {
    const invalidSatQ2 = {
      ...validStudent,
      satisfaction: { ...validStudent.satisfaction, q02: 4 } // 0~1만 허용
    };
    const result = validateStudent(invalidSatQ2);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_SAT_BINARY')).toBe(true);
  });

  it('잘못된 만족도 문항7 (5점 척도) 값 입력 시 실패', () => {
    const invalidSatQ7 = {
      ...validStudent,
      satisfaction: { ...validStudent.satisfaction, q07: 5 } // 0~4만 허용
    };
    const result = validateStudent(invalidSatQ7);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_SAT_SCALE')).toBe(true);
  });
});
