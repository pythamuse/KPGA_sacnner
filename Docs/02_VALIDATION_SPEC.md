# VALIDATION_SPEC — 데이터 검증 명세

## 1. 검증 원칙

엑셀 템플릿의 데이터 유효성 검사보다 앱 내부 검증이 더 엄격해야 한다.

이유는 다음과 같다.

1. 엑셀 자체 규칙은 빈칸을 허용한다.
2. 만족도 파일의 E~N열은 엑셀상 0~4를 허용하지만 실제 문항별 의미는 다르다.
3. 중앙 시스템 업로드 실패를 사전에 막으려면 의미 단위 검증이 필요하다.

---

## 2. 공통 필수값 검증

| 필드 | 필수 여부 | 허용값 |
|---|---:|---|
| age | 필수 | 1~20 |
| gender | 필수 | 남, 여 |
| schoolType | 필수 | 초등학교, 중학교, 고등학교, 학교외기관 |
| grade | 필수 | 1학년, 2학년, 3학년, 4학년, 5학년, 6학년, 해당없음 |

빈값, null, undefined, 공백 문자열은 모두 오류로 처리한다.

---

## 3. CAGI 검증

| 필드 | 필수 여부 | 허용값 |
|---|---:|---|
| cagi.q01 | 필수 | 0, 1, 2, 3 |
| cagi.q02 | 필수 | 0, 1, 2, 3 |
| cagi.q03 | 필수 | 0, 1, 2, 3 |
| cagi.q04 | 필수 | 0, 1, 2, 3 |
| cagi.q05 | 필수 | 0, 1, 2, 3 |
| cagi.q06 | 필수 | 0, 1, 2, 3 |
| cagi.q07 | 필수 | 0, 1, 2, 3 |
| cagi.q08 | 필수 | 0, 1, 2, 3 |
| cagi.q09 | 필수 | 0, 1, 2, 3 |

---

## 4. 만족도 검증

| 필드 | 필수 여부 | 허용값 | 설명 |
|---|---:|---|---|
| satisfaction.q01 | 필수 | 1, 2, 3, 4 | 이전 예방교육 참여 횟수 |
| satisfaction.q02 | 필수 | 0, 1 | 아니오/예 |
| satisfaction.q03 | 필수 | 0, 1 | 아니오/예 |
| satisfaction.q04 | 필수 | 0, 1 | 아니오/예 |
| satisfaction.q05 | 필수 | 0, 1 | 아니오/예 |
| satisfaction.q06 | 필수 | 0, 1 | 아니오/예 |
| satisfaction.q07 | 필수 | 0, 1, 2, 3, 4 | 교육 만족도 |
| satisfaction.q08 | 필수 | 0, 1, 2, 3, 4 | 내용·수준 만족도 |
| satisfaction.q09 | 필수 | 0, 1, 2, 3, 4 | 이해 도움 |
| satisfaction.q10 | 필수 | 0, 1, 2, 3, 4 | 강사·콘텐츠 만족도 |

---

## 5. 저장 가능 조건

학생 데이터는 다음 조건을 모두 만족해야 `confirmed` 상태가 된다.

1. 선별검사지 이미지가 존재한다.
2. 만족도 이미지가 존재한다.
3. 기본정보가 모두 유효하다.
4. CAGI 9개 문항이 모두 유효하다.
5. 만족도 10개 문항이 모두 유효하다.
6. 사용자가 확인 화면에서 최종 확인했다.

`confirmed` 상태가 아닌 데이터는 엑셀에 저장하지 않는다.

---

## 6. 오류 메시지 규칙

오류 메시지는 사용자가 바로 조치할 수 있게 작성한다.

| 오류 코드 | 메시지 예시 |
|---|---|
| MISSING_CAGI_IMAGE | 선별검사지 이미지가 없습니다. 선별검사지 앞면을 업로드해주세요. |
| MISSING_SATISFACTION_IMAGE | 만족도 설문 이미지가 없습니다. 만족 및 평가설문 이미지를 업로드해주세요. |
| INVALID_GENDER | 성별 값이 올바르지 않습니다. 남 또는 여 중 하나를 선택해주세요. |
| INVALID_SCHOOL_TYPE | 학교유형 값이 올바르지 않습니다. 초등학교, 중학교, 고등학교, 학교외기관 중 하나를 선택해주세요. |
| INVALID_GRADE | 학년 값이 올바르지 않습니다. 1학년~6학년 또는 해당없음 중 하나를 선택해주세요. |
| INVALID_CAGI_VALUE | CAGI {문항번호} 응답값이 올바르지 않습니다. 0~3 중 하나를 선택해주세요. |
| INVALID_SAT_Q1 | 만족도 문항1 응답값이 올바르지 않습니다. 1~4 중 하나를 선택해주세요. |
| INVALID_SAT_BINARY | 만족도 문항{문항번호} 응답값이 올바르지 않습니다. 아니오 또는 예 중 하나를 선택해주세요. |
| INVALID_SAT_SCALE | 만족도 문항{문항번호} 응답값이 올바르지 않습니다. 0~4 중 하나를 선택해주세요. |
| MULTIPLE_MARKS | 문항{문항번호}에 여러 개의 표시가 감지되었습니다. 올바른 값을 직접 선택해주세요. |
| LOW_CONFIDENCE | 문항{문항번호} 인식 신뢰도가 낮습니다. 원본 이미지를 확인하고 값을 선택해주세요. |

---

## 7. 검증 함수 의사코드

```ts
function validateStudent(student: StudentData): ValidationResult {
  const errors: ValidationError[] = [];

  validateBasic(student.basic, errors);
  validateCagi(student.cagi, errors);
  validateSatisfaction(student.satisfaction, errors);

  if (!student.source.cagiImageId) errors.push({ code: 'MISSING_CAGI_IMAGE' });
  if (!student.source.satisfactionImageId) errors.push({ code: 'MISSING_SATISFACTION_IMAGE' });

  return {
    ok: errors.length === 0,
    errors
  };
}
```
