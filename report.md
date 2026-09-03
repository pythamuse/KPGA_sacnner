# V2 선 대응 — 열(수직선) 밴드 + 밴드 안 되찾기

기준 커밋 `e715cd6`, 브랜치 `v2-band-cols`. 주문서 A·B 구현.

---

## 1. 바꾼 파일과 행

### `src/lib/recognition/tableGridDetection.ts`

| 행 (변경 후) | 내용 |
|---|---|
| `198-205` | `isGridBandV2ColsEnabled()` — `process.env.GRID_BAND_V2_COLS !== '0'` (기본 on) |
| `666-671` | `[grid-fit]` 트레이스에 `outOfBandCols=<n> rescuedCols=[idx@ratio]` 추가 (행의 `outOfBand`/`rescued` 뒤) |
| `698-700` | `GridTraceData`에 `outOfBandCols?: number` · `rescuedCols?: RescuedColumnLine[]` |
| `765-784` | 호출부: `bandColumnMatch` 계산 후 `columnV2Match`가 그것을 쓰도록. 기존 `matchTemplateLinePattern(verticalLines, expectedX)`은 플래그 off 경로로 남음 |
| `934-937` | 트레이스 데이터에 `bandColumnMatch` 결과를 스프레드 (행과 같은 조건부 형태) |
| `2122-2127` | `RescuedColumnLine` (행의 `RescuedLine`의 x축 대응) |
| `2135-2139` | `BandLimitedColumnMatch` |
| `2141-2152` | 내부 `RescuedBandLine`(축 중립, `position`) · `BandLimitedAxisMatch` |
| `2154-2174` | `BandLineDetector` 타입 · `BandSearchWindow` 타입 |
| `2176-2258` | `matchLinesWithinExpectedBands(...)` — **행 구현의 본문을 축 매개변수화한 것**. 옛 `matchRowLinesWithinExpectedBands`의 본문과 로직 동일, 검출기만 인자로 받고 `y` → `position` 이름만 바뀜 |
| `2259-2294` | `matchRowLinesWithinExpectedBands` — 얇은 래퍼. `detectHorizontalLines(...).map(l => l.y)`를 넘기고 `position` → `y`로 되돌려 준다. **공개 시그니처·반환 타입 불변** |
| `2296-2347` | `matchColumnLinesWithinExpectedBands` — `detectVerticalLines(...).map(l => l.x)`를 넘기고 `position` → `x`. 되찾기 채택 규칙이 여기 있다 |

### `tests/table-grid-detection.test.ts`

| 행 (변경 후) | 내용 |
|---|---|
| `16` | `matchColumnLinesWithinExpectedBands` import |
| `479-495` | 밴드 제한 시험 (`limits V2 column candidates to a band around each expected boundary`) |
| `496-535` | 되찾기 시험 (`rescues the three faint column boundaries and lets V2 pick the nearest in each band`) |
| `537-562` | 밴드에 잉크가 전혀 없는 경우 (`rescues nothing when the column bands hold no ink at all`) |
| `564-602` | 결손이 남는 되찾기 기각 (`drops a rescued column match that still leaves an expected column missing`) |
| `662-686` | 고정값 `p5ExpectedColumns`·`p5StrongColumns`·`p5FaintColumns`·`p5GlyphEdgeColumns`·`p5ColumnSearch` 와 `makeColumnProbeImage` 헬퍼 |

---

## 2. 구현된 열 밴드/되찾기 규칙

### 2.1 세 단계 (행과 동일, 공유 본문)

`matchLinesWithinExpectedBands`는 축에 무관하게 다음 순서다.

1. **밴드 후보** — `limitLinesToExpectedBands(detected, expected)`.
   밴드 반폭 = `0.75 × (기대 경계의 최소 양수 간격)` = `GRID_BAND_HALF_WIDTH_RATIO`.
   척도표 기대 열 `476.4 545.2 611.4 674.4 739.9 808.7` 기준 최소 간격 63.0px → 밴드 47.25px.
   어느 기대 경계로부터든 밴드 안에 있는 검출선만 남긴다. `matchTemplateLinePattern(밴드 후보, expected)`가
   성공하면 **그대로 반환**(되찾기 규칙 적용 안 함).
2. **전체 후보 재시도** — 실패 시 `matchTemplateLinePattern(detected, expected)` (= 오늘 동작).
   성공하면 그대로 반환. 결손 밴드가 없으면(`band.missingExpected.length === 0`) 여기서 끝.
3. **결손 밴드 안 되찾기** — 위 둘이 모두 null일 때만.
   - 재검출 문턱 `rescueDarkRatio = max(0.12, darkRatio × 0.6)`. 척도표 `verticalLineDarkRatio = 0.3` → **0.18**.
     `rescueDarkRatio >= darkRatio`이면 아무것도 안 하고 null (문턱을 낮추지 못하므로).
   - 재검출 창은 **호출부가 원래 열 검출에 쓴 창과 동일**:
     `top = expectedY[0] − yTol`, `bottom = expectedY[last] + yTol`,
     `left = expectedX[0] − xTol`, `right = expectedX[last] + xTol`.
   - 재검출로 나온 선 중 **결손 기대 열의 밴드 안에 드는 것만** 채택한다(`band.missingExpected` 순서로 `find`).
     이미 밴드 후보에 있거나 이미 되찾은 선과 1px(`GRID_BAND_RESCUE_MERGE_TOLERANCE_PX`) 안에 있으면 버린다.
   - 되찾은 것이 하나도 없으면 null (오늘 동작).
   - 있으면 `밴드 후보 ∪ 되찾은 선`을 정렬해 `matchTemplateLinePattern`을 **한 번 더** 돌린다.

**후보 선택에는 별도 휴리스틱을 넣지 않았다.** 한 결손 밴드에 되찾은 후보가 여럿이면 전부 후보 집합에
들어가고, 고르는 것은 기존 V2 규칙(배율 `isAllowedRecoveredScale`, 잔차 ≤ `0.4 × 최소간격`, 절대 위치
`isAffinePositionRefused`, DP의 `count` → `totalDeviation` → `maxDeviation`)뿐이다.

### 2.2 열에만 있는 채택 규칙 — "결손 0이어야만 채택"

`matchColumnLinesWithinExpectedBands` 마지막:

```
rescuedIncomplete = (되찾은 선이 1개 이상) AND (match === null OR match.missingExpected.length > 0)
반환 match = rescuedIncomplete ? null : match
```

강제되는 방식과 그 근거:

- **되찾기를 거친 경우에만 발화한다.** `result.rescued.length > 0`은 공유 본문에서 3단계까지 갔을 때만
  참이다. 1단계(밴드)·2단계(전체) 성공은 `rescued: []`로 반환되므로 이 규칙이 건드리지 않는다.
  이진표처럼 오늘 이미 결손 1로 성립하는 대응은 영향받지 않는다.
- **버릴 때 돌아가는 곳이 정확히 "오늘"이다.** 3단계는 2단계(`matchTemplateLinePattern(detected, expected)`,
  곧 오늘의 열 대응)가 이미 null을 준 뒤에만 도달한다. 따라서 되찾기를 버리고 `null`을 반환하면
  호출부가 보는 값은 오늘과 같고, 그대로 V1 폴백 → `partialColumnMatch` → `columnRecovery`로 흘러간다.
- 근거는 주문서 사실 4다. 이진표는 19장 중 17장에서 열 인덱스 2가 **인쇄되어 있지 않다.** 낮춘 문턱은
  칸 안 글리프의 수직 가장자리를 잡으므로(사실 3: p5 밴드 안에 `575.5 580.5 635 642 696.5 699.5 …`),
  결손이 남은 채로 성립한 되찾기 대응은 "메운 열을 발명한 것"이다. 그래서 부분 성공을 통째로 버린다.

### 2.3 트레이스

`GRID_BAND_V2_COLS`가 켜져 있고 `v2Enabled`일 때만 `[grid-fit]` 줄 끝에 붙는다:

```
 outOfBandCols=<밴드가 버린 검출선 수> rescuedCols=[<결손열인덱스>@<재검출문턱>,...]
```

`rescuedCols`는 **결손 0 규칙이 그 대응을 버린 경우에도 그대로 출력한다** — 무엇을 되찾았는데 왜 안
썼는지 위임자가 볼 수 있어야 하기 때문. 채택 여부는 같은 줄의 `matchedCols`/`missingCols`로 읽는다.

### 2.4 `GRID_BAND_V2_COLS=0`일 때

호출부에서 `bandColumnMatch = null`이 되고

```ts
const columnV2Match = bandColumnMatch ? bandColumnMatch.match
  : matchTemplateLinePattern(verticalLines, expectedX);
```

가 기준 커밋의 식으로 그대로 환원된다. 트레이스 스프레드도 `bandColumnMatch`가 null이면 아무 키도 넣지
않고, 포매터는 `trace.outOfBandCols === undefined`일 때 빈 문자열을 붙인다. 즉 출력 바이트 동일.

### 2.5 행 경로 불변

행은 같은 공유 본문을 쓰지만 **로직이 문장 단위로 옛 본문과 같다** — 달라진 것은 (a) 검출기가 인자로
들어오는 것, (b) 지역 변수 이름 `y` → `position`, (c) 반환 직전 `position` → `y` 매핑뿐이다.
`GRID_BAND_V2` 플래그·`GRID_BAND_HALF_WIDTH_RATIO`·재검출 문턱·1px 병합 허용치·후보 조립 순서 모두 그대로.
기존 행 시험 3건(밴드 제한 값, 되찾은 y 좌표 `[[1,951],[2,989]]`와 문턱 0.12, 최종 `lines`)이 그대로 통과한다.

---

## 3. 시험 결과 전문

```
$ npx tsc --noEmit
(exit 0, 출력 없음)

$ npx vitest run
 ✓ tests/table-grid-detection.test.ts  (29 tests) 997ms
 Test Files  48 passed | 17 skipped (65)
      Tests  476 passed | 17 skipped (493)

$ GRID_BAND_V2_COLS=0 npx vitest run
 ✓ tests/table-grid-detection.test.ts  (29 tests) 815ms
 Test Files  48 passed | 17 skipped (65)
      Tests  476 passed | 17 skipped (493)

$ GRID_BAND_V2=0 npx vitest run
 ✓ tests/table-grid-detection.test.ts  (29 tests) 838ms
 Test Files  48 passed | 17 skipped (65)
      Tests  476 passed | 17 skipped (493)
```

`npm run build`은 돌리지 않았다. 새 의존성 없음. `markDensity.ts`·게이트·임계값·UI 미변경.
학생 응답 파일(`scratchpad/browser-19`, `browser-p4`, `pdf`, `prod19-*`, `warp-set*`)은 열지 않았다.

### 3.1 새로 넣은 합성 시험 넷이 무엇을 고정하는가

주문서 사실 3의 p5 숫자를 그대로 픽셀로 그렸다(합성 프로브 이미지, 900×400).

- 기대 열 `476.4 545.2 611.4 674.4 739.9 808.7`
- 0.3에서 잡히는 선(전체 높이) `475 542 731`
- 0.18에서만 잡히는 실제 경계(높이의 0.22) `610.5 665.5 807.5`
- **각 결손 밴드 안의 글리프 가장자리**(역시 0.22) `635`(잔차 23.6) · `696`(21.6) · `786`(22.7)

시험이 고정하는 것:

1. 밴드 반폭 47.25px, `outOfBand = 2`(창 안 425·870), `missingExpected = [2,3,5]`.
2. 되찾기 on → 되찾은 목록이 `[2,610.5] [2,635] [3,665.5] [3,696] [5,786] [5,807.5]` (문턱 0.18),
   **V2가 고른 선은 `475 542 610.5 665.5 731 807.5`** — 각 밴드에서 잔차 최소 쪽이고 6/6 결손 0.
   같은 검출선으로 오늘 경로(`matchTemplateLinePattern`)는 `null`이다(결손 3 > 허용 2).
3. 밴드에 잉크가 없으면 되찾은 것 0 · `match === null`, 오늘과 동일.
4. 결손 3 중 둘만 되찾히면(이진표 사례) — 규칙이 없었다면 V2가 `missingExpected=[5]`인 대응을 냈을
   것임을 같은 시험에서 확인하고(`unguarded?.missingExpected` = `[5]`), 실제 반환은 `null`임을 고정한다.

---

## 4. 명세와 다르게 한 것

1. **되찾기 재검출 문턱은 0.15가 아니라 0.18이다.** 주문서 §A는 `max(0.12, verticalLineDarkRatio×0.6)`을
   지정했고 척도표 `verticalLineDarkRatio = 0.3`이므로 0.18이 나온다. 사실 3의 계측표는 0.15 재스캔이므로
   되찾기가 보는 후보 집합은 계측표보다 조금 좁을 수 있다. 명세(공식)를 따랐고 계측표 숫자를 따르지 않았다.
2. **`rescuedIncomplete` 조건에 `match === null`을 함께 적었다.** 논리적으로는 없어도 결과가 같지만
   (이미 null), "되찾기 뒤에 결손 0이 아니면 채택 안 함"이 한 줄로 읽히게 남겼다.
3. **시험 출력 "전문"은 요약 블록으로 적었다.** 전체 vitest 출력은 OCR 워커의 `Estimating resolution…`
   경고가 수천 줄이라 판정에 쓰이는 요약과 해당 파일 줄만 옮겼다. 네 명령 모두 실제로 완주했다.
4. **엔드투엔드 픽스처 시험(행 쪽의 `registers the five-point scale …`에 해당하는 열 버전)은 넣지 않았다.**
   주문서 §B가 요구한 것은 합성 단위 시험이고, 열 밴드가 실제 등록 상태를 바꾸는지는 위임자가 실자료로
   판정하기 때문이다.

---

## 5. 확신 없는 부분

1. **자체 합격 판정을 하지 않았다.** 실제 스캔·사진·브라우저 19명 측정은 하지 않았다. 아래는 모두 "코드가
   이렇게 동작한다"이지 "좋아졌다"가 아니다.
2. **열 밴드는 행 밴드만큼 걸러내지 못한다 — 구조적으로.** 열 간격 63~69px에 밴드 47.25px이면 이웃 밴드가
   겹쳐 표 x 스팬 전체를 거의 연속으로 덮는다(429~856). 즉 `outOfBandCols`는 표 바깥(검색 창의 여백,
   종이 가장자리)에서만 0이 아닐 가능성이 크고, 1단계 밴드 제한이 열에서 얻는 것은 행보다 훨씬 작을 수
   있다. 실질 효과는 대부분 3단계 되찾기에서 나올 것으로 본다.
3. **열 되찾기가 행 검출 창을 바꾼다.** 호출부에서 `resolvedColumns`가 `horizontalSearchLeft/Right`를
   정한다. 열이 되찾기로 성립하면 행 검출의 x 창이 달라지고, 그것이 행 결과를 움직일 수 있다.
   `GRID_BAND_V2_COLS=0`에서는 물론 오늘 그대로다. 세 세트 모두 재는 이유가 여기에도 있다.
4. **밴드가 겹칠 때 `expectedIndex` 배정은 첫 결손 인덱스로 간다**(행과 동일한 `find`). 트레이스의
   `rescuedCols` 인덱스가 사람이 보기에 "옆 열"로 붙을 수 있다. 후보 집합과 최종 선택에는 영향이 없고
   표시만의 문제다.
5. **결손 0 규칙이 너무 셀 수 있다.** 사실 3의 p4·p10·p1은 오늘 결손 1로 `verified`가 되는데, 그 경로는
   1·2단계라 규칙이 닿지 않는다. 다만 1·2단계가 실패하고 되찾기로 5/6까지 간 페이지가 있다면 그것도
   버려진다 — 이진표를 막기 위해 받아들인 값이고, 완화하려면 규칙이 아니라 표 종류를 구분해야 한다.
   지금은 §5.4의 "게이트 완화로 얻은 이득은 기각" 쪽에 서서 조이는 편을 골랐다.
6. **`GRID_BAND_V2_COLS=0` 바이트 동일은 코드 경로로 논증했을 뿐 실자료 diff로 확인하지 않았다.**
   위임자가 기준선(`361/5/71 · 346/8/83 · 344/3/90 · 307/9/121`)과 대조해 확인해야 한다.
