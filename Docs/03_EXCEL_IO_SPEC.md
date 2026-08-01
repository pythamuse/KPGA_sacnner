# EXCEL_IO_SPEC — 엑셀 입출력 명세

## 1. 원본 템플릿

서버에는 다음 두 원본 템플릿을 보관한다.

1. `templates/cagi/양식_청소년도박문제선별검사_CAGI_3.xlsx`
2. `templates/satisfaction/청소년예방교육만족도.xlsx`

사용자가 새 작업을 시작하면 원본 템플릿을 직접 수정하지 않고, 작업 세션별 복사본을 만든다.

---

## 2. 파일별 시트명

| 파일 | 입력 시트명 | 코드 시트명 |
|---|---|---|
| CAGI | 청소년도박문제선별검사 | 코드 |
| 만족도 | 청소년예방교육만족도 | 코드 |

시트명을 하드코딩하되, 저장 전 존재 여부를 검증한다. 시트명이 없으면 템플릿 오류로 처리한다.

---

## 3. 입력 시작 행

두 파일 모두 3행부터 실제 학생 데이터를 입력한다.

| 학생 순번 | 엑셀 행 |
|---:|---:|
| 1 | 3 |
| 2 | 4 |
| 3 | 5 |
| 10 | 12 |

행을 새로 삽입하지 않는다. 다음 빈 행에 값을 쓴다.

---

## 4. 다음 빈 행 계산

### 4.1 원칙

CAGI 파일과 만족도 파일의 행 번호는 항상 동일해야 한다.

따라서 다음 빈 행은 앱 내부 학생 리스트 기준으로 계산하는 것을 권장한다.

```ts
const targetRow = 3 + confirmedStudents.length;
```

파일에서 직접 빈 행을 찾는 경우 CAGI와 만족도 파일의 상태가 불일치할 수 있으므로 주의한다.

### 4.2 저장 트랜잭션

학생 1명 저장 시 다음 순서를 따른다.

1. 학생 데이터 검증
2. 대상 행 번호 계산
3. CAGI 행 데이터 생성
4. 만족도 행 데이터 생성
5. 두 워크북에 값 입력
6. 저장 전 메모리 검증
7. 두 워크북 저장
8. 저장 성공 후 학생 상태를 saved로 변경

어느 한 단계라도 실패하면 두 파일 모두 저장하지 않는다.

---

## 5. CAGI 행 쓰기

```ts
function writeCagiRow(sheet, row, student) {
  sheet.getCell(`A${row}`).value = student.basic.age;
  sheet.getCell(`B${row}`).value = student.basic.gender;
  sheet.getCell(`C${row}`).value = student.basic.schoolType;
  sheet.getCell(`D${row}`).value = student.basic.grade;
  sheet.getCell(`E${row}`).value = student.cagi.q01;
  sheet.getCell(`F${row}`).value = student.cagi.q02;
  sheet.getCell(`G${row}`).value = student.cagi.q03;
  sheet.getCell(`H${row}`).value = student.cagi.q04;
  sheet.getCell(`I${row}`).value = student.cagi.q05;
  sheet.getCell(`J${row}`).value = student.cagi.q06;
  sheet.getCell(`K${row}`).value = student.cagi.q07;
  sheet.getCell(`L${row}`).value = student.cagi.q08;
  sheet.getCell(`M${row}`).value = student.cagi.q09;
}
```

---

## 6. 만족도 행 쓰기

```ts
function writeSatisfactionRow(sheet, row, student) {
  sheet.getCell(`A${row}`).value = student.basic.age;
  sheet.getCell(`B${row}`).value = student.basic.gender;
  sheet.getCell(`C${row}`).value = student.basic.schoolType;
  sheet.getCell(`D${row}`).value = student.basic.grade;
  sheet.getCell(`E${row}`).value = student.satisfaction.q01;
  sheet.getCell(`F${row}`).value = student.satisfaction.q02;
  sheet.getCell(`G${row}`).value = student.satisfaction.q03;
  sheet.getCell(`H${row}`).value = student.satisfaction.q04;
  sheet.getCell(`I${row}`).value = student.satisfaction.q05;
  sheet.getCell(`J${row}`).value = student.satisfaction.q06;
  sheet.getCell(`K${row}`).value = student.satisfaction.q07;
  sheet.getCell(`L${row}`).value = student.satisfaction.q08;
  sheet.getCell(`M${row}`).value = student.satisfaction.q09;
  sheet.getCell(`N${row}`).value = student.satisfaction.q10;
}
```

---

## 7. 데이터 타입

| 값 | 엑셀 타입 |
|---|---|
| age | number |
| gender | string |
| schoolType | string |
| grade | string |
| cagi 응답 | number |
| satisfaction 응답 | number |

숫자값을 문자열로 저장하지 않는다. 특히 `"0"`, `"1"` 대신 `0`, `1`로 저장한다.

---

## 8. 데이터 유효성 검사 보존

기존 엑셀 템플릿의 유효성 검사는 일반적인 `dataValidations`가 아니라 Excel 확장 영역인 `x14:dataValidations`에 존재한다.

따라서 다음 보존 조건을 만족해야 한다.

1. 원본 workbook structure 보존
2. 시트명 보존
3. 병합셀 보존
4. 스타일 보존
5. 코드 시트 보존
6. extLst 보존
7. x14:dataValidations 보존

개발 중 사용하는 라이브러리가 저장 과정에서 x14 확장 영역을 제거할 가능성이 있다. 반드시 저장 후 파일을 재열어 드롭다운이 유지되는지 확인한다.

---

## 9. 엑셀 저장 후 검증

저장 후 다음을 자동 검증한다.

| 검증 | 성공 조건 |
|---|---|
| 파일 열기 | 저장된 xlsx가 정상적으로 열림 |
| 시트 존재 | 지정 시트와 코드 시트가 존재함 |
| 3행 값 확인 | 저장한 값과 읽은 값이 일치함 |
| 드롭다운 보존 | A~D 및 문항 열의 데이터 유효성 검사 유지 |
| 행 번호 일치 | 두 파일의 학생 데이터 행 수가 동일함 |
| 잘못된 값 없음 | 앱 내부 검증 재통과 |

---

## 10. 파일명 규칙

다운로드 파일명 예시:

```text
도박예방교육_CAGI_2026-07-09.xlsx
도박예방교육_만족도_2026-07-09.xlsx
```

학교명 또는 기관명을 사용자가 입력하는 경우:

```text
도박예방교육_CAGI_2026-07-09_○○중학교.xlsx
도박예방교육_만족도_2026-07-09_○○중학교.xlsx
```

---

## 11. 성인 CPGI 트랙 지원 (2026-08-01 추가)

### 11.1 원본 템플릿 추가

서버는 트랙별로 다음 4개 원본 템플릿을 보관한다.

1. `templates/cagi/양식_청소년도박문제선별검사_CAGI_3.xlsx` (청소년)
2. `templates/cagi/양식_성인도박문제선별검사_CPGI.xlsx` (성인)
3. `templates/satisfaction/청소년예방교육만족도.xlsx` (청소년)
4. `templates/satisfaction/성인예방교육만족도.xlsx` (성인)

**주의(중요, 사고 이력 있음):** `templates/cagi/`와 `templates/satisfaction/` 디렉터리에 각각 청소년·성인 파일이 함께 들어있다. `getTemplateFiles(track)`는 반드시 트랙별 **정확한 파일명**으로 찾아야 하며, "디렉터리의 첫 `.xlsx` 파일을 그냥 집는" 방식은 절대 쓰지 않는다. 과거 이 방식(`fs.readdirSync().find(...)`) 때문에 성인 템플릿이 먼저 열거되어 청소년 작업에 성인 파일이 잘못 복사되고 저장이 전부 500 에러로 실패한 사고가 있었다. 새 템플릿 파일을 추가할 때도 이 규칙을 반드시 지킨다.

### 11.2 트랙별 시트명 및 컬럼

| 트랙 | CAGI/CPGI 시트명 | 만족도 시트명 | 기본정보 컬럼 | 문항 컬럼 |
|---|---|---|---|---|
| 청소년 | 청소년도박문제선별검사 | 청소년예방교육만족도 | A~D (연령·성별·학교유형·학년) | CAGI E~M, 만족도 E~N |
| 성인 | 성인도박문제선별검사 | 성인예방교육만족도 | A~B (연령대·성별만) | CPGI C~K, 만족도 C~L |

상세 값 매핑은 `01_DATA_MAPPING.md` 8절, 검증 규칙은 `02_VALIDATION_SPEC.md` 8절을 따른다.

### 11.3 트랙 전달 경로

- `POST /api/jobs` 요청 바디에 `{ track: 'youth' | 'adult' }`를 담아 보낸다. 생략 시 `youth`.
- 작업 세션(`JobSession.track`)에 트랙을 저장하고, 이후 업로드·인식·저장·다운로드 API는 모두 세션의 track을 신뢰의 기준으로 삼는다(클라이언트가 매 요청마다 track을 다시 보낼 필요 없음).
- `restoreExtLst()`와 `verifyWorkbooks()`는 시트명을 인자로 받아 `workbook.xml`/`workbook.xml.rels`를 따라가 실제 시트 XML 파일을 찾는다. 기존에는 `xl/worksheets/sheet1.xml`을 하드코딩했는데, 이는 우연히 4개 템플릿 모두 입력 시트가 rId1인 경우에만 맞는 가정이었다. 새 템플릿을 받을 때는 반드시 `xl/workbook.xml`을 열어 입력 시트의 `r:id`가 실제로 몇 번 시트 XML에 연결되는지 다시 확인한다.

### 11.4 성인 양식 인식(OCR/ROI) 제한

성인 CPGI·만족도 양식은 아직 실제 촬영 샘플이 없어 좌표 기반 체크마크 인식(ROI)을 보정하지 못했다. `POST /api/recognize`는 세션 track이 `adult`이면 청소년용 ROI 인식 파이프라인을 타지 않고, 업로드 칸(파일명 prefix) 기준 장수만 맞춘 뒤 전 항목을 `low` confidence로 비운 수동 입력 draft를 반환한다(`src/lib/recognition/adultDraft.ts`). 실제 성인 양식 촬영 샘플이 확보되면 `04_OCR_FORM_RECOGNITION_SPEC.md`에 정의된 절차대로 ROI 좌표를 새로 정의해야 한다.
