import { StudentData, ValidationError, ValidationResult, FormTrack } from './types';
import { normalizeGender, normalizeSchoolType, normalizeGrade, normalizeAge, normalizeAdultAgeBand } from './normalize';

const ADULT_AGE_BANDS = [20, 30, 40, 50, 60, 70];

export function validateStudent(student: Partial<StudentData>): ValidationResult {
  const track: FormTrack = student.track === 'adult' ? 'adult' : 'youth';
  const errors: ValidationError[] = [];

  // 1. 이미지 존재 여부 검증
  if (!student.source?.cagiImageId) {
    errors.push({
      code: 'MISSING_CAGI_IMAGE',
      message: '선별검사지 이미지가 없습니다. 선별검사지 앞면을 업로드해주세요.',
      field: 'source.cagiImageId'
    });
  }
  if (!student.source?.satisfactionImageId) {
    errors.push({
      code: 'MISSING_SATISFACTION_IMAGE',
      message: '만족도 설문 이미지가 없습니다. 만족 및 평가설문 이미지를 업로드해주세요.',
      field: 'source.satisfactionImageId'
    });
  }

  // 2. 기본 정보 검증
  const basic = student.basic || {};
  const gender = normalizeGender(basic.gender);
  if (!gender || !['남', '여'].includes(gender)) {
    errors.push({
      code: 'INVALID_GENDER',
      message: '성별 값이 올바르지 않습니다. 남 또는 여 중 하나를 선택해주세요.',
      field: 'basic.gender'
    });
  }

  if (track === 'adult') {
    // 성인 CPGI/만족도 템플릿은 연령대(20/30/40/50/60/70)만 있고 학교유형·학년 컬럼이 없다.
    const ageBand = normalizeAdultAgeBand(basic.age);
    if (ageBand === undefined || !ADULT_AGE_BANDS.includes(ageBand)) {
      errors.push({
        code: 'INVALID_AGE_BAND',
        message: '연령대 값이 올바르지 않습니다. 20대~70대 중 하나를 선택해주세요.',
        field: 'basic.age'
      });
    }
  } else {
    const age = normalizeAge(basic.age);
    const schoolType = normalizeSchoolType(basic.schoolType);
    const grade = normalizeGrade(basic.grade);

    if (age === undefined || age < 1 || age > 20) {
      errors.push({
        code: 'INVALID_AGE',
        message: '나이 값이 올바르지 않습니다. 1~20세 사이여야 합니다.',
        field: 'basic.age'
      });
    }

    const allowedSchoolTypes = ['초등학교', '중학교', '고등학교', '학교외기관'];
    if (!schoolType || !allowedSchoolTypes.includes(schoolType)) {
      errors.push({
        code: 'INVALID_SCHOOL_TYPE',
        message: '학교유형 값이 올바르지 않습니다. 초등학교, 중학교, 고등학교, 학교외기관 중 하나를 선택해주세요.',
        field: 'basic.schoolType'
      });
    }

    const allowedGrades = ['1학년', '2학년', '3학년', '4학년', '5학년', '6학년', '해당없음'];
    if (!grade || !allowedGrades.includes(grade)) {
      errors.push({
        code: 'INVALID_GRADE',
        message: '학년 값이 올바르지 않습니다. 1학년~6학년 또는 해당없음 중 하나를 선택해주세요.',
        field: 'basic.grade'
      });
    }
  }

  // 3. CAGI/CPGI 9개 문항 검증 (두 트랙 모두 0~3, 문항 수 동일)
  const cagi = student.cagi || {};
  const cagiKeys = ['q01', 'q02', 'q03', 'q04', 'q05', 'q06', 'q07', 'q08', 'q09'];
  cagiKeys.forEach((key, idx) => {
    const val = cagi[key];
    const numStr = String(idx + 1).padStart(2, '0');
    if (val === undefined || val === null || ![0, 1, 2, 3].includes(val)) {
      errors.push({
        code: 'INVALID_CAGI_VALUE',
        message: `CAGI ${numStr} 응답값이 올바르지 않습니다. 0~3 중 하나를 선택해주세요.`,
        field: `cagi.${key}`
      });
    }
  });

  // 4. 만족도 10개 문항 검증
  const sat = student.satisfaction || {};

  if (track === 'adult') {
    // 성인 만족도 템플릿은 x14:dataValidation sqref가 C3:L(전 문항)에 걸쳐
    // 코드!D2:D6(0~4)만 참조한다 - 문항1~10 전부 동일한 5점 척도다.
    const allKeys = ['q01', 'q02', 'q03', 'q04', 'q05', 'q06', 'q07', 'q08', 'q09', 'q10'];
    allKeys.forEach((key) => {
      const val = sat[key];
      const num = parseInt(key.replace('q', ''), 10);
      if (val === undefined || val === null || ![0, 1, 2, 3, 4].includes(val)) {
        errors.push({
          code: 'INVALID_SAT_SCALE',
          message: `만족도 문항${num} 응답값이 올바르지 않습니다. 0~4 중 하나를 선택해주세요.`,
          field: `satisfaction.${key}`
        });
      }
    });
  } else {
    // Q1 (이전 참여 횟수: 1~4)
    if (sat.q01 === undefined || sat.q01 === null || ![1, 2, 3, 4].includes(sat.q01)) {
      errors.push({
        code: 'INVALID_SAT_Q1',
        message: '만족도 문항1 응답값이 올바르지 않습니다. 1~4 중 하나를 선택해주세요.',
        field: 'satisfaction.q01'
      });
    }

    // Q2~Q6 (예/아니오: 0, 1)
    const binaryKeys = ['q02', 'q03', 'q04', 'q05', 'q06'];
    binaryKeys.forEach((key) => {
      const val = sat[key];
      const num = parseInt(key.replace('q', ''), 10);
      if (val === undefined || val === null || ![0, 1].includes(val)) {
        errors.push({
          code: 'INVALID_SAT_BINARY',
          message: `만족도 문항${num} 응답값이 올바르지 않습니다. 아니오 또는 예 중 하나를 선택해주세요.`,
          field: `satisfaction.${key}`
        });
      }
    });

    // Q7~Q10 (5점 척도: 0~4)
    const scaleKeys = ['q07', 'q08', 'q09', 'q10'];
    scaleKeys.forEach((key) => {
      const val = sat[key];
      const num = parseInt(key.replace('q', ''), 10);
      if (val === undefined || val === null || ![0, 1, 2, 3, 4].includes(val)) {
        errors.push({
          code: 'INVALID_SAT_SCALE',
          message: `만족도 문항${num} 응답값이 올바르지 않습니다. 0~4 중 하나를 선택해주세요.`,
          field: `satisfaction.${key}`
        });
      }
    });
  }

  return {
    ok: errors.length === 0,
    errors
  };
}
