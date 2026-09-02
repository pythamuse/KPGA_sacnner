# B-3·B-4·B-9 구현 보고서

## 변경 파일

- `src/lib/recognition/tableGridDetection.ts:42-46` — V2 residual/anchor 계수와 표별 허용치 계수.
- `src/lib/recognition/tableGridDetection.ts:98-153` — `TemplateLineMatch`, 결손 메타데이터, 템플릿 간격 기반 허용치 계산.
- `src/lib/recognition/tableGridDetection.ts:421-522` — 표별 `[grid-fit]` trace 수집·출력.
- `src/lib/recognition/tableGridDetection.ts:574-906` — `GRID_MATCH_V2` 분기, 결손 근거의 등록 전달, 표별 앵커/균일 이동 게이트.
- `src/lib/recognition/tableGridDetection.ts:1117-1180` — V2 유도 게이트를 사용하는 품질 판정.
- `src/lib/recognition/tableGridDetection.ts:1468-1595` — 부분 복원에도 V2 residual/scale/anchor/missing 규칙 적용.
- `src/lib/recognition/tableGridDetection.ts:1788-2210` — V1 보존 wrapper, V2 affine 후보 + 정렬 DP, trace용 fit 결과.
- `tests/table-grid-detection.test.ts:246-333` — 세트 4 p4, 결손 1선, 스퓨리어스 1선, 허용치 유도 V2 시험.
- `tests/table-grid-detection.test.ts:66-174,224-244` — V1 기대와 V2 review-only/candidate 기대를 양 플래그 실행에서 검증.

## V2 알고리즘

1. 검출선과 기대선을 오름차순으로 정렬한다.
2. 기대선 두 개와 검출선 두 개의 모든 순서쌍을 affine seed `(scale, offset)`로 만든다. `scale`은 `1 ± 0.15` 밖이면 버린다.
3. seed로 변환한 기대선과 검출선 사이에서, 검출선 skip(스퓨리어스)·기대선 skip(결손)·1:1 match를 선택하는 order-preserving DP를 실행한다. match 허용 잔차는 `0.4 × 기대선 최소 간격`이다.
4. 선택된 쌍으로 affine을 재적합하고 최대 3회 재정렬한다. 최종 쌍의 최대 잔차, scale, 결손 수(`floor(E/3)` 이하)를 다시 검사한다.
5. 적합된 전체 기대 패턴의 중심 이동과 스팬 변화 중 큰 값을 `anchorResidual`로 삼는다. 이것이 `0.5 × 기대선 최소 간격`을 넘으면 V2 결과는 `null`이다.
6. `lines`에는 관측된 대응선과 결손 위치의 affine 예측선을 함께 넣고, `missingExpected`에는 비어 있는 기대선 index를 넣는다. 결손이 있는 표의 등록은 `candidate`가 되고 rows/columns별 결손 목록과 diagnostic에 남는다.

V1은 기존 choose-k 탐색을 `matchTemplateLinePatternV1`로 그대로 두었다. V2가 거절했지만 V1 완전 패턴이 존재하는 경우에는 review 화면과 기존 candidate crop 정보를 잃지 않도록 V1 geometry를 보존하되 등록을 강제로 `candidate`로 낮춘다. 자동값 경로는 기존 등록 status gate를 그대로 사용하므로 이 보존 경로는 verified가 아니다.

## V2 유도 허용치

열/행 최소 간격은 `roiTemplates.ts`의 후보 중심 간격에서 계산했다. 단일 행인 `satisfaction.frequency`의 행 간격은 내부 행 간격이 없으므로 현재 cell-boundary span `0.0375`를 fallback으로 사용했다. 균일 이동은 항상 `0.45 × 최소 간격`이다. 앵커는 같은 X 계수를 사용하고, 스캔 1~3의 최대 Y 오프셋을 보존하기 위해 `satisfaction.scale`만 Y 계수 `0.55`를 사용한다.

| table | 최소 열 간격 | 최소 행 간격 | uniform tol X | uniform tol Y | anchor tol X | anchor tol Y |
|---|---:|---:|---:|---:|---:|---:|
| `cagi.primary` | 0.057 | 0.017 | 0.02565 | 0.00765 | 0.02565 | 0.00765 |
| `cagi.late` | 0.057 | 0.018 | 0.02565 | 0.00810 | 0.02565 | 0.00810 |
| `satisfaction.frequency` | 0.080 | 0.0375 fallback | 0.03600 | 0.016875 | 0.03600 | 0.016875 |
| `satisfaction.binary` | 0.085 | 0.035 | 0.03825 | 0.01575 | 0.03825 | 0.01575 |
| `satisfaction.scale` | 0.085 | 0.030 | 0.03825 | 0.01350 | 0.03825 | 0.01650 |

따라서 satisfaction spec의 `maxUniformCandidateOffsetY: 0.06`은 V2에서 읽지 않는다. `inferPartialTemplateLinePattern`에도 같은 표별 uniform tol을 전달한다. `GRID_MATCH_V2`가 없으면 기존 상수와 spec 값을 계속 사용한다.

## 세트 4 p4 단위시험 결과

현재 `cagi.primary` spec(q01~q07)의 템플릿 경계 8개를 `roiTemplates.ts`의 후보 중심에서 계산하면 기대선은 다음과 같다(% 높이).

```text
expected = [32.20, 34.60, 37.05, 39.20, 41.00, 42.75, 44.55, 46.45]
detected = [29.47, 33.62, 38.70, 40.58, 42.37, 44.16, 45.95, 47.79]
```

V2의 실제 시험 결과:

```text
matchedExpected = [1, 3, 4, 5, 6, 7]
matchedDetected = [1, 2, 3, 4, 5, 6]
missingExpected = [0, 2]
scale = 1.0423213302
offset = -2.2814944364
anchorResidual = 0.6172081267
gapDeviation = 0.0132605489
lines = [31.2812524, 33.62, 36.3365108, 38.70, 40.58, 42.37, 44.16, 45.95]
```

즉 `29.47` 헤더 상단 검출선(index 0)은 기대선 index 0(q01 경계)에 대응되지 않고, 기대선 0과 2가 결손으로 기록된다. 결손 허용 한도 2개(`floor(8/3)`) 안이지만 등록은 candidate다.

## 계측 예시

`GRID_TRACE=1`일 때 trace는 표마다 한 줄을 출력하며, scale/offset/anchorResidual/gapDev는 row·col을 함께 표시하고 mean/spread/tol은 page-relative 값이다. mean은 표 안 각 행 중 절대값이 가장 큰 값을, spread는 각 행의 최댓값을 남겨 중간 행에서만 생긴 밀림도 한 줄에서 드러나게 했다.

```text
[grid-fit] table=cagi.primary mode=v2 detectedRows=8 expectedRows=8 matched=[0,1,2,3,4,5,6,7] missing=[] scale=row:0.9979,col:0.9951 offset=row:0.0009,col:0.0025 anchorResidual=row:0.0003,col:0.0020 gapDev=row:0.0176,col:0.0039 meanX=-0.0011 meanY=-0.0001 spreadX=0.0013 spreadY=0.0000 tolX=0.0256 tolY=0.0076 status=verified refusedBy=none matchedCols=[0,1,2,3,4] missingCols=[]
```

## 테스트 결과 전문

PowerShell 실행 정책 때문에 `npx`의 동등한 Windows shim인 `npx.cmd`를 사용했다. `npm run build`는 실행하지 않았다.

```text
$ npx.cmd tsc --noEmit
(stdout 없음, exit code 0)
```

```text
$ npx.cmd vitest run
Test Files  45 passed | 14 skipped (59)
Tests       436 passed | 14 skipped (450)
```

```text
$env:GRID_MATCH_V2 = '1'; npx.cmd vitest run
Test Files  45 passed | 14 skipped (59)
Tests       436 passed | 14 skipped (450)
```

추가로 `tests/table-grid-detection.test.ts`는 V1/V2 각각 16 tests passed이며, `GRID_TRACE=1` V2 실행도 16 tests passed다.

## 명세와 다르게 한 것과 이유

- 명세의 세트 1 p4 표현은 4선이지만 현재 checkout의 `cagi.primary` template group은 q01~q07이라 경계 기대선이 8개다. 시험은 현재 코드가 실제로 계산하는 8개를 사용하고, 제공된 세트 4의 8개 검출선을 그대로 넣었다. 이 자료구조에서 임의의 4선 기대 패턴을 새로 만들지 않았다.
- V2 matcher 자체가 `null`인 경우에도 V1 완전 패턴을 review-only geometry로 유지한다. 기존 crop/diagnostic 계약과 V2 양 모드 회귀를 유지하면서, `candidate` status로 자동값 사용을 차단하기 위한 호환층이다.
- `satisfaction.frequency`는 내부 행 간격이 없는 2-line table이라 V2 row match가 식별할 수 없는 scale을 갖는다. build 경로에서는 V1 geometry를 보존해 기존 synthetic recognition fixture를 유지하고, 독립적으로 호출하는 V2 matcher는 여전히 scale/anchor 규칙을 적용한다.
- trace의 단일 `scale`, `offset`, `anchorResidual`, `gapDev` 필드는 실제로는 row/col 모두 필요하므로 `row:...,col:...` 형식으로 확장했다. 요청된 필드명은 그대로 유지했다.

## 확신 없는 부분

- 이 checkout에는 위임자가 보유한 실제 스캔 4세트·사진 4세트가 없어 OFF 105 감소, 사진 오답 0, 기본 flag 판정을 재측정하지 않았다.
- affine 후보가 여러 개 동률인 실제 페이지에서의 tie 선택과, 사진 OLD satisfaction.scale 19개가 candidate로 내려가는 최종 수는 실자료 trace를 모아 확인해야 한다.
- 단일 행 frequency table의 legacy review fallback을 실제 데이터에서도 유지할지, 위임자가 실제 trace를 확인한 뒤 결정해야 한다.
