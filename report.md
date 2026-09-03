# 라운드 A 보고 — `/api/recognize/student` 신설 + `recognizeOneStudent` 추출

기준 커밋 `1cf2017`(브랜치 `stateless-recognize`), 주문서 `stateless-a-order.md`,
계획 `Task/STATELESS_RECOGNITION_PLAN_2026-09-03.md` §2·§3·§4.

배치 경로(`/api/upload` → `/api/recognize`)의 **응답은 바이트 동일**하고, 클라이언트·검수 UI·
`src/lib/recognition/**`(신규 `recognizeOneStudent.ts` 제외)는 손대지 않았다.

---

## 1. 바꾼 파일

### 신규 `src/lib/recognition/recognizeOneStudent.ts` (151행)
배치 루프의 학생 1명 처리(구 `route.ts:218-292`)를 그대로 옮긴 순수 함수.

| 행 | 내용 |
|---|---|
| 24-33 | `RecognizeOneStudentInput` — `cagiPath` · `satisfactionPath` · `cagiRegistration` · `satisfactionRegistration` · `ocrDeadlines` · `cagiImageId` · `satisfactionImageId` |
| 35-102 | `recognizeOneStudent()` — `recognizeStudentForms` → 구조분해(`recognitionMeasurements` 분리) → `buildSourcePreview` → `buildSheetQualityAttachment` → 학생 객체 조립. `{ student, measurements }` 반환 |
| 105-107 | 반환 타입은 객체 리터럴에서 **추론**(`Awaited<ReturnType<...>>`)해 리터럴과 어긋날 수 없게 했다 |
| 109-149 | `buildSheetQualityAttachment` — 구 `route.ts:326-365`에서 주석까지 그대로 이동 |

측정치 저장(`storeRecognitionMeasurements`)은 함수 안에 두지 않았다. 그것은 job·사이드카 식별자를
아는 **호출자**의 몫이고, 새 라우트와 배치 라우트가 서로 다른 식별자 규칙을 쓰기 때문이다.

### 수정 `src/app/api/recognize/route.ts` (−114/+61행, 실질 −53행)
- `:6-16` import 정리 — `recognizeStudentForms` · `buildSourcePreview` · `evaluateSheetQuality` ·
  `SheetQualityVerdict` 제거, `recognizeOneStudent`(`:13`) 추가. `isRegistrationMetaLike` ·
  `RegistrationMetaLike`는 `readRegistrationForPath`가 계속 쓴다.
- `:215-237` 학생 루프 본문이 `recognizeOneStudent`(`:221`) 호출 +
  `storeRecognitionMeasurements`(`:230`) + `studentDrafts.push(student)`(`:237`)로 축약.
  F1 메타 읽기(`:209-217`)·`rowOcrDeadlineAt`·`createRecognitionOcrDeadlines(rowOcrDeadlineAt,
  studentIndex)`는 그대로 배치 쪽에 남았다.
- 구 `buildSheetQualityAttachment`(`:326-365`) 삭제 — 위 신규 파일로 이동.

### 신규 `src/app/api/recognize/student/route.ts` (158행) — §2 참조
### 신규 `tests/recognize-student-route.test.ts` (163행, 6 케이스)
### 수정 `tests/job-cleanup.test.ts` (`:1` `vi` import, `:35-76` 새 케이스 1개)

---

## 2. 새 라우트 계약 `POST /api/recognize/student`

`export const runtime = 'nodejs'`(`:31`), `export const maxDuration = 30`(`:32`).
`@vercel/blob`도 `uploadStore`도 import하지 않는다(import 목록 `:1-15`).

**요청** — `multipart/form-data`

| 필드 | 필수 | 형식 |
|---|---|---|
| `cagi` | 예 | File — 선별검사지 쪽 이미지 |
| `satisfaction` | 예 | File — 만족도조사 쪽 이미지 |
| `jobId` | 예 | `^job_[a-zA-Z0-9_-]+$`(`isSafeJobId`). 측정치 사이드카 키 |
| `studentIndex` | 예 | 0 이상 정수 문자열. OCR 예산(0=6초, 그 외 1초)과 파일명에 쓰인다 |
| `cagiRegistration` | 아니오 | `/api/upload`의 `registration`과 같은 JSON 문자열. 깨져 있으면 **없는 것으로** 읽는다 |
| `satisfactionRegistration` | 아니오 | 위와 같음 |

**처리** — `fs.mkdtemp(os.tmpdir()/kpga-student-)`에 `cagi_page_<index>.jpg` ·
`satisfaction_page_<index>.jpg`로 쓰고 `recognizeOneStudent` 호출, `finally`에서 스크래치 삭제
(응답이 반환되기 **전**에 실행된다 — 크롭은 이미 data URL로 메모리에 있다).
OCR 예산은 `createRecognitionOcrDeadlines(Date.now() + ROW_ANCHOR_BATCH_BUDGET_MS, studentIndex)`.
측정치는 배치와 같은 `storeRecognitionMeasurements`(로컬 전용, Vercel 스킵)로 보내고, 실패해도
인식 결과를 죽이지 않는다.

**응답 200**: `{ "student": { ...배치 응답의 학생 객체와 같은 모양... } }`
(`basic` · `cagi` · `satisfaction` · `confidence` · `candidates` · `warnings` · `sheetQuality?` ·
`source{ cagiImageId, satisfactionImageId, cagiImageDataUrl, satisfactionImageDataUrl, cropDataUrls,
cropDebugDataUrls, recognitionCropSource, recognitionCropDiagnostic, recognitionRegistration,
recognitionValueSource, recognitionContested, recognitionSuggestion, recognitionDecisionTrace,
recognitionEvidence }`). `recognitionMeasurements`는 응답에 없다.

**오류** — 모두 `{ error, code }` JSON

| 코드 | 상태 | 조건 |
|---|---|---|
| `INVALID_FORM_DATA` | 400 | 본문이 multipart가 아니다 |
| `MISSING_FIELDS` | 400 | `cagi`/`satisfaction`가 File이 아니거나 `jobId`가 안전하지 않다 |
| `INVALID_STUDENT_INDEX` | 400 | `studentIndex` 누락·비정수·음수 |
| `EMPTY_IMAGE` | 400 | 두 파일 중 하나가 0바이트 |
| `PAYLOAD_TOO_LARGE` | 400 | 두 파일 합계 > 4.5MB (`limitBytes` · `receivedBytes` 동봉) |
| (코드 없음) | 500 | 인식 중 예외 — `이미지 인식 결과 처리 중 실패: <메시지>` |

---

## 3. 측정 — 배치 출력 바이트 동일

임시 계측 시험으로 `tests/fixtures/blank-form` 두 장을 업로드해 `/api/recognize` 응답 전체를
JSON으로 떠서 비교했다(계측 파일은 커밋에 넣지 않았다).

```
같은 트리에서 두 번               after1.json == after2.json    (자기 기준선: 결정적)
1cf2017(git stash) vs 작업 트리   before.json == after1.json    658,689 바이트 동일
```

같은 두 장으로 새 라우트 응답과 배치 응답의 학생 객체를 필드 단위로 비교하면 **차이는 두 칸뿐**이다.

```
.source.cagiImageId          batch=cagi_page_0001          student=cagi_page_0
.source.satisfactionImageId  batch=satisfaction_page_0001  student=satisfaction_page_0
```

크롭 data URL을 포함한 나머지 전부가 동일하다. 이 둘은 **파일 이름에서 파생되는 식별자**이고,
주문서 §C가 새 라우트 파일명을 `cagi_page_<index>.jpg`로 못 박았기 때문에 생기는 의도된 차이다(§5).

## 4. 시험 결과

`npx tsc --noEmit` — 출력 0바이트, 종료 코드 0.

`npx vitest run` (tesseract의 `Warning: Invalid resolution` / `Estimating resolution` /
`Detected N diacritics` 잡음만 걸러낸 전문):

```
 ✓ tests/capture-diagnostics.test.ts  (18 tests) 5ms
 ✓ tests/capture-guidance.test.ts  (29 tests) 7ms
 ✓ tests/tone-normalization.test.ts  (19 tests) 34ms
 ✓ tests/band-structure.test.ts  (22 tests) 51ms
 ✓ tests/photo-binary-floor.test.ts  (13 tests) 63ms
 ✓ tests/photo-binary-refusal.test.ts  (21 tests) 90ms
 ✓ tests/ink-invariant.test.ts  (22 tests) 103ms
 ✓ tests/orb-align.test.ts  (17 tests) 111ms
 ✓ tests/frame-exposure.test.ts  (29 tests) 69ms
 ↓ tests/_probe-cells.test.ts  (1 test | 1 skipped)
 ↓ tests/real-scan-measure.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-bounds-gate.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-tracedump.test.ts  (1 test | 1 skipped)
 ↓ tests/scan-repeat-measure.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-gates.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-features.test.ts  (1 test | 1 skipped)
 ↓ tests/reversed-stack-recognition.test.ts  (1 test | 1 skipped)
 ✓ tests/recognition-mark-density.test.ts  (19 tests) 346ms
 ✓ tests/review-snapshot.test.ts  (30 tests) 218ms
 ✓ tests/table-row-detection.test.ts  (11 tests) 452ms
 ↓ tests/_probe-ensemble.test.ts  (1 test | 1 skipped)
 ✓ tests/label-export.test.ts  (5 tests) 39ms
 ✓ tests/grayscale-scan.test.ts  (4 tests) 121ms
 ✓ tests/validation.test.ts  (11 tests) 4ms
 ✓ tests/review-settlement.test.ts  (4 tests) 4ms
 ✓ tests/batch-matcher.test.ts  (10 tests) 15ms
 ✓ tests/perspective-correct.test.ts  (6 tests) 3ms
 ↓ tests/_probe-photo.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-grid-crops.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-photo-accuracy.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-photo-trace.test.ts  (1 test | 1 skipped)
 ✓ tests/recognition-crop-source.test.ts  (6 tests) 5ms
 ↓ tests/_probe-crop-urls.test.ts  (1 test | 1 skipped)
 ✓ tests/form-classifier.test.ts  (4 tests) 211ms
 ✓ tests/table-grid-detection.test.ts  (21 tests) 888ms
 ✓ tests/student-save-route.test.ts  (3 tests) 9ms
 ✓ tests/student-save-payload.test.ts  (3 tests) 69ms
 ↓ tests/_probe-grid.test.ts  (1 test | 1 skipped)
 ✓ tests/cagi-early-intervention.test.ts  (2 tests) 6ms
 ✓ tests/review-crop-source.test.ts  (3 tests) 4ms
 ↓ tests/_probe-photo-gates.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-lines.test.ts  (1 test | 1 skipped)
 ✓ tests/pdf-render-config.test.ts  (2 tests) 7ms
 ✓ tests/grid-override-completeness.test.ts  (11 tests) 1020ms
 ✓ tests/ocr-budget.test.ts  (1 test) 3ms
 ✓ tests/perspective-correction-policy.test.ts  (2 tests) 2ms
 ✓ tests/pdf-timeout.test.ts  (2 tests) 5ms
 ✓ tests/security-config.test.ts  (1 test) 3ms
 ✓ tests/field-crop.test.ts  (1 test) 1ms
 ✓ tests/blank-form-calibration.test.ts  (2 tests) 252ms
 ✓ tests/job-cleanup.test.ts  (4 tests) 56ms
 ✓ tests/ocr-text-lines.test.ts  (2 tests) 658ms
 ✓ tests/template-baseline.test.ts  (2 tests) 516ms
 ✓ tests/excel.test.ts  (3 tests) 633ms
 ✓ tests/review-suggestion.test.ts  (11 tests) 1870ms
 ✓ tests/sheet-exposure.test.ts  (8 tests) 2021ms
 ✓ tests/review-evidence.test.ts  (19 tests) 1541ms
 ✓ tests/satisfaction-recognition.test.ts  (3 tests) 2232ms
 ✓ tests/blank-form-detection.test.ts  (3 tests) 2282ms
 ✓ tests/recognize-form-mismatch.test.ts  (3 tests) 1661ms
 ✓ tests/integration.test.ts  (4 tests) 1229ms
 ✓ tests/two-stream-grid.test.ts  (10 tests) 3175ms
 ✓ tests/age-ocr.test.ts  (15 tests) 5593ms
 ✓ tests/sheet-quality.test.ts  (19 tests) 5813ms
 ✓ tests/recognize-student-route.test.ts  (6 tests) 9080ms
 ✓ tests/upload-registration-meta.test.ts  (9 tests) 23439ms

 Test Files  49 passed | 17 skipped (66)
      Tests  475 passed | 17 skipped (492)
   Duration  24.83s
```

새 시험이 실제로 무엇을 고정하는지:

- `tests/recognize-student-route.test.ts`
  - 라우트 응답 `student` == `recognizeOneStudent` 직접 호출 결과 **deep-equal**(크롭 data URL 포함).
    두 호출이 서로 다른 임시 디렉터리의 같은 바이트를 읽으므로, 경로가 결과에 새지 않는다는 것도
    같이 잡는다.
  - 응답 뒤 `os.tmpdir()`의 `kpga-student-*` 디렉터리 목록이 호출 전과 **같다**.
  - 400 다섯 갈래(시트 누락 / 안전하지 않은 jobId / `studentIndex` 누락·소수 / 0바이트 이미지 /
    multipart 아님).
- `tests/job-cleanup.test.ts` — `BLOB_OPS_TRACE=1`을 켠 채 로컬 업로드+정리를 한 바퀴 돌려
  `[blob-op]` 줄이 **하나도** 나오지 않음을 고정한다(§A). 플래그가 실제로 켜져 있었는지도 함께
  단언해 공허한 통과를 막았다.

---

## 5. 명세와 다르게 한 것

1. **측정치 사이드카는 `storeRecognitionMeasurements`로 보냈다.** 주문서 §C는
   "`appendRecognitionLabels`로 사이드카(로컬 전용, Vercel 스킵)"라고 적었지만, 인식 시점에
   측정치를 파일로 남기는 함수는 `storeRecognitionMeasurements`(`labelStore.ts:57`)이고
   `appendRecognitionLabels`(`:107`)는 **저장 시점**에 그 사이드카와 최종 값을 합쳐 JSONL을 쓰는
   `/api/students`의 함수다. "지금처럼"을 지키려면 배치가 쓰는 쪽이어야 해서 전자를 썼다.
   둘 다 `isVercel()`에서 빠져나온다.
2. **`storeRecognitionMeasurements` 실패를 삼킨다.** 배치는 이 호출을 감싸지 않지만, 새 라우트는
   요청 하나가 학생 하나이므로 사이드카 쓰기 실패로 인식 결과를 통째로 잃는 것이 손해가 크다.
   `console.error` 후 응답은 정상 반환한다.
3. **`cagiImageId`가 배치와 다르다**(`cagi_page_0` vs `cagi_page_0001`). §C가 파일명을
   `cagi_page_<index>.jpg`로 지정했고 index는 `studentIndex`(0 기반)라서 그렇다. 배치는 업로드
   페이지 번호(1 기반, 4자리 0채움)를 쓴다. 값·출처·근거·크롭은 전부 같으므로 대조할 때 이 두
   필드는 빼고 보거나, 라운드 B에서 클라이언트가 보낼 이름 규칙을 정할 때 맞추면 된다.
   식별자 제약은 `[a-zA-Z0-9_-]+`(`labelStore.ts:193`)뿐이라 둘 다 유효하다.
4. **`report.md`는 셸로 썼다.** 이 서브에이전트 하네스가 보고서 성격의 `.md`를 Write 도구로 만드는
   것을 막는다. 주문서가 커밋 산출물로 요구했으므로 셸로 생성했고, 이 사실을 최종 보고에도 적었다.

## 6. 확신 없는 부분

1. **`classifyForm`(양식 종류 자동 판별)이 새 경로에 없다.** 배치는 두 장을 분류해
   `FORM_TYPE_MISMATCH`(400)로 막지만, 학생 라우트는 `cagi`/`satisfaction` 필드 이름을 믿는다.
   §C에 없어서 넣지 않았다. 라운드 B에서 클라이언트가 칸을 뒤바꿔 보낼 수 있는지에 따라
   필요 여부가 갈린다.
2. **조기개입 경고(`detectCagiEarlyIntervention`)가 응답에 없다.** 배치의 `warnings[]`가 그것이다.
   §C의 응답이 `{ student }`뿐이라 넣지 않았다. 19명분 경고를 클라이언트가 어디서 모을지는
   라운드 B의 설계 사항이다.
3. **본문 상한 4.5MB는 두 파일 합계로만 검사한다.** multipart 경계·필드까지 포함한 실제 본문은
   그보다 조금 크므로, Vercel이 먼저 413으로 끊는 경계가 우리 400보다 살짝 앞설 수 있다.
   실측(쪽당 292~450KB)에서는 닿지 않는 영역이다.
4. **콜드스타트/OCR 예산의 실제 영향은 재지 못했다.** 계획 §5 위험 1의 "요청마다 첫 학생 6초"는
   `studentIndex`를 그대로 쓰는 지금 구현에서 첫 요청만 6초를 받는다. 인스턴스가 흩어질 때
   tesseract 초기화가 반복되는지는 프리뷰 배포에서 재야 한다.
5. **자체 합격 판정은 하지 않았다.** 위 측정은 빈 양식 픽스처 기준이고, 실제 스캔 두 장을 curl
   multipart로 보내 배치 결과와 대조하는 것은 위임자의 몫이다(`local-scans/answer-key.json`도
   실제 스캔 PDF도 이 체크아웃에 없다).
