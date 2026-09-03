# GRID_BAND_V2 — 밴드 제한 + 밴드 안 되찾기 (주문 B·C·D)

기준 커밋 `ad5f959`, 브랜치 `codex-v2-band`. A절(`expectedYpx/detectedYpx/rescanYpx`)은 기준 커밋에
이미 있으므로 손대지 않았고, `[grid-fit]` 같은 줄에 `outOfBand=<n> rescued=[idx@ratio]`만 덧붙였다.

## 바꾼 파일: 행

### `src/lib/recognition/tableGridDetection.ts`

| 행 | 내용 |
|---|---|
| 48–58 | 상수 4개 + 근거 주석: `GRID_BAND_HALF_WIDTH_RATIO = 0.75`, `GRID_BAND_RESCUE_DARK_RATIO_SCALE = 0.6`, `GRID_BAND_RESCUE_MIN_DARK_RATIO = 0.12`, `GRID_BAND_RESCUE_MERGE_TOLERANCE_PX = 1` |
| 190–193 | `isGridBandV2Enabled()` — `process.env.GRID_BAND_V2 === '1'` |
| 644–652 | `emitGridTrace`: `trace.outOfBand !== undefined`일 때만 ` outOfBand=N rescued=[i@r,...]`를 같은 줄 끝에 덧붙임 |
| 671–675 | `GridTraceData`에 `outOfBand?: number`, `rescued?: RescuedLine[]` 추가 |
| 775–794 | `buildGridOverrides`의 행 대응 진입점. `v2Enabled && isGridBandV2Enabled()`일 때만 `matchRowLinesWithinExpectedBands(...)`, 아니면 **기존 그대로** `matchTemplateLinePattern(horizontalLines, expectedY)` |
| 873–876 | `makeTrace`에 `bandRowMatch`가 있을 때만 `outOfBand`/`rescued` 실음 |
| 2011–2064 | `BandLimitedLineCandidates` + `limitLinesToExpectedBands()` (순수 함수, 시험용 export) |
| 2066–2145 | `RescuedLine`·`BandLimitedRowMatch` + `matchRowLinesWithinExpectedBands()` |

### `tests/table-grid-detection.test.ts`

| 행 | 내용 |
|---|---|
| 15–20 | `limitLinesToExpectedBands`·`matchRowLinesWithinExpectedBands`·`detectHorizontalLines` import |
| 399–409 | B 시험: 계측된 p4 검출 12선을 밴드로 거르면 6선·`outOfBand 6`·결손 `[1,2]` |
| 411–450 | C 시험: 합성 프로파일에서 플래그 off는 V2 `null`, 밴드+되찾기는 5선 전부 대응 |
| 452–476 | C 시험: 스퓨리어스만 있으면 되찾기 0건·`match` `null` |
| 478–530 | D 통합 시험: 합성 PNG를 `buildSatisfactionGridDetection`에 넣어 플래그 off=`candidate`(V2 거절), on=`verified` |
| 532–551 | p4 계측값 상수(`p4ExpectedRows`/`p4SpuriousRows`/`p4RowSearch`)와 `makeRowProbeImage` |
| 600–641 | `writeGridFixture`에 `faintHorizontalLineIndexes`·`faintHorizontalLineWidthRatio`·`extraHorizontalLineYs` 추가(전부 선택) |
| 695–711 | `withGridBandV2(enabled, cb)` — 플래그를 켜고/**지우고** 원상복구. `GRID_BAND_V2=1`로 전체를 돌려도 off 시험이 off로 돈다 |

## 구현된 규칙 (정확히)

**밴드 제한 (B)** — `limitLinesToExpectedBands(detected, expected)`
- `band = 0.75 × getMinimumPositiveSpacing(expected)` (기대 선 사이 **최소** 간격 기준).
- 후보 = `|y − e_i| ≤ band`인 기대 선이 **하나라도** 있는 검출 선(합집합). 순서 보존.
- `outOfBand` = 버려진 검출 선 수. `missingExpected` = **밴드 안에 후보가 하나도 없는** 기대 인덱스.
- `expected.length < 2`이거나 최소 간격이 0 이하면 `null`(= 밴드 미적용, 기존 경로).

**시도 순서 (B)** — `matchRowLinesWithinExpectedBands`
1. 밴드 후보로 V2 → 성공하면 그것으로 끝(`rescued=[]`).
2. 실패하면 **전체 후보로 한 번** 재시도(지금 동작 그대로). 성공하면 끝.
3. 둘 다 실패하고 `missingExpected`가 비어 있지 않으면 되찾기.

**되찾기 (C)**
- `rescueRatio = max(0.12, spec의 darkRatio × 0.6)`. `rescueRatio >= darkRatio`면 되찾기 자체를 건너뛴다
  (문턱이 이미 0.12 이하인 표에서 무의미한 재스캔 방지). `satisfaction.scale`: `0.2 → 0.12`. CAGI 기본: `0.3 → 0.18`.
- 같은 x 구간(`horizontalSearchLeft..Right`)·같은 y 탐색 구간에서 `detectHorizontalLines`를 `rescueRatio`로 한 번 돌리고,
  그 결과 중 **결손 기대 선의 밴드 안에 든 선만** 채택한다. 전역 문턱은 그대로.
- 기존 밴드 후보나 이미 채택한 되찾기 선과 1px 미만이면 버린다(중복 제거).
- 채택분이 0이면 `match = null`(되찾기가 선을 만들어내지 않는다).
- 채택분이 있으면 `밴드 후보 ∪ 되찾은 선`을 정렬해 V2를 **그대로** 다시 호출한다 — 배율·잔차·절대 위치·결손 ≤ floor(E/3)
  규칙은 손대지 않았다.
- 트레이스: `rescued=[<기대 인덱스>@<사용한 비율>, ...]` (여러 선이 같은 밴드에서 나오면 항목도 여럿).

**적용 범위**: 행(수평선)만. 열(`expectedX`/`verticalLines`)은 건드리지 않았다 — 주문 제목이
"수평선 후보를 기대 행 밴드로 제한"이고 계측·실패 사례가 전부 행이라서다.

## 시험 결과 전문

```
$ npx tsc --noEmit
(출력 없음, exit 0)

$ npx vitest run
 Test Files  48 passed | 17 skipped (65)
      Tests  472 passed | 17 skipped (489)
   Duration  24.00s

$ GRID_BAND_V2=1 npx vitest run
 Test Files  48 passed | 17 skipped (65)
      Tests  472 passed | 17 skipped (489)
   Duration  23.90s
```

새 시험 4건 포함 `tests/table-grid-detection.test.ts` 25건 통과(이전 21건).

### D 통합 시험의 합성 사례가 재현하는 것

합성 PNG(척도표 q07–q10, 5행 경계·6열 경계, 행 간격 36px):
- 표 위 스퓨리어스 7선을 밴드 밖(첫 기대 행에서 31~116px 위, 탐색창 120px 안)에 그린다.
- 행 1·2만 표 폭의 12%만 그어 0.2에서는 안 잡히고 0.12에서는 잡히게 한다.

`GRID_TRACE=1 GRID_BAND_V2=1`로 본 두 줄(A절 계측 필드는 <A-instrument>로 줄임):

```
플래그 off: [grid-fit] table=satisfaction.scale mode=v2 detectedRows=10 <A-instrument> expectedRows=5
  matched=[0,1,2,3,4] missing=[] scale=row:1.4309 gapDev=row:0.1933 status=candidate refusedBy=v2-line-match
  ... (outOfBand/rescued 없음)
플래그 on : [grid-fit] table=satisfaction.scale mode=v2 detectedRows=10 <A-instrument> expectedRows=5
  matched=[0,1,2,3,4] missing=[] scale=row:0.9983 gapDev=row:0.0058 status=verified refusedBy=none
  ... outOfBand=7 rescued=[1@0.12,2@0.12]
```

off 쪽 진단 전문(등록 레코드에서):
`grid candidate: gap rows 19%, ... ; V2 line match refused; review-only V1 geometry retained
[rows sel=-45,-67,-73,-1,-1 det=-116,-102,-88,-73,-59,-45,-31,0,109,145; ...]`
— 브라우저 p4와 같은 모양이다(V1 폴백이 한 행 위를 집고 `gapRows`에서 거절).

## 명세와 다르게 한 것

1. **되찾기 재스캔을 밴드마다가 아니라 탐색 구간 전체에서 한 번 돌리고 결과를 밴드로 거른다.**
   결손 밴드마다 `detectHorizontalLines`를 부르면 밴드 경계에서 선의 인접 행 묶음이 잘려 중심이
   밀린다(반환값이 묶음의 중심이다). 채택 집합은 "결손 밴드 안의 선"으로 동일하고, 위임자가 A절로 잰
   `rescanYpx`와 같은 방식이라 계측값과 직접 비교된다. 호출도 1회로 줄어든다.
2. **되찾기 재스캔의 x 구간은 본 검출과 같은 `horizontalSearchLeft..Right`(표의 열 범위)다.**
   A절 계측기는 `bounds.left..bounds.right`(쪽 전체)를 썼다. 어두운 비율은 스캔 폭에 대한 비율이므로,
   "같은 자리에서 문턱만 낮춘다"는 뜻이 되려면 본 검출과 같은 폭이어야 한다. 표 폭이 더 좁으므로 표를
   가로지르는 선의 비율은 계측값보다 **높게** 나온다(= 되찾기가 더 쉬워진다).
3. **밴드·되찾기를 행에만 걸었다**(열 미적용) — 위 "적용 범위" 참고.
4. **브라우저 p4 파일의 `_probe-lines` 전/후 진단 전문을 싣지 못했다.** 위임 지시가 스크래치패드의
   학생 응답 파일(`browser-p4/`, `browser-19/`, `pdf/`, `render-p4/`)을 읽지 말라고 명시했고, D절
   시험이 합성이므로 열지 않았다. 대신 같은 실패 모양을 재현한 합성 사례의 진단 전문을 위에 실었다.
   실제 파일 판정은 위임자가 한다.
5. `limitLinesToExpectedBands`/`matchRowLinesWithinExpectedBands`를 `export`했다 — 시험이 이미지 없이
   밴드 규칙을, 이미지만으로 되찾기를 직접 부르기 위해서다. 제품 경로에서는 `buildGridOverrides`만 쓴다.

## 확신 없는 부분

1. **밴드 우선 시도가 지금 verified인 표를 다른 대응으로 바꿀 수 있다.** 주문대로 "밴드 → 실패하면
   전체 1회"라서, 밴드 후보만으로 V2가 **성공**하면 전체 후보로는 더 나은(결손이 없는) 대응이 있었더라도
   그것을 보지 않는다. 이론적으로 가능한 구간이 있다: 매칭된 선은 변환 위치에서 0.4×간격까지, 변환 자체는
   0.5×간격까지 밀릴 수 있어 최악 0.9×간격까지 벌어질 수 있는데 밴드는 0.75×간격이다. 즉 균일하게
   많이 밀린 표에서 진짜 선이 밴드 밖으로 나갈 수 있다. 그 경우 보통은 밴드 대응이 **실패**해 전체 후보로
   떨어지지만, 결손 하나를 허용하고 성공해 버리면 그 표의 `missingExpected`가 늘어난다(끝 경계면 자동
   입력에서 빠진다). 안전판을 넣으려면 둘 다 계산해 `isBetterV2LineCandidate`로 고르면 되는데, 주문의
   흐름과 달라져 넣지 않았다. **19장 재측정에서 verified 16개가 유지되는지가 이 항목의 판정이다.**
2. **되찾기 비용**: V2가 두 번 실패한 표에서만 `detectHorizontalLines`가 한 번 더 돈다. 실제 페이지에서
   무시할 수준인지는 재보지 않았다.
3. **되찾기 하한 0.12가 다른 기기에서 무엇을 데려올지 모른다.** 합성에서는 밴드 밖 잡음이 전부 걸러지지만,
   실제 회색조(세트 4)처럼 배경이 어두운 계급에서 결손 밴드 안에 인쇄 구조가 들어오면 되찾은 선이 진짜
   행이 아닐 수 있다. V2 규칙이 그대로 걸리므로 오답이 아니라 대응 실패로 끝나야 하지만, 확인은 실제
   자료로만 된다. 세트 4는 이 브랜치에서 재보지 않았다.
4. `rescued=[idx@ratio]` 형식은 주문 문구 그대로 두었다. 되찾은 선의 y는 이 필드에 없다 —
   A절의 `rescanYpx`에 이미 있으므로 중복이라고 판단했다. 필요하면 형식을 늘리면 된다.

## Default flipped (2026-09-03, 후속)

위임자 측정 통과 후(스캔 세트 칸 단위 동일, 사진 세트 동일·오답 0, 브라우저 19명 정답 +6·새 오답 0)
밴드+되찾기를 **기본값**으로 돌렸다. `GRID_MATCH_V2`와 같은 방식이다.

- `src/lib/recognition/tableGridDetection.ts:194` — `return process.env.GRID_BAND_V2 !== '0';`
  (이전 `=== '1'`). `GRID_BAND_V2=0`이면 예전 무제한 행 대응으로 돌아간다.
- 같은 파일 `:190-193` 주석에 기본 켜짐 근거(측정 결과)와 비교 실행용 `=0`을 적었다.
  `:48` 상수 블록 머리와 `:776` 호출부 주석의 "GRID_BAND_V2 only" 표현도 같이 고쳤다.
- `tests/table-grid-detection.test.ts` — `withGridBandV2(false, ...)`가 환경변수를 **지우는** 대신
  `'0'`으로 **명시**한다(지우면 이제 켜진 것이다). D 통합 시험 이름·주석도 "flag off"에서
  "GRID_BAND_V2=0"으로 바꿨다.
- 시험: `npx tsc --noEmit` 통과. `npx vitest run`(환경변수 없음)·`GRID_BAND_V2=0 npx vitest run`·
  `GRID_BAND_V2=1 npx vitest run` 모두 472 passed / 17 skipped.
- 그 밖에는 아무것도 바꾸지 않았다 — 상수·규칙·트레이스 형식 그대로다.
