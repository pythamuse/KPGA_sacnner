# B-3·B-4 V2 구현 보고서

## 변경 내용

- `src/lib/recognition/tableGridDetection.ts`: V2 affine 후보에 절대 위치 점수와 양 끝점 검사 추가.
- `src/lib/recognition/tableGridDetection.ts`: 결손 기대선은 적합된 affine으로 `lines`에 복원하고, 결손만으로 등록을 `candidate`로 낮추지 않도록 변경. `missingExpected`와 diagnostic/trace에는 결손 사실을 유지.
- `src/lib/recognition/tableGridDetection.ts`: `isAutomaticGridEligible`를 verified grid의 행 결손 분류와 공유. 내부 가로 경계 1개는 허용하고 끝 경계/2개 이상은 차단하며, 열 결손은 기존처럼 허용한다.
- `src/lib/recognition/detectCheckmarks.ts`: scoring과 자동 입력 precondition이 같은 eligibility 판정을 사용하도록 연결.
- `tests/table-grid-detection.test.ts`: OLD p4 18선 경쟁 후보·결손 복원 시험과 기대 가로 경계 8개 기준의 내부/끝/다중 행 결손 eligibility 시험을 고정.

## V2 규칙

V1의 `matchTemplateLinePatternV1` choose-k 경로와 반환 shape는 유지한다. V2는 기대선·검출선 두 쌍으로 affine seed를 만들고, `scale ∈ [0.85, 1.15]`를 유지하면서 order-preserving DP로 대응선/스퓨리어스/결손을 정한다. 선택된 대응쌍을 다시 적합하고 최대 3회 재정렬한 뒤 최종 잔차를 검사한다.

최소 간격을 `d`, 대응 잔차를 `r = maxResidual / d`, 적합 affine의 템플릿 절대 좌표 기준 중심 이동을 `C`, 스팬 변화를 `S`라 하면 V2 후보 점수는 다음이다.

```text
lambda = 2 / d
score  = r + lambda * (C + S)
```

`r`의 허용 상한은 `0.4`다. 따라서 최소 간격 하나만큼 중심이 이동한 후보는 위치 항에서 `2.0`을 지불해 전형적인 잔차 상한 `0.4`보다 확실히 커진다. 점수가 동률이면 결손 수가 적은 후보, 중심 이동이 작은 후보, 스팬 변화가 작은 후보, 대응 잔차가 작은 후보 순으로 고른다.

V2는 대응선이 2개 미만이거나, 결손이 `floor(E/3)`을 초과하거나, scale/잔차가 범위를 벗어나거나, 절대 위치가 거부되면 `null`이다. 절대 위치 거부 한도는 `0.5d`이며 중심 이동과 기존 span residual을 검사하고, scale이 중심 이동을 상쇄하지 못하도록 적합 affine의 첫 선과 마지막 선의 signed absolute offset도 각각 검사한다. 결손 위치는 affine 예측값으로 `lines`에 채운다.

V2 matcher가 거절되어도 V1 완전 패턴이 있으면 기존 review-only `candidate` geometry를 보존한다. 반대로 결손만 있고 품질/절대 위치 조건을 통과하면 registration은 `verified`로 남는다. `satisfaction.frequency`의 단일 행 legacy fallback도 유지한다.

## 자동 입력 eligibility 규칙 (B-3·B-4 V2 후속)

`isAutomaticGridEligible`는 먼저 `source=grid`와 `status=verified`를 요구한다. 그 다음 `missingExpected.rows`만 판정한다. 기대 가로 경계 수를 `E`라 할 때, 결손이 없거나 정확히 하나이고 `0 < i < E−1`인 경우 `eligible=1`이다. `i=0`, `i=E−1`, 결손 2개 이상, 기대 경계 수를 알 수 없는 결손은 각각 `end` 또는 `multi`로 분류해 `eligible=0`으로 둔다. `missingExpected.columns`는 이 gate에 참여하지 않는다.

새 단위시험 수치는 다음과 같다.

```text
expected horizontal boundaries = 8, missing rows = [2]   -> missingKind=interior, autoEligible=1
expected horizontal boundaries = 8, missing rows = [0] or [7] -> missingKind=end, autoEligible=0
expected horizontal boundaries = 8, missing rows = [2,5] -> missingKind=multi,    autoEligible=0
expected horizontal boundaries = 8, missing rows = [], columns = [2] -> missingKind=none, autoEligible=1
```

## 새 단위시험의 실제 수치

### OLD p4: 18개 검출선 중 8개 비이동 후보와 한 행 밀림 후보

시험 입력은 기대선 8개, 비이동 검출선 8개, `scale=1.02`, `offset=-1.3`로 만든 밀림 검출선 8개, 스퓨리어스 2개로 총 18개다.

```text
expected = [32, 34.5, 37, 39, 41, 43, 45, 47]
selected lines = [32.08, 34.42, 37.11, 38.93, 41.12, 42.91, 45.09, 46.94]
matchedExpected = [0,1,2,3,4,5,6,7]
matchedDetected = [2,4,6,8,10,12,14,16]
missingExpected = []
scale = 0.9970141313
offset = 0.1313748961
correspondenceResidual = 0.0555228595
absoluteCenterShift = 0.0134330840
absoluteSpanChange = 0.0447880299
firstOffset = 0.0358270989
lastOffset = -0.0089609310
score = 0.1137439734
```

따라서 비이동 8선이 선택된다. 기존 set 4 p4 입력도 별도 시험에서 절대 끝점 조건 때문에 `null`이 된다.

### 스캔 1: 바깥 열 1개 결손

`satisfaction.binary` fixture에서 세로선 3개 중 `[2]`가 결손된 상태다. affine으로 세 번째 열 경계를 복원하고 등록은 `verified`로 유지했다.

```text
inferredVerticalLines = found 2 / expected 3
matchedCols = [0,1]
missingCols = [2]
scale = row:0.9994, col:1.0000
offset = row:-0.0002, col:-0.0009
anchorResidual = row:0.0006, col:0.0009
gapDev = row:0.0203, col:0.0000
absCenter = row:0.0006, col:0.0009
absSpan = row:0.0001, col:0.0000
absEnds = row:-0.0005,-0.0006, col:-0.0009,-0.0009
score = row:0.0464, col:0.0206
status = verified
refusedBy = none
diagnostic = grid: missing expected rows [] columns [2] (affine reconstruction)
```

## 허용치와 legacy 경로

표별 최소 간격에서 V2 uniform/anchor tolerance를 유도한다. `satisfaction.frequency`는 내부 행 간격이 식별되지 않아 기존 `0.0375` cell-boundary fallback을 유지한다. V2가 없으면 기존 상수·spec 경로를 그대로 사용한다.

행 결손은 등록을 verified로 만들고 affine 복원 경계를 scoring에 사용한다. 자동 입력은 verified 상태에서 내부 단일 행 경계 결손만 허용하며, 끝 행 결손 또는 다중 행 결손은 manual-only로 남긴다. 열 결손은 행 gate와 무관하게 기존처럼 허용한다.

## 테스트 결과 전문

PowerShell에서 `npx`의 Windows shim인 `npx.cmd`를 사용했다. `npm run build`는 실행하지 않았고 새 의존성도 추가하지 않았다.

```text
$ npx.cmd tsc --noEmit
(stdout 없음, exit code 0)
```

```text
$ npx.cmd vitest run
Test Files  45 passed | 14 skipped (59)
Tests       441 passed | 14 skipped (455)
Start at    07:30:48
Duration    24.28s (transform 4.79s, setup 6ms, collect 20.38s, tests 50.90s, environment 10ms, prepare 14.03s)
```

```text
$env:GRID_MATCH_V2='1'; npx.cmd vitest run
Test Files  45 passed | 14 skipped (59)
Tests       441 passed | 14 skipped (455)
Start at    07:31:20
Duration    24.65s (transform 4.30s, setup 4ms, collect 20.05s, tests 51.84s, environment 11ms, prepare 13.75s)
```

trace 필드 확인을 겸한 대상 실행도 통과했다.

```text
$env:GRID_MATCH_V2='1'; $env:GRID_TRACE='1'; npx.cmd vitest run tests/table-grid-detection.test.ts
Test Files  1 passed (1)
Tests       21 passed (21)
Start at    07:31:52
Duration    734ms (transform 94ms, setup 0ms, collect 162ms, tests 321ms, environment 0ms, prepare 80ms)
```

대표 trace에는 새 필드가 다음처럼 함께 출력된다.

```text
status=verified refusedBy=none autoEligible=1 missingKind=interior
status=verified refusedBy=none autoEligible=0 missingKind=end
```

## 명세와 다르게 한 것과 이유

- 현재 checkout의 `cagi.primary`는 q01~q07 7개 응답행이라 경계 기대선이 8개다. OLD p4 시험은 명세의 4선 표현을 임의로 재구성하지 않고 현재 template에서 계산되는 8개 기대선을 사용했다.
- 행 결손이 있는 scoring에서는 affine 복원 cell을 사용한다. registration은 결손만으로 `candidate`가 되지 않으며, 자동 입력 gate만 내부 단일 결손을 허용하고 끝/다중 결손을 차단한다.
- V2가 `null`인 경우 V1 완전 패턴을 review-only candidate로 보존한다. 이는 기존 crop/diagnostic 호환성과 V1 동작 보존에 필요하다.
- V2 trace의 row/column affine 메트릭은 기존 단일 trace 줄에 `absCenter`, `absSpan`, `absEnds`, `score`를 유지하고 `autoEligible`·`missingKind`를 추가했다. V1에서는 새 trace 토큰을 출력하지 않으며, 값/자동 입력 결과는 기존 경로를 유지한다.

## 확신 없는 부분

이 checkout에는 위임자가 측정한 실제 스캔 4세트·사진 4세트가 없으므로, OFF 감소량·정답/오답 수·사진 4세트 오답 0을 재측정하지 않았다. 위 수치는 synthetic fixture와 기존 시험의 실제 실행 결과이며, 최종 8조건 판정은 위임자의 재측정이 필요하다.

`lambda=2/d`는 요청된 잔차 상한 대비 한 간격 이동 비용 조건을 직접 만족시키도록 정한 값이다. 실제 사진에서 후보 점수 분포가 추가로 어떻게 변하는지는 위임자의 trace 재측정 전에는 확정하지 않았다.
