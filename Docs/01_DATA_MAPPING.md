# DATA_MAPPING — 이미지 응답값·내부 데이터·엑셀 셀 매핑

## 1. 내부 학생 데이터 모델

학생 1명은 다음 구조로 관리한다.

```json
{
  "studentIndex": 1,
  "source": {
    "cagiImageId": "string",
    "satisfactionImageId": "string"
  },
  "basic": {
    "age": 14,
    "gender": "여",
    "schoolType": "중학교",
    "grade": "2학년"
  },
  "cagi": {
    "q01": 0,
    "q02": 0,
    "q03": 0,
    "q04": 0,
    "q05": 0,
    "q06": 0,
    "q07": 0,
    "q08": 0,
    "q09": 0
  },
  "satisfaction": {
    "q01": 4,
    "q02": 1,
    "q03": 1,
    "q04": 1,
    "q05": 1,
    "q06": 1,
    "q07": 4,
    "q08": 4,
    "q09": 4,
    "q10": 4
  },
  "status": "confirmed"
}
```

---

## 2. CAGI 엑셀 매핑

파일: `양식_청소년도박문제선별검사_CAGI_3.xlsx`

시트: `청소년도박문제선별검사`

데이터 시작 행: 3행

| 내부 필드 | 엑셀 열 | 예시값 | 타입 | 비고 |
|---|---|---:|---|---|
| basic.age | A | 14 | number | 만 나이에서 숫자만 추출 |
| basic.gender | B | 여 | string | 남/여 정규화 |
| basic.schoolType | C | 중학교 | string | 4개 허용값 중 하나 |
| basic.grade | D | 2학년 | string | 1~6학년 또는 해당없음 |
| cagi.q01 | E | 0 | number | 0~3 |
| cagi.q02 | F | 0 | number | 0~3 |
| cagi.q03 | G | 0 | number | 0~3 |
| cagi.q04 | H | 0 | number | 0~3 |
| cagi.q05 | I | 0 | number | 0~3 |
| cagi.q06 | J | 0 | number | 0~3 |
| cagi.q07 | K | 0 | number | 0~3 |
| cagi.q08 | L | 0 | number | 0~3 |
| cagi.q09 | M | 0 | number | 0~3 |

---

## 3. 만족도 엑셀 매핑

파일: `청소년예방교육만족도.xlsx`

시트: `청소년예방교육만족도`

데이터 시작 행: 3행

| 내부 필드 | 엑셀 열 | 예시값 | 타입 | 비고 |
|---|---|---:|---|---|
| basic.age | A | 14 | number | 선별검사지에서 복사 |
| basic.gender | B | 여 | string | 선별검사지에서 복사 |
| basic.schoolType | C | 중학교 | string | 선별검사지에서 복사 |
| basic.grade | D | 2학년 | string | 선별검사지에서 복사 |
| satisfaction.q01 | E | 4 | number | 1~4 |
| satisfaction.q02 | F | 1 | number | 0~1 |
| satisfaction.q03 | G | 1 | number | 0~1 |
| satisfaction.q04 | H | 1 | number | 0~1 |
| satisfaction.q05 | I | 1 | number | 0~1 |
| satisfaction.q06 | J | 1 | number | 0~1 |
| satisfaction.q07 | K | 4 | number | 0~4 |
| satisfaction.q08 | L | 4 | number | 0~4 |
| satisfaction.q09 | M | 4 | number | 0~4 |
| satisfaction.q10 | N | 4 | number | 0~4 |

---

## 4. 정규화 규칙

### 4.1 성별

| 원본 인식값 | 저장값 |
|---|---|
| 남 | 남 |
| 남자 | 남 |
| 남학생 | 남 |
| 여 | 여 |
| 여자 | 여 |
| 여학생 | 여 |

`남자`, `여자`는 엑셀에 저장하지 않는다.

### 4.2 학교유형

| 원본 인식값 | 저장값 |
|---|---|
| 초등학교 | 초등학교 |
| 초등 | 초등학교 |
| 중학교 | 중학교 |
| 중등 | 중학교 |
| 고등학교 | 고등학교 |
| 고등 | 고등학교 |
| 학교외기관 | 학교외기관 |
| 학교 외 기관 | 학교외기관 |

### 4.3 학년

| 원본 인식값 | 저장값 |
|---|---|
| 1 | 1학년 |
| 1학년 | 1학년 |
| 2 | 2학년 |
| 2학년 | 2학년 |
| 3 | 3학년 |
| 3학년 | 3학년 |
| 4 | 4학년 |
| 4학년 | 4학년 |
| 5 | 5학년 |
| 5학년 | 5학년 |
| 6 | 6학년 |
| 6학년 | 6학년 |
| 해당 없음 | 해당없음 |
| 해당없음 | 해당없음 |

---

## 5. 예시 이미지 기준 기대값

이번 예시 이미지에서 기대되는 내부 데이터는 다음이다.

```json
{
  "basic": {
    "age": 14,
    "gender": "여",
    "schoolType": "중학교",
    "grade": "2학년"
  },
  "cagi": {
    "q01": 0,
    "q02": 0,
    "q03": 0,
    "q04": 0,
    "q05": 0,
    "q06": 0,
    "q07": 0,
    "q08": 0,
    "q09": 0
  },
  "satisfaction": {
    "q01": 4,
    "q02": 1,
    "q03": 1,
    "q04": 1,
    "q05": 1,
    "q06": 1,
    "q07": 4,
    "q08": 4,
    "q09": 4,
    "q10": 4
  }
}
```

CAGI 엑셀 3행 기대값:

```text
A3=14, B3=여, C3=중학교, D3=2학년,
E3=0, F3=0, G3=0, H3=0, I3=0, J3=0, K3=0, L3=0, M3=0
```

만족도 엑셀 3행 기대값:

```text
A3=14, B3=여, C3=중학교, D3=2학년,
E3=4, F3=1, G3=1, H3=1, I3=1, J3=1, K3=4, L3=4, M3=4, N3=4
```

---

## 2026-08-01 성인 CPGI 트랙 추가

기존 청소년(CAGI) 트랙에 이어 성인(CPGI) 트랙을 추가했다. `StudentData.track` 필드(`'youth' | 'adult'`, 미지정 시 `youth`)로 두 트랙을 구분한다. 내부 필드명(`basic.age/gender`, `cagi.q01~q09`, `satisfaction.q01~q10`)은 두 트랙이 동일하게 재사용하며, 실제 엑셀 컬럼 위치와 허용값만 트랙별로 다르다.

### 성인 CPGI 엑셀 매핑

파일: `양식_성인도박문제선별검사_CPGI.xlsx`

시트: `성인도박문제선별검사`

데이터 시작 행: 3행

성인 템플릿에는 학교유형·학년 컬럼이 없다(성인 대상이므로). 기본정보가 연령대·성별 2개뿐이라 문항이 청소년보다 두 칸 앞당겨 시작한다.

| 내부 필드 | 엑셀 열 | 예시값 | 타입 | 비고 |
|---|---|---:|---|---|
| basic.age | A | 30 | number | 실제 나이가 아니라 20/30/40/50/60/70(대) 코드값 |
| basic.gender | B | 남 | string | 남/여 |
| cagi.q01 | C | 0 | number | 0~3 |
| cagi.q02 | D | 1 | number | 0~3 |
| cagi.q03 | E | 1 | number | 0~3 |
| cagi.q04 | F | 0 | number | 0~3 |
| cagi.q05 | G | 3 | number | 0~3 |
| cagi.q06 | H | 0 | number | 0~3 |
| cagi.q07 | I | 1 | number | 0~3 |
| cagi.q08 | J | 0 | number | 0~3 |
| cagi.q09 | K | 3 | number | 0~3 |

근거: 원본 템플릿의 `x14:dataValidation` sqref `C3:K1048576`가 `코드!$C$2:$C$5`(0~3)를 참조한다. 즉 CPGI 01~09 전 문항이 동일한 0~3 척도이며, CAGI처럼 01~07/08~09를 다른 보기로 나누지 않는다.

### 성인 만족도 엑셀 매핑

파일: `성인예방교육만족도.xlsx`

시트: `성인예방교육만족도`

데이터 시작 행: 3행

| 내부 필드 | 엑셀 열 | 예시값 | 타입 | 비고 |
|---|---|---:|---|---|
| basic.age | A | 30 | number | 20/30/40/50/60/70(대) 코드값 |
| basic.gender | B | 남 | string | 남/여 |
| satisfaction.q01 | C | 1 | number | 0~4 |
| satisfaction.q02 | D | 0 | number | 0~4 |
| satisfaction.q03 | E | 2 | number | 0~4 |
| satisfaction.q04 | F | 1 | number | 0~4 |
| satisfaction.q05 | G | 3 | number | 0~4 |
| satisfaction.q06 | H | 2 | number | 0~4 |
| satisfaction.q07 | I | 1 | number | 0~4 |
| satisfaction.q08 | J | 3 | number | 0~4 |
| satisfaction.q09 | K | 3 | number | 0~4 |
| satisfaction.q10 | L | 4 | number | 0~4 |

근거: 원본 템플릿의 `x14:dataValidation` sqref `C3:L1048576`(전 문항)이 `코드!$D$2:$D$6`(0~4)만 참조한다. 청소년 만족도처럼 문항1(1~4)·문항2~6(0/1)·문항7~10(0~4)으로 나뉘지 않고, 문항1~10 전부 0~4 균일 척도다. `코드` 시트에는 `문항A`(0/1) 정의도 남아있지만 실제 어떤 컬럼에도 연결(sqref)되어 있지 않다.

### 연령대 코드 정규화

`normalizeAdultAgeBand()`가 처리한다.

| 원본 인식값 | 저장값 |
|---|---:|
| 20, 30, 40, 50, 60, 70 | 그대로 |
| 35(실제 나이) | 30 (10 단위로 내림) |
| 8 | 정규화 실패 (20 미만은 매핑되는 연령대가 없음) |

### 관련 코드

- `src/lib/excel/writeCagi.ts`의 `writeCpgiRow`
- `src/lib/excel/writeSatisfaction.ts`의 `writeAdultSatisfactionRow`
- `src/lib/excel/templateManager.ts`의 `getTemplateFiles(track)` (트랙별 정확한 파일명으로 템플릿을 찾는다)
