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
