# 조건부 일괄 확인 — 경합·저신뢰 제외, 크롭을 끝까지 본 뒤 (2026-09-03)

사용자 결정(2026-09-03 "조건부 일괄 확인 (권장)"). 코덱스(테라-최대) 위임, 브랜치 `codex-bulk-confirm`, 커밋 `21c8317`,
병합 `76c3738`. §0은 위임자의 판정, 그 뒤는 코덱스 보고서 원문.

## 0. 판정 — 병합(표시 계층), 브라우저 검증은 **부분**

- 값 경로 diff 없음(`src/lib/recognition`·`labelExport`·`app/api`). 메인 시험 467/0, tsc 통과.
- 브라우저(dev, 세트 1, 학생 1: 미확정 자동값 21, 경합 6): 버튼 `경합 아닌 자동값 15개 확인`이 **비활성**으로 뜨고
  안내 "크롭을 끝까지 확인한 뒤 일괄 확인할 수 있습니다 (남은 카드 23개)". 경합 6칸이 대상에서 빠진 것(21 − 6 = 15) 확인.
- 카드 "본 것" 등록은 IntersectionObserver라 **탭이 보일 때만** 갱신된다(§4의 rAF 제약과 같은 부류). 자동화 탭이 숨겨진
  상태여서 잠깐 보인 순간마다 23→17→13으로 줄어드는 것까지만 확인했고, 전부 본 뒤의 활성화·일괄 확인·경합 잔류·5초
  되돌리기는 **탭을 앞으로 가져온 상태에서 마저 확인해야 한다**(1분 작업). 그전까지 이 기능은 "비활성 상태가 안전하게
  유지된다"까지만 검증된 것으로 본다.
- 순수 함수 `bulkConfirmableFields`(경합·medium/low·빈값 제외, restored 포함)는 단위 시험으로 고정됨.
- **완료(사용자가 크롬 창을 앞에 둔 뒤, 같은 날)**: 학생 3(자동 10·경합 3) — 모든 카드 스크롤 후 버튼 활성 → 클릭 →
  7칸 `확인 완료`, 경합 3칸은 `자동 인식 · 확인 필요` 유지, 경고 "경합 3개는 개별 확인이 필요합니다", 저장 비활성, `되돌리기`
  표시. 학생 4(자동 15·경합 2) — 13칸 확인 → `되돌리기` → 15칸 모두 `자동 인식 · 확인 필요`로 복귀. **검증 완료.**
  (학생 1에서 경합까지 확정된 것은 탭이 보이는 동안의 수동 클릭으로 판단 — 트레이스에 일괄 표식 없음.)

---

# (코덱스 보고서 원문) 조건부 일괄 확인 구현 보고서

- 브랜치: `codex-bulk-confirm`
- 커밋: 이 보고서를 포함한 최종 커밋
- 푸시: 하지 않음
- 값 경로 확인: `src/lib/recognition/**`, `src/lib/labelExport/**`, `src/app/api/**`는 변경하지 않음

## 바꾼 파일: 행

- `src/components/RecognitionReview.tsx:9-12` — `bulkConfirmableFields`와 기존 23개 필드 순서 상수 연결.
- `src/components/RecognitionReview.tsx:45-46, 140-158` — 일괄 확인/되돌리기 문구와 학생별 seen·undo 상태 추가.
- `src/components/RecognitionReview.tsx:164-235, 298-310` — 기존 수동 변경·개별 확인·일괄 확인이 공유하는 필드 단위 초안/source 생성 경로.
- `src/components/RecognitionReview.tsx:1015-1075` — 카드 IntersectionObserver, 학생 변경 초기화, SSR·정적/테스트 환경 가드.
- `src/components/RecognitionReview.tsx:1088-1161` — 대상 계산, 필드별 confirmed 누적, 5초 undo와 auto 복귀.
- `src/components/RecognitionReview.tsx:1395-1410, 1606-1718` — 23개 카드 모두에 관찰용 ref와 `data-review-field-key` 연결.
- `src/components/RecognitionReview.tsx:1763-1822` — 저장 게이트 안의 CTA, disabled 안내, 경합 잔류 문구, undo 표시.
- `src/lib/review/settlement.ts:13-15, 60-70` — `bulkConfirmableFields` 순수 함수 추가.
- `tests/review-settlement.test.ts:4, 82-125` — 경합·medium/low·복원값·빈값·페이지 순서 시험 추가.
- `tests/review-snapshot.test.ts:271-282` — 새 CTA의 `경합` 단어와 기존 경합 배지 검사를 분리.
- `report.md:1` — 본 보고서.

## 새 문구 전체

- 버튼: `경합 아닌 자동값 N개 확인`
- 전체 카드 확인 전 안내: `크롭을 끝까지 확인한 뒤 일괄 확인할 수 있습니다 (남은 카드 M개)`
- 경합이 남은 뒤의 저장 게이트: `경합 K개는 개별 확인이 필요합니다`
- undo 버튼: `되돌리기`
- 일괄 확인 직후 undo만 남는 경우의 상태: `자동 입력 N개를 일괄 확인했습니다`
- CTA 설명 title: `경합이 아니고 신뢰도가 높은 자동 입력만 확인합니다.`
- 일괄 확인 trace: `The reviewer confirmed the recognized value. 크롭을 끝까지 확인한 뒤 일괄 확인했습니다 (bulk-confirmed after full review).`
- undo trace: `일괄 확인을 되돌렸습니다.`

위 문구에서 `N`, `M`, `K`는 각각 렌더 시 대상 자동값 수, 아직 보지 않은 카드 수, 남은 경합 수로 치환된다.

## IntersectionObserver 구현 방식

각 카드의 카드 루트 자체에 `data-review-field-key`와 ref를 부착한다. `reviewKeys`(기본정보 4개, CAGI 9개, 만족도 10개)를 페이지 순서로 순회해 카드 요소를 `IntersectionObserver`에 등록하고, `root: null`, `threshold: 0`으로 viewport에 조금이라도 들어온 `isIntersecting` entry를 학생별 `Set<string>`에 한 번만 기록한다. 크롭 이미지의 유무나 로딩 여부는 관찰 조건에 넣지 않는다.

학생 식별자는 `jobId:currentIndex`로 만들며, 이 값이 바뀌면 seen 집합·undo 대상·완료 상태와 5초 timer를 초기화한다. 이전 학생의 늦은 observer callback은 cleanup의 `active` 플래그로 무시하고 observer를 disconnect한다. seen 집합이 현재 학생에 속하지 않으면 렌더 중에도 0개로 취급해 학생 전환 순간의 stale 활성화를 막는다.

effect 시작 전에 `typeof window === 'undefined'`, `typeof document === 'undefined'`, `typeof IntersectionObserver === 'undefined'`를 모두 검사한다. 따라서 SSR과 Vitest의 정적 렌더에서는 observer를 만들거나 DOM을 읽지 않고, CTA는 disabled 상태와 남은 카드 안내로만 렌더된다. timer도 unmount cleanup에서 해제한다.

## 테스트 결과 전문

PowerShell execution policy가 `npx.ps1`을 막아 Windows shim인 `npx.cmd`로 실행했다. 명령의 npm 프로그램과 인자는 동일하다.

```text
$ npx.cmd tsc --noEmit
(exit code 0; stdout 없음)

$ npx.cmd vitest run
The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

 RUN  v1.6.1 C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/wt-bulk

 ✓ tests/capture-guidance.test.ts (29 tests)
 ✓ tests/capture-diagnostics.test.ts (18 tests)
 ✓ tests/orb-align.test.ts (17 tests)
 ✓ tests/tone-normalization.test.ts (19 tests)
 ✓ tests/band-structure.test.ts (22 tests)
 ✓ tests/photo-binary-floor.test.ts (13 tests)
 ✓ tests/photo-binary-refusal.test.ts (21 tests)
 ✓ tests/ink-invariant.test.ts (22 tests)
 ✓ tests/review-snapshot.test.ts (30 tests)
 ✓ tests/frame-exposure.test.ts (29 tests)
 ↓ tests/_probe-bounds-gate.test.ts (1 skipped)
 ↓ tests/real-scan-measure.test.ts (1 skipped)
 ↓ tests/_probe-cells.test.ts (1 skipped)
 ↓ tests/_probe-tracedump.test.ts (1 skipped)
 ↓ tests/_probe-ensemble.test.ts (1 skipped)
 ↓ tests/_probe-gates.test.ts (1 skipped)
 ↓ tests/scan-repeat-measure.test.ts (1 skipped)
 ↓ tests/reversed-stack-recognition.test.ts (1 skipped)
 ↓ tests/_probe-features.test.ts (1 skipped)
 ✓ tests/recognition-mark-density.test.ts (19 tests)
 ✓ tests/label-export.test.ts (5 tests)
 ✓ tests/grayscale-scan.test.ts (4 tests)
 ✓ tests/table-row-detection.test.ts (11 tests)
 ✓ tests/validation.test.ts (11 tests)
 ↓ tests/_probe-photo-accuracy.test.ts (1 skipped)
 ✓ tests/review-settlement.test.ts (4 tests)
 ✓ tests/batch-matcher.test.ts (10 tests)
 ✓ tests/perspective-correct.test.ts (6 tests)
 ↓ tests/_probe-grid-crops.test.ts (1 skipped)
 ↓ tests/_probe-photo.test.ts (1 skipped)
 ✓ tests/student-save-payload.test.ts (3 tests)
 ✓ tests/table-grid-detection.test.ts (21 tests)
 ✓ tests/student-save-route.test.ts (3 tests)
 ↓ tests/_probe-photo-trace.test.ts (1 skipped)
 ✓ tests/recognition-crop-source.test.ts (6 tests)
 ✓ tests/form-classifier.test.ts (4 tests)
 ↓ tests/_probe-grid.test.ts (1 skipped)
 ✓ tests/cagi-early-intervention.test.ts (2 tests)
 ↓ tests/_probe-photo-gates.test.ts (1 skipped)
 ✓ tests/grid-override-completeness.test.ts (11 tests)
 ✓ tests/review-crop-source.test.ts (3 tests)
 ✓ tests/pdf-render-config.test.ts (2 tests)
 ✓ tests/ocr-budget.test.ts (1 test)
 ✓ tests/pdf-timeout.test.ts (2 tests)
 ✓ tests/perspective-correction-policy.test.ts (2 tests)
 ✓ tests/field-crop.test.ts (1 test)
 ✓ tests/blank-form-calibration.test.ts (2 tests)
 ✓ tests/template-baseline.test.ts (2 tests)
 ✓ tests/ocr-text-lines.test.ts (2 tests)
 ✓ tests/job-cleanup.test.ts (3 tests)
 ✓ tests/review-suggestion.test.ts (11 tests)
 ✓ tests/excel.test.ts (3 tests)
 ✓ tests/sheet-exposure.test.ts (8 tests)
 ✓ tests/blank-form-detection.test.ts (3 tests)
 ✓ tests/review-evidence.test.ts (19 tests)
 ✓ tests/satisfaction-recognition.test.ts (3 tests)
 ✓ tests/recognize-form-mismatch.test.ts (3 tests)
 ✓ tests/integration.test.ts (4 tests)
 ✓ tests/two-stream-grid.test.ts (10 tests)
 ✓ tests/age-ocr.test.ts (15 tests)
 ✓ tests/sheet-quality.test.ts (19 tests)
 ✓ tests/upload-registration-meta.test.ts (9 tests)

Test Files  47 passed | 15 skipped (62)
     Tests  467 passed | 15 skipped (482)
Start at  10:31:41
Duration  26.18s (transform 4.48s, setup 4ms, collect 23.55s, tests 58.69s, environment 11ms, prepare 18.12s)

(exit code 0)
```

추가 확인:

```text
$ npx.cmd vitest run tests/review-settlement.test.ts
✓ tests/review-settlement.test.ts (4 tests) 2ms
Test Files  1 passed (1)
Tests       4 passed (4)
(exit code 0)
```

전체 회귀에서 Vitest가 보고한 skip 15개는 기존 `_probe-*`, 반복 측정, 실사 측정 시험이며 실패가 아니다. `npm run build`는 절대 실행하지 않았다.

## 명세와 다르게 한 것과 이유

1. 부모 `onChange`는 초안 한 건만 받으므로, 여러 `handleXChange` callback을 연속 호출하지 않고 공유 필드 단위 경로를 `reduce`해 최종 초안을 한 번 전달했다. 각 대상 필드는 순서대로 `confirmed`, timestamp, 기존 trace + bulk marker를 생성하므로 값·출처·trace 형식은 개별 확인과 동일하다.
2. 일괄 확인으로 미확정 값이 0개가 되어도 5초 동안 저장 게이트를 `notice`로 유지하고 `자동 입력 N개를 일괄 확인했습니다`를 보여준다. 명세의 “같은 자리에 5초 undo”를 실제로 보장하기 위한 표시 보완이며, timer가 끝나면 블록도 사라진다.
3. undo 때 `recognitionValueSource`를 `auto`로 돌리고 bulk/undo 이력을 trace에 남기며, 확인 시각은 제거한다. 출처가 auto인데 수기 시각이 남아 `자동 인식` 라벨과 모순되지 않도록 한 감사 표시 보완이다.
4. 기존 `review-snapshot.test.ts`의 넓은 `경합` 부정 assertion은 새 CTA의 정상 라벨과 충돌했다. 경합 배지와 “다른 칸에도 표시 흔적…” 설명이 없는지를 검사하도록 좁혔고, 제품 동작을 약화시키지 않았다.

그 외 표시·상태 변경은 요청된 범위에 맞추었고 인식값 계산, label export, API 경로는 수정하지 않았다.
