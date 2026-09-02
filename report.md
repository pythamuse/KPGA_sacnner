# B-12·B-13 표시 계층 변경 보고서

## 바꾼 파일과 행

- `src/lib/review/settlement.ts:16` — `SettlementDraft.source`에 경합 맵 타입을 추가했습니다.
- `src/lib/review/settlement.ts:51` — `contestedUnconfirmedFields`를 추가했습니다.
- `src/components/RecognitionReview.tsx:9` — 경합 미확정 집합 함수를 가져왔습니다.
- `src/components/RecognitionReview.tsx:60` — `describeCropSource`를 추가했습니다.
- `src/components/RecognitionReview.tsx:146-147` — 경합 미확정 필드 목록과 집합을 계산합니다.
- `src/components/RecognitionReview.tsx:357` — 미확정 경합 카드에 주황색 테두리·배경을 적용합니다.
- `src/components/RecognitionReview.tsx:655-701` — 출처·등록 배지를 순수 설명 함수 기반으로 렌더합니다.
- `src/components/RecognitionReview.tsx:708-709` — `restored` 경합에도 경합 배지를 표시합니다.
- `src/components/RecognitionReview.tsx:796-830` — 크롭 URL 부재 안내를 추가했습니다.
- `src/components/RecognitionReview.tsx:854` — 크롭 내부의 중복 출처 배지 호출을 제거했습니다.
- `src/components/RecognitionReview.tsx:965` — 저장 게이트의 첫 이동 대상을 경합 우선으로 계산합니다.
- `src/components/RecognitionReview.tsx:1213`, `1423`, `1451`, `1476`, `1506` — 출처·등록 배지를 후보 요약과 크롭 사이에 배치했습니다.
- `src/components/RecognitionReview.tsx:1280-1330` — 경합 요약 문장과 경합 점프 칩 스타일·라벨을 추가했습니다.
- `src/components/RecognitionReview.tsx:1550-1556` — 저장 게이트 이동 버튼의 대상과 문구를 경합 우선으로 변경했습니다.
- `tests/review-settlement.test.ts:53-78` — 경합+auto/restored, confirmed 제외, 값 없음 제외와 페이지 순서를 검증합니다.
- `tests/review-crop-source.test.ts:1-59` — 크롭·후보 유무와 무관한 출처 설명 및 출처 없음 `null`을 검증합니다.

## 새 순수 함수 시그니처

```ts
contestedUnconfirmedFields(draft: SettlementDraft): string[]

describeCropSource(
  draft: RecognitionDraft,
  key: string,
): { sourceLabel?: string; registrationLabel?: string; registrationStatus?: string } | null
```

`contestedUnconfirmedFields`는 `unconfirmedMachineFields(draft)`의 결과를 다시 필터링하므로 기존 23개 필드의 페이지 순서를 유지합니다. `describeCropSource`는 크롭 URL이나 후보 데이터를 읽지 않고, 스냅샷에 남는 `recognitionCropSource`·`recognitionRegistration`만 사용합니다.

## 변경·추가된 UI 문구

추가 또는 조건부 변경:

- `경합 {N}개 — 표시가 비슷해 잘못 고를 수 있었던 항목입니다. 먼저 확인하세요.`
- 경합 점프 칩: `경합 · {필드명}`
- 경합 칩 title: `{필드명} · 경합(으)로 이동`
- 경합 우선 저장 게이트 버튼: `첫 번째 경합 항목으로 이동`
- 캐시 부재 안내: `원본 크롭이 캐시에 없습니다(4시간 경과 또는 새 기기). 원본 이미지에서 확인하세요.`

기존 정보를 유지하며 위치만 이동하거나 적용 대상을 넓힌 문구·배지:

- 좌표 출처: `격자 검증 완료`, `격자 후보`, `행 검출`, `격자 후보 -> 행 폴백`, `위치 특정 실패 (구역 전체 표시)`
- 등록 상태: `좌표 검증`, `좌표 후보`, `좌표 실패`
- 값 출처의 기존 문구 및 `경합` 배지
- 크롭의 기존 `ROI 확인` 링크와 진단 문구

## 테스트 결과 전문

```text
$ npx.cmd tsc --noEmit
(exit code 0; no output)

$ npx.cmd vitest run tests/review-settlement.test.ts tests/review-crop-source.test.ts
The CJS build of Vite's Node API is deprecated.

 RUN  v1.6.1 C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/wt-b12

 ✓ tests/review-settlement.test.ts  (3 tests) 2ms
 ✓ tests/review-crop-source.test.ts  (3 tests) 2ms

 Test Files  2 passed (2)
      Tests  6 passed (6)
   Duration  320ms

$ npx.cmd vitest run
The CJS build of Vite's Node API is deprecated.
Existing OCR/image tests emitted their normal resolution and diacritics diagnostics.

 Test Files  45 passed | 13 skipped (58)
      Tests  432 passed | 13 skipped (445)
   Duration  24.83s (transform 4.41s, setup 5ms, collect 21.44s, tests 52.26s, environment 10ms, prepare 15.24s)

$ git diff --check
(exit code 0; only existing LF/CRLF normalization warnings)

$ git diff --stat main -- src/lib/recognition src/lib/labelExport src/lib/excel src/app/api
(empty; exit code 0)
```

PowerShell 실행 정책 때문에 `npx`의 `npx.ps1` 호출은 거부되었고, 같은 로컬 명령을 `npx.cmd`로 재실행했습니다. `npm run build`는 명세대로 실행하지 않았습니다.

## 명세와 다르게 한 것과 이유

- `page.tsx`는 변경하지 않았습니다. B-11 저장 게이트 경고와 이동 버튼이 `RecognitionReview.tsx`에 이미 있으므로, 해당 컴포넌트에서 첫 경합 항목을 선택하면 요구사항을 충족합니다.
- 명세 예시의 `두 칸의 표시`는 경합 수가 2가 아닐 때 부정확해질 수 있어, 의미를 유지한 수량 불변 문장 `표시가 비슷해...`로 작성했습니다.
- 기존 `tests/recognition-crop-source.test.ts`는 인식 파이프라인의 좌표 출처 계산을 검증하고 있어 그대로 두고, 화면 순수 함수용 명세 파일 `tests/review-crop-source.test.ts`를 별도로 추가했습니다.

## 확신 없는 부분

- 브라우저에서의 실제 카드 배치·스크롤 포커스 동작은 위임자가 판정하도록 직접 판정하지 않았습니다. TypeScript와 전체 Vitest만 실행했습니다.
- `basic.age`는 기존의 후보 없음 예외를 유지했기 때문에 크롭 URL이 없으면 새 캐시 안내를 보여주고, 다른 후보 없는 필드는 기존처럼 아무것도 렌더하지 않습니다. 이는 `basic.age` 예외를 보존한다는 해석입니다.
