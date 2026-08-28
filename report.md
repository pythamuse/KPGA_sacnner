# 주문: 검수 화면 "경합" 배지 구현 보고서

브랜치: `codex-contested-badge`

이번 변경은 표시용 메타데이터만 추가했다. 인식값, 신뢰도, 빈칸 수, 확정 상태,
검수 대상 카운트 및 자동 포커스/스크롤은 변경하지 않았다. 정답표와 스캔 원본이
이 체크아웃에 없으므로 실제 오답 위 배지 적중 여부는 중앙 측정 대상이며, 여기서
자체 판정하지 않았다.

## 바꾼 파일: 행

- `src/lib/recognition/markDensity.ts:69-107` — `ChoiceGroupResult.contested`,
  `CONTESTED_RUNNERUP_MSCORE`, 경계 판정 헬퍼를 추가했다.
- `src/lib/recognition/markDensity.ts:1049-1072, 1203-1218, 1463-1758` —
  결정 trace에 조건부 `contested=1`을 붙이고, 고신뢰 결과에서 2등 후보 하나만
  판정하도록 연결했다. 저신뢰/빈칸/단일 후보 결과는 `false`다.
- `src/lib/recognition/markDensity.ts:197-208, 2322-2332` — 2등 후보 1회 계산에
  필요한 정합 샘플 컨텍스트를 내부적으로 보관했다.
- `src/lib/recognition/markDensity.ts:2925-2968, 3105-3114` — 기존 trace용
  `matchedScore` 산식을 `calculateMatchedScoreFromSoftened`로 추출하고,
  생산 경로용 `calculateMatchedScore`가 같은 코어를 호출하게 했다. trace가
  이미 산출한 값은 재사용한다.
- `src/lib/recognition/detectCheckmarks.ts:56-57, 104-105, 145-156, 326,
  359-378, 488-520, 561-562` — `RecognitionDraft`와 필드별 source 메타데이터에
  `recognitionContested: Record<string, boolean>`을 연결했다. 실제 자동입력으로
  통과한 직접 체크박스 결과에만 true를 기록한다.
- `src/app/api/recognize/route.ts:234-235, 284-285` — draft 메타데이터를 API
  응답의 `source.recognitionContested`로 전달했다.
- `src/components/RecognitionReview.tsx:544-545, 589-605` — 기존 `자동 인식`
  배지 옆에 `경합` 배지를 추가했다. warning 팔레트와 지정된 보조 문구를 사용하며,
  자동 인식 source일 때만 표시된다.
- `tests/recognition-mark-density.test.ts:43-52, 327-355` — 0.0099/0.0100
  경계, 고신뢰 조건, 2등 없음 조건을 검증했다.
- `tests/review-snapshot.test.ts:197-225` — contested true/false 렌더링을
  검증했다.
- `report.md` — 이 구현 및 검증 기록.
- `order.md` — 작업 시작 전에 존재하던 사용자 제공 주문 파일이며, 주문의
  `git add -A` 요구에 따라 함께 커밋된다. 내용은 수정하지 않았다.

## `matchedScore` 헬퍼 추출 방식

기존 `analyzeResidualComposition`의 softPage/softBase 생성 이후 정합 잔차를
누적하던 로직을 `calculateMatchedScoreFromSoftened`로 분리했다. 따라서 bilinear
정합, `0.08` 잔차 절단, 유효 영역, 평균 계산은 trace와 배지 판정이 동일하게
공유한다.

생산 경로에서는 후보들을 모두 계산하지 않는다. 고신뢰 그룹에서 정렬된 2등
후보 하나를 선택한 뒤, 그 후보가 trace에서 이미 `composition.matchedScore`를
가지면 재사용하고, 아니면 해당 후보에 저장된 정합 컨텍스트로 `calculateMatchedScore`
를 한 번 호출한다. 그 값을 `CONTESTED_RUNNERUP_MSCORE`와 비교한다.

## 메타데이터 경로와 UI 위치

`analyzeChoiceGroup`의 결과 `contested` → `recognizeStudentForms`의
`recognitionContested[field]` → `/api/recognize` 응답의 `source` →
`RecognitionReview` 필드 행의 기존 `자동 인식` 배지 옆 `경합` 배지 순서다.

`RecognitionReview`는 `source === 'auto'`이고 해당 필드 메타데이터가 true인
경우에만 배지를 그린다. 배지는 다음 문구를 title로 가진다.

`다른 칸에도 표시 흔적이 있습니다 — 지운 표시인지 확인해주세요`

## 시험 결과 전문

의존성 설치 후 Windows PowerShell에서는 실행 정책 문제를 피하기 위해 `npx`의
동등한 실행 파일인 `npx.cmd`를 사용했다. 모든 명령은 종료 코드 0이다.

### `npx vitest run`

```text
Test Files  41 passed | 11 skipped (52)
Tests       398 passed | 11 skipped (409)
Start at 01:23:40
Duration 27.49s (transform 4.49s, setup 3ms, collect 24.61s, tests 54.22s, environment 9ms, prepare 17.40s)
```

11개 probe는 이 체크아웃에 실제 스캔 원본이 없어 skip됐다. 실행 중 기존 Vite
CJS deprecation 및 fixture 관련 warning만 있었고 실패는 없었다.

### `MARK_AFFINE_TONE=1 npx vitest run`

```text
Test Files  41 passed | 11 skipped (52)
Tests       398 passed | 11 skipped (409)
Start at 01:24:16
Duration 27.96s (transform 3.93s, setup 1ms, collect 22.05s, tests 55.80s, environment 8ms, prepare 17.24s)
```

### `npx tsc --noEmit`

```text
(no stdout)
```

### `npm run build`

```text
▲ Next.js 14.2.35
Creating an optimized production build ...
✓ Compiled successfully
Linting and checking validity of types ...
Collecting page data ...
Generating static pages (0/13) ...
✓ Generating static pages (13/13)
Finalizing page optimization ...
Collecting build traces ...

Route (app) Size First Load JS
┌ ○ / 29 kB 116 kB
├ ○ /_not-found 873 B 88.2 kB
├ ƒ /api/download 0 B 0 B
├ ƒ /api/jobs 0 B 0 B
├ ƒ /api/jobs/cleanup 0 B 0 B
├ ƒ /api/recognize 0 B 0 B
├ ƒ /api/students 0 B 0 B
├ ƒ /api/upload 0 B 0 B
├ ƒ /api/uploads/crop 0 B 0 B
├ ƒ /api/uploads/image 0 B 0 B
└ ƒ /api/uploads/quality 0 B 0 B
○ Static prerendered...
ƒ Dynamic server-rendered...
```

## 명세와 다르게 한 것

없음. trace가 켜진 경우 기존 계산값을 재사용하는 최적화는 주문에서 허용한
선택 사항이다. 실제 스캔에서의 오답 커버리지나 중앙 성능 예산은 이 환경에서
검증하지 않았다.
