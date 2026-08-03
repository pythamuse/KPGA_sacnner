# 34. 표 구분선 동적 검출 - 작업지시서

[[33_ACCURATE_FIELD_RECOGNITION_METHOD_PROPOSAL]]에서 확정한 방향(서버 사이드 동적 표 구조 검출)의 구체적 구현 지시서. 이 문서를 기준으로 Codex에 코드 작성을 위임한다.

## 목표

`src/lib/recognition/markDensity.ts`의 현재 방식(페이지 경계 하나를 추정하고, 그 안에서 `roiTemplates.ts`의 고정 비율 좌표로 각 문항 위치를 계산)이 [[27_ROI_MISALIGNMENT_CONFIRMED_ROOT_CAUSE_AND_FIX]]에서 확인된 것처럼 페이지 경계 추정이 틀리면 문항 위치가 연쇄적으로 틀리는 문제를 해결한다. **이미지 안에서 실제 표 구분선(가로줄)을 직접 찾아, 그 검출된 선의 실제 위치를 문항 Y좌표로 사용**하도록 CAGI·만족도 두 양식 모두에 적용한다. 실패 시(구분선을 확신 있게 찾지 못하면) **반드시 지금과 동일한 기존 동작으로 안전하게 폴백**한다 — 이번 세션에서 겪은 두 번의 배포 사고를 반복하지 않기 위해, 이 원칙은 타협하지 않는다.

## 기존 구조 참고

`src/lib/recognition/roiTemplates.ts`의 CAGI 문항 좌표는 다음 상수로 만들어진다(그대로 유지, 참고용):
```ts
const cagiQuestionYs = [0.36, 0.383, 0.405, 0.427, 0.449, 0.471, 0.493]; // 1~7번 문항, 간격 약 0.022
const cagiLateQuestionYs = [0.548, 0.57]; // 8~9번 문항, 간격 0.022. 7번(0.493)과 8번(0.548) 사이 간격은 0.055로, 정상 행간격의 약 2.5배 — 실제 서식에 "아래 두 문항은 응답 보기가 위와 다릅니다" 안내 행이 끼어있기 때문
```
만족도(`satisfactionTemplate`)는 세 그룹으로 나뉜다: `satisfaction.q01`(1행, `satisfactionFrequencyXs`), `satisfaction.q02~q06`(`satisfactionBinaryYs` 5행, 간격 약 0.045), `satisfaction.q07~q10`(`satisfactionScaleYs` 4행, 간격 약 0.042).

`markDensity.ts`의 핵심 함수:
- `calculateDarkPixelDensity(image, normalizedRect, darkThreshold=150)`: `image.contentBounds`와 `normalizedRect`(0~1 비율)로 절대 픽셀 좌표를 계산해 어두운 픽셀 비율을 반환.
- `analyzeChoiceGroup(image, group)`: 그룹의 각 후보(candidate)에 대해 `calculateDarkPixelDensity`를 호출해 점수를 매기고 판정.

## 구현 지시

### 1. 신규 파일 `src/lib/recognition/tableRowDetection.ts`

**`detectHorizontalLines`**: 이미지에서 가로 구분선 후보를 찾는 범용 함수.
```ts
export interface HorizontalLine {
  y: number; // 대표 픽셀 y좌표 (연속된 다크 로우 그룹의 중앙값)
}

export function detectHorizontalLines(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  searchTop: number,   // 픽셀 좌표
  searchBottom: number, // 픽셀 좌표
  xLeft: number,       // 픽셀 좌표, 다크 비율을 잴 가로 범위 시작
  xRight: number,      // 픽셀 좌표, 다크 비율을 잴 가로 범위 끝
  minDarkRatio = 0.5,  // 이 비율 이상 어두우면 "선"으로 간주
  darkThreshold = 200,
): HorizontalLine[]
```
`searchTop`~`searchBottom` 범위의 각 행(row)에 대해, `xLeft`~`xRight` 구간의 어두운 픽셀 비율을 계산한다. `minDarkRatio` 이상인 행들을 찾고, **연속된 행들은 하나의 선으로 묶어**(그룹의 중앙 y값을 대표값으로) 반환한다. y 오름차순으로 정렬해서 반환.

**`matchRowPattern`**: 검출된 선들 중에서 기대하는 간격 패턴과 일치하는 부분집합을 찾는 범용 함수.
```ts
export interface RowMatchResult {
  lineYs: number[]; // 매칭된 선들의 실제 픽셀 y좌표 (기대 패턴의 선 개수와 동일한 길이)
  confident: boolean;
}

export function matchRowPattern(
  detectedLines: HorizontalLine[],
  expectedRelativeGaps: number[], // 정규화된 간격 비율 배열 (아래 설명), 예: [1, 1, 1, 1, 1, 1, 2.5, 1]
  toleranceRatio = 0.35, // 각 간격이 기댓값 대비 이만큼 벗어나도 허용
): RowMatchResult | null
```
`expectedRelativeGaps`는 "선과 선 사이 간격들의 상대적 비율"이다(절대 픽셀값이 아니라 비율 — 첫 번째 간격을 1로 정규화했을 때 나머지 간격이 몇 배인지). 예를 들어 CAGI는 선이 10개(9개 행의 위/아래 경계, 인접 행은 경계 공유)이고 간격 9개 중 7번째만 다른 것보다 약 2.5배 크다: `[1, 1, 1, 1, 1, 1, 2.5, 1, 1]` (`cagiQuestionYs`/`cagiLateQuestionYs`에서 실제 비율을 계산해서 상수로 정의할 것 — 하드코딩하지 말고 `roiTemplates.ts`의 기존 배열 값으로부터 코드로 유도해서 단일 소스로 유지).

알고리즘: `detectedLines`가 `expectedRelativeGaps.length + 1`개 이상이면, 그 안에서 슬라이딩 윈도우로 연속된 부분집합을 뽑아 각 부분집합의 간격 비율(정규화)을 `expectedRelativeGaps`와 비교한다. 모든 간격이 `toleranceRatio` 이내로 일치하는 부분집합이 있으면 그 선들의 y좌표를 반환하고 `confident: true`. 없으면 `null` 반환(안전한 실패).

**`buildCagiRowOverrides`**, **`buildSatisfactionRowOverrides`**: 위 두 함수를 조합해 실제 필드별 Y좌표 오버라이드를 만든다.
```ts
export interface RowYOverride {
  top: number;    // 픽셀
  bottom: number; // 픽셀
}

export function buildCagiRowOverrides(
  image: ImageAnalysisData,
): Record<string, RowYOverride> // 예: { 'cagi.q01': {top, bottom}, ..., 'cagi.q09': {top, bottom} }, 확신 없으면 빈 객체 {}
```
동작:
1. `image.contentBounds`(있으면)를 기준으로 대략적인 검색 범위를 넉넉하게 잡되(예: 전체 이미지의 15%~90% 구간처럼, `contentBounds`가 틀렸을 가능성을 고려해 `contentBounds`에만 의존하지 않고 이미지 전체 높이 기준으로 여유 있게), `detectHorizontalLines`로 후보 선을 찾는다.
2. `matchRowPattern`으로 CAGI의 9행짜리(경계선 10개, 간격 9개) 패턴과 매칭을 시도한다.
3. 매칭에 성공하면(`confident: true`), 인접한 두 선 사이 구간의 중앙 60%를 그 행의 Y범위로 잡아(`top = lineAbove + interval*0.2`, `bottom = lineBelow - interval*0.2`) `cagi.q01`부터 `cagi.q09`까지 순서대로 매핑해 반환한다.
4. 실패하면 빈 객체 `{}`를 반환한다(호출부는 이를 "오버라이드 없음"으로 처리해 기존 방식 그대로 동작해야 한다).

`buildSatisfactionRowOverrides`도 동일한 원리로 만족도의 세 그룹(`satisfaction.q01` 단독, `satisfaction.q02~q06` 5행, `satisfaction.q07~q10` 4행)에 각각 적용한다 — 세 그룹은 서로 간격이 달라서 각각 별도로 매칭을 시도해야 한다(그룹 하나가 실패해도 다른 그룹은 성공할 수 있게, 그룹별로 독립적으로 시도하고 실패한 그룹만 빈 채로 둔다).

### 2. `src/lib/recognition/markDensity.ts` 수정

- `calculateDarkPixelDensity`에 선택적 5번째 인자를 추가한다: `yOverride?: { top: number; bottom: number }`. 제공되면 Y축 계산(`top`, `bottom` 산출)에서 `image.contentBounds` 기반 계산 대신 `yOverride.top`/`yOverride.bottom`을 그대로 사용한다(범위 밖으로 나가지 않도록 `clamp`는 그대로 적용). **X축 계산(`left`, `right`)은 절대 변경하지 않는다** — 항상 기존 방식(`contentBounds` + `normalizedRect.x`/`width`) 그대로 유지한다.
- `analyzeChoiceGroup`에도 선택적 인자를 추가한다: `analyzeChoiceGroup(image, group, yOverride?)`. 제공되면 그룹의 모든 후보에 동일한 `yOverride`를 전달한다(한 행 안의 모든 후보는 같은 Y범위를 공유하므로).
- 이 두 함수의 기존 호출부(오버라이드를 안 넘기는 곳)는 지금과 100% 동일하게 동작해야 한다 — 회귀 없음.

### 3. `src/lib/recognition/detectCheckmarks.ts` 수정

`recognizeStudentForms` 안에서 CAGI/만족도 이미지를 분석하는 두 개의 루프 직전에 각각 `buildCagiRowOverrides(cagiImage)` / `buildSatisfactionRowOverrides(satisfactionImage)`를 호출해 오버라이드 맵을 얻는다. 각 `analyzeChoiceGroup(image, group)` 호출을 `analyzeChoiceGroup(image, group, overrides[group.field])`로 바꾼다(해당 필드에 오버라이드가 없으면 `undefined`가 넘어가고, 기존과 동일하게 동작한다). `basic.gender`/`basic.schoolType`/`basic.grade`처럼 CAGI 문항 표 밖에 있는 필드는 오버라이드 대상이 아니므로 `overrides['basic.gender']`는 항상 `undefined`가 되고 자동으로 기존 방식대로 처리된다(별도 분기 불필요, 그냥 맵 조회 결과를 넘기면 됨).

### 4. 테스트 (`tests/table-row-detection.test.ts` 신규)

`tests/form-classifier.test.ts`의 SVG 합성 이미지 생성 패턴을 참고해서:
1. **정상 케이스**: 실제 간격 패턴(9개 간격, 7번째만 2.5배)에 맞춰 가로 구분선 10개를 그린 합성 이미지를 만들고, `buildCagiRowOverrides`가 9개 필드 모두에 대해 올바른(그려진 선 위치와 일치하는) Y범위를 반환하는지 확인한다.
2. **구조 없는 케이스**: 구분선이 없거나 불규칙한 합성 이미지를 만들고, `buildCagiRowOverrides`가 빈 객체 `{}`를 반환하는지(안전한 실패) 확인한다.
3. `matchRowPattern`에 대한 순수 단위 테스트도 추가한다(간격 패턴이 맞는 경우/안 맞는 경우 각각).
4. 기존 `tests/recognition-mark-density.test.ts`, `tests/satisfaction-recognition.test.ts`, `tests/form-classifier.test.ts`, `tests/integration.test.ts`는 전부 그대로 통과해야 한다(회귀 없음 — 이 테스트들은 오버라이드를 쓰지 않는 기존 호출 경로를 검증하므로).

## 하지 말아야 할 것

- `roiTemplates.ts`의 X좌표(열 위치)나 후보 판정 임계값(`analyzeChoiceGroup`의 0.35/0.12, 0.22/0.06 등)은 건드리지 않는다 — 이번 작업은 오직 "어느 행을 볼 것인가"만 고친다.
- `classifyForm.ts`, 원근보정(`documentScanner/*`), 서버 API 라우트는 건드리지 않는다.
- 확신이 없을 때 억지로 오버라이드를 만들어내지 않는다 — 애매하면 반드시 빈 결과를 반환해 기존 동작으로 폴백해야 한다.

## 검증

`npm test`, `npm run build` 통과 확인. 이후 별도로 실제 샘플 이미지에 대해 Node 스크립트로 직접 돌려서(브라우저 없이) 실제 크롭 위치가 개선됐는지 확인하는 절차를 이어서 진행한다.
