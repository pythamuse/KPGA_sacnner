# Gray-class / B-8 verification report

## 변경 파일

- `src/lib/recognition/markDensity.ts`
  - `80`: `DecisionEvidence`에 opt-in 계급·보정값(`inputClass`, `gain`, `margin`, `ratio`)을 기록.
  - `169-184`: `InputClass`, `PageInkCalibration`, `R_BILEVEL = 0.73`, gain/margin clamp 상수.
  - `471-482`: `GRAY_CLASS === '1'` 및 `pageIsBinarySource === false && !photoProvenance` 계급 게이트.
  - `1379-1450`: `DecisionEvidence`와 `describeDecision`에 회색조 보정값 기록/출력.
  - `1688-1730`: `GRID_TRACE === '1'`일 때 정규화 중심 거리 B-8 계측.
  - `1826-1858`: 페이지 후보 전체의 비율 중앙값과 noise margin 계산.
  - `1861-2013`: 기존 그룹 채점에 페이지 보정값 연결.
  - `2729-2740`, `3073-3112`, `3130-3165`: 세 잔차 계산 위치에 공통 기준선-측 스케일 규칙 적용.
- `src/lib/recognition/detectCheckmarks.ts`
  - `279-289`, `508-518`: CAGI/만족도 페이지의 채점 후보를 모아 페이지 보정값을 한 번 계산.
  - `1071-1119`: 실제 채점 경로와 같은 후보 셀을 모든 그룹에서 수집하고 baseline 후보와 색인 짝짓기.
- `tests/grayscale-scan.test.ts` (`116-184`): 합성 회색조/1비트/사진 flag 불변성 및 B-8 trace 시험.
- `report.md`: 본 보고서.

## 보정 규칙과 근거

`GRAY_CLASS=1`일 때만 다음을 적용한다. `photoProvenance`가 참이면 사진으로 우선 분류하고, `pageIsBinarySource`가 참이거나 값이 없으면 1비트 계급으로 남긴다. 따라서 플래그가 꺼져 있거나 1비트/사진이면 기존 산술과 결과를 그대로 사용한다.

회색조 페이지의 `r`은 그 페이지에서 실제로 채점하는 모든 후보 상자의 `actualInk / baselineInk` 중앙값이다. `actualInk`와 `baselineInk`는 기존 상자 평균 darkness 측정값이다. 세트 1의 측정값을 `R_BILEVEL = 0.73`으로 고정하여 다음을 계산한다.

```text
gain = clamp(r / 0.73, 0.3, 1.0)
delta_i = actualInk_i - baselineInk_i * gain
margin = clamp(median(delta_i) + 2 * MAD(delta_i), 0.03, 0.08)
residual = max(0, actualPixelInk - baselinePixelInk * gain - margin)
```

즉 페이지 잉크는 보정하지 않고 기준선 쪽만 스케일한다. 마진은 `0.08 * gain`으로 줄이지 않고 페이지 후보들의 잔차 잡음에서 유도했다. 이는 인쇄 구조가 빈 양식 자산의 `0.41-0.57`배인 세트 4에서 표시 잉크를 baseline subtraction이 지워버리는 문제를 복구하면서, 집계 근사에서 마진을 단순 축소했을 때 무표시 양성이 증가한 문제를 피하기 위한 것이다. floor/gap/contrast/shape 문턱값은 변경하지 않았다.

## 합성 시험 실제 수치

합성 페이지는 480x110, 5개 후보, 빈 양식 구조의 darkness `1.0`, 페이지 구조 darkness `0.5`(pixel 89), 첫 번째 후보에만 20x20 검은 표시를 넣었다.

- 플래그 없음: `outcome=low`, `scores=0.000/0.000/0.000/0.000/0.000`; 기존 subtraction이 유지되었다.
- `GRAY_CLASS=1`, 회색조: `class=grayscale-scan gain=0.68 margin=0.030 r=0.500`.
  - 내부 실측: 첫 후보 `page=0.197`, `blank=0.299`, `scr0=0.0271`, 결정 점수 `0.027`.
  - 나머지 네 후보 결정 점수는 모두 `0.000`.
  - `r=0.500` 및 `gain=0.500/0.73=0.684931...`은 시험 assertion으로도 검증했다.
- `GRAY_CLASS=1`, 1비트 입력: flag 전후 결과가 deep-equal.
- `GRAY_CLASS=1`, 사진 provenance: flag 전후 결과가 deep-equal.

## B-8 trace

`GRID_TRACE=1`이고 `usesBaseline`인 그룹마다 다음 형식으로 한 줄을 출력한다. `maxDev`는 페이지/기준선 각각의 content frame에서 정규화한 같은 색인 후보 중심의 Euclidean 최대 편차이고, `pitchMin`은 두 프레임의 후보 중심 간 최소 pairwise 간격 중 작은 값이다. `ok`는 `maxDev <= 0.5 * pitchMin`일 때 `1`이며, 이 값은 채점이나 거절에 사용하지 않는다.

```text
[baseline-pair] field=<f> maxDev=<0.xxxx> pitchMin=<0.xxx> ok=<0|1>
```

합성 시험의 실제 출력 형식/값:

```text
[baseline-pair] field=satisfaction.q01 maxDev=0.0000 pitchMin=0.188 ok=1
```

## 테스트 결과 전문

아래는 최종 구현에서 실행한 결과 요약이다. `npx.cmd`는 이 Windows checkout에서 PowerShell 실행 정책 때문에 사용한 동일한 `npx` 실행 파일이다.

```text
$ npx.cmd tsc --noEmit
exit 0

$ npx.cmd vitest run
Test Files  47 passed | 15 skipped (62)
Tests       466 passed | 15 skipped (481)

$ GRAY_CLASS=1 npx.cmd vitest run
GRAY_CLASS=1
Test Files  47 passed | 15 skipped (62)
Tests       466 passed | 15 skipped (481)

$ MARK_AFFINE_TONE=1 npx.cmd vitest run
MARK_AFFINE_TONE=1
Test Files  47 passed | 15 skipped (62)
Tests       466 passed | 15 skipped (481)

$ npx.cmd vitest run tests/grayscale-scan.test.ts
Test Files  1 passed (1)
Tests       4 passed (4)
```

`npm run build`는 명시대로 실행하지 않았고, push도 하지 않았다.

## 명세와 다르게 한 것 / 이유

- `calculateMatchedScoreFromSoftened`의 별도 softened diagnostic 식에 있는 기존 `-0.08`은 건드리지 않았다. 이번 명세가 지정한 세 결정/진단 잔차 위치만 공통 규칙으로 바꾸고, review suggestion/contested용 보조 신호와 기존 문턱을 함께 바꾸지 않기 위한 범위 제한이다.
- 직접 호출되는 `analyzeChoiceGroup`에 페이지 전체 후보 목록이 전달되지 않는 legacy API 경로에서는 그 그룹의 후보를 page set으로 사용한다. 실제 `recognizeStudentForms` 경로에서는 CAGI/만족도 페이지의 모든 채점 그룹을 먼저 모아 페이지 보정값을 계산한 뒤 공유한다. 합성 시험은 한 그룹이 곧 페이지 전체 후보인 경우다.
- 유효한 ratio 분모가 `baselineInk <= 0`인 상자는 ratio 중앙값에서 제외한다. 0으로 나누어 보정값을 만드는 것보다 안전한 finite guard이며, 해당 페이지가 전부 그런 경우 보정을 적용하지 않는다.

## 확신 없는 부분

- 실제 스캔/사진의 flag 판정과 B-8 분포 판정은 위임자가 수행해야 한다. 이 라운드에서는 제공된 계측 사실을 재조사하지 않았고, B-8 `ok=0`을 거절 규칙으로 사용하지 않았다.
- 실제 자산에서 baseline 분모가 0인 후보가 섞이는지와, 실제 페이지에서 후보 누락/row fallback이 발생할 때 페이지 후보 집합의 크기가 기대와 같은지는 운영 계측에서 확인할 부분이다. 값 변경은 하지 않았다.
