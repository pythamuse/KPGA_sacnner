# B-11 저장 출처·settlement 구현 보고서

## 바꾼 파일:행

- `src/lib/review/settlement.ts:1-44` — 23개 검수 필드 목록, `isSettledSource`, `unconfirmedMachineFields` 순수 함수.
- `src/lib/validation/types.ts:1,37-40` — `StudentData.source.recognitionValueSource` 타입 확장.
- `src/app/api/students/route.ts:12,31-79` — 자동/복원 값 서버 차단, source map 화이트리스트 보존, source map 유무에 따른 `confirmed`/`saved` 상태.
- `src/app/page.tsx:10-12,48-70,420-425,554-631` — 클라이언트 저장 방어와 저장 행의 필드별 출처 복원.
- `src/components/RecognitionReview.tsx:8,117-118,193-195,498-501,678-699,906-914,1225-1233,1467-1498` — `restored` 미확정 판정, 주의 목록·점프·확인 버튼·카드·저장 게이트 및 안내 문구.
- `tests/review-settlement.test.ts:1-47` — settlement 순수 함수 테스트.
- `tests/student-save-route.test.ts:1-73` — `/api/students` 직접 호출 테스트.
- `tests/student-save-payload.test.ts:26,58` — 새 source map이 slim payload에 남는지 확인.
- `tests/review-snapshot.test.ts:168-200,253-269` — snapshot source map 보존 및 restored UI 테스트.
- `tests/label-export.test.ts:8,48` — `StudentData.source` 타입 확장에 맞춘 테스트 헬퍼 타입 보정만 수행.
- `report.md` — 이 보고서.

## 출처 맵 직렬화 크기

인식 필드 23개(`basic` 4 + `cagi` 9 + `satisfaction` 10)의 `recognitionValueSource` 맵을 측정했다.

- `JSON.stringify(map)`: 626자/바이트 (`confirmed` 23개 기준)
- `JSON.stringify({ recognitionValueSource: map })`: 653자/바이트 (`confirmed` 23개 기준)
- 가장 긴 값인 `unresolved` 23개를 가정한 property 포함 크기: 676자/바이트

키와 값이 ASCII라 UTF-8 바이트 수가 문자 수와 같다. 이미지·crop 데이터는 맵에 포함되지 않는다.

## 빈값과 엑셀 status 확인

`validateStudent`는 변경하지 않았다. `src/lib/validation/validateStudent.ts:8-21`의 이미지 누락 검사는 그대로이고, `:30-62`의 기본정보 빈값/무효값, `:64-77`의 CAGI 9개 빈값, `:79-117`의 만족도 10개 빈값은 기존처럼 각각 validation error를 낸다. 따라서 `unresolved` 빈칸은 새 기계값 저장 게이트가 잡지 않고 기존 검증 경로로 처리된다. `blank_ok`도 이 기존 validation을 우회하지 않는다.

`generateWorkbookPair`는 `src/lib/excel/generateWorkbookPair.ts:57-61`에서 학생의 그룹 값만 쓰고 `:70`에서 workbook을 검증한다. `status`를 읽지 않는다. 그러므로 구형 source map 없는 요청에 반환하는 `status: 'saved'`도 엑셀 생성 경로에서는 `confirmed`와 동일하게 값만 생성한다.

스냅샷 코드(`src/lib/session/reviewSnapshot.ts:64-71,78-82,101-102`)는 이미지 키만 삭제하고 나머지 `source` 키를 spread하므로 source map 보존을 위해 코드 변경은 필요하지 않았다. 라벨 수출 `src/lib/labelExport/labelStore.ts`도 변경하지 않았으며 기존 `source.recognitionValueSource` 읽기 경로가 새 맵을 그대로 사용한다.

## 바뀐 UI 문구 전체

- `자동 인식 · 확인 필요`
- `저장값 복원 · 확인 필요`
- `자동 인식값이므로 사람이 확인해야 저장할 수 있습니다.`
- `저장된 값이지만 확인이 필요합니다.`
- `자동 인식 · 확인 필요` (좌표 진단)
- `저장값 복원 · 확인 필요` (좌표 진단)
- `확인되지 않은 자동 입력 {N}개도 포함되어 있습니다.`
- `확인되지 않은 자동 입력 {N}개 — 확인 후 저장할 수 있습니다`
- `확인되지 않은 자동 입력 {N}개 — 확인 후 저장할 수 있습니다.` (저장 콜백 방어 문구)
- `첫 번째 미확정 항목으로 이동`

`auto`/`restored` 값은 이제 높은 confidence여도 attention/pending 목록에 들어가고, 해당 확인 버튼과 저장 게이트가 생긴다. 사람이 확인해 `manual`/`confirmed`/`blank_ok`가 되면 게이트와 pending에서 빠진다.

## 테스트 결과 전문

PowerShell 실행 정책 때문에 `npx`의 `npx.ps1`은 직접 실행할 수 없었다. 같은 npm shim의 `npx.cmd`로 실행했다.

### `npx.cmd tsc --noEmit`

```text
exit_code=0
stdout: (empty)
```

### `npx.cmd vitest run`

```text
RUN  v1.6.1 C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/wt-b11

Test Files  44 passed | 13 skipped (57)
Tests       428 passed | 13 skipped (441)
Duration    24.60s
exit_code=0
```

### `MARK_AFFINE_TONE=1 npx.cmd vitest run`

```text
RUN  v1.6.1 C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/wt-b11

Test Files  44 passed | 13 skipped (57)
Tests       428 passed | 13 skipped (441)
Duration    24.65s
exit_code=0
```

두 Vitest 실행 모두 skipped는 저장소의 `_probe-*`/측정용 조건부 테스트와 기존 스캔 반복 측정 케이스이며 실패는 없다. 지정한 테스트 파일은 기본/affine 두 회 모두 `review-settlement` 2개, route 3개, snapshot 29개, label export 5개, payload 3개가 통과했다.

두 전체 실행에서 관찰된 파일별 결과는 다음과 같다(실행 순서는 worker 스케줄에 따라 달랐지만 결과 집합은 동일하다).

```text
PASS  tests/capture-diagnostics.test.ts (18)
PASS  tests/capture-guidance.test.ts (29)
PASS  tests/label-export.test.ts (5)
PASS  tests/orb-align.test.ts (17)
PASS  tests/tone-normalization.test.ts (19)
PASS  tests/band-structure.test.ts (22)
PASS  tests/review-snapshot.test.ts (29)
PASS  tests/photo-binary-floor.test.ts (13)
PASS  tests/ink-invariant.test.ts (22)
PASS  tests/photo-binary-refusal.test.ts (21)
PASS  tests/frame-exposure.test.ts (29)
PASS  tests/recognition-mark-density.test.ts (18)
PASS  tests/validation.test.ts (11)
PASS  tests/table-row-detection.test.ts (11)
PASS  tests/batch-matcher.test.ts (10)
PASS  tests/perspective-correct.test.ts (6)
PASS  tests/table-grid-detection.test.ts (12)
PASS  tests/student-save-payload.test.ts (3)
PASS  tests/recognition-crop-source.test.ts (6)
PASS  tests/review-settlement.test.ts (2)
PASS  tests/pdf-render-config.test.ts (2)
PASS  tests/form-classifier.test.ts (4)
PASS  tests/cagi-early-intervention.test.ts (2)
PASS  tests/grid-override-completeness.test.ts (11)
PASS  tests/ocr-budget.test.ts (1)
PASS  tests/pdf-timeout.test.ts (2)
PASS  tests/perspective-correction-policy.test.ts (2)
PASS  tests/blank-form-calibration.test.ts (2)
PASS  tests/field-crop.test.ts (1)
PASS  tests/template-baseline.test.ts (2)
PASS  tests/job-cleanup.test.ts (3)
PASS  tests/excel.test.ts (3)
PASS  tests/review-suggestion.test.ts (11)
PASS  tests/ocr-text-lines.test.ts (2)
PASS  tests/blank-form-detection.test.ts (3)
PASS  tests/recognize-form-mismatch.test.ts (3)
PASS  tests/integration.test.ts (4)
PASS  tests/satisfaction-recognition.test.ts (3)
PASS  tests/two-stream-grid.test.ts (10)
PASS  tests/age-ocr.test.ts (15)
PASS  tests/sheet-quality.test.ts (19)
PASS  tests/sheet-exposure.test.ts (8)
PASS  tests/upload-registration-meta.test.ts (9)
PASS  tests/student-save-route.test.ts (3)
SKIP  tests/_probe-photo-accuracy.test.ts (1)
SKIP  tests/real-scan-measure.test.ts (1)
SKIP  tests/_probe-tracedump.test.ts (1)
SKIP  tests/_probe-cells.test.ts (1)
SKIP  tests/_probe-gates.test.ts (1)
SKIP  tests/_probe-features.test.ts (1)
SKIP  tests/scan-repeat-measure.test.ts (1)
SKIP  tests/reversed-stack-recognition.test.ts (1)
SKIP  tests/_probe-grid-crops.test.ts (1)
SKIP  tests/_probe-photo.test.ts (1)
SKIP  tests/_probe-photo-trace.test.ts (1)
SKIP  tests/_probe-grid.test.ts (1)
SKIP  tests/_probe-photo-gates.test.ts (1)
```

## 명세와 다르게 한 것과 이유

- 명령행에서 `npx` 대신 `npx.cmd`를 사용했다. Windows PowerShell execution policy가 `npx.ps1` 로드를 차단했기 때문이다. 동일한 `npx` 실행 경로의 cmd shim이며 결과는 모두 exit code 0이다.
- `tests/label-export.test.ts`의 `studentWithSource` 인자를 `RecognitionValueSource`로 타입 지정했다. `StudentData.source`에 strict source map 타입을 추가한 뒤 기존 `string` 인자가 `tsc`에서 거부되어 필요한 타입 보정이었다. 라벨 수출 런타임은 변경하지 않았다.
- `src/lib/session/reviewSnapshot.ts`, `src/lib/labelExport/**`, `src/lib/recognition/**`, `src/lib/excel/**`에는 기능 diff를 만들지 않았다. 기존 snapshot spread와 label read path가 새 맵을 보존/사용하기 때문이다.
- `npm run build`는 지시대로 실행하지 않았다.
- 푸시는 하지 않았다.

## 확신 없는 부분

실제 스캔 이미지와 정답표가 없는 체크아웃이므로 브라우저에서의 실제 인식·검수 흐름과 최종 산출물 정확성은 검증하지 않았다. 해당 최종 판정은 위임자가 수행해야 한다. 코드 수준에서는 source map이 있는 저장 행은 출처를 복원하고, map이 없는 구형 행은 값만 `restored`로 복원해 다시 확인하도록 하는 경로를 테스트했다.
