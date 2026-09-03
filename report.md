# 채점기 잡음 바닥 계측 라운드 — 위임 보고

브랜치 `scorer-noise`, 기준 커밋 `ffa87fd`. **계측 라운드이므로 판정은 하지 않았다.**
아래는 무엇을 어디에 넣었고 무엇을 확인했는지만이다.

---

## 1. 바꾼 파일

| 파일 | 줄 | 무엇 |
|---|---|---|
| `src/lib/recognition/markDensity.ts` | 2856-2873 | 차분식에 `subtrahendInk` 도입 (변형 A1) |
| `src/lib/recognition/markDensity.ts` | 3440-3446 | `alignmentRadius`가 하한을 `alignmentRadiusFloor()`에서 읽음 (변형 A2) |
| `src/lib/recognition/markDensity.ts` | 3448-3512 | `alignmentRadiusFloor` / `baselineDilationEnabled` / `dilatedBaselineInk` 신설 |
| `tests/_probe-scorer-cells.test.ts` | 신규 98줄 | 후보별 측정값 JSONL 덤프 (B) |
| `tests/scorer-noise-variants.test.ts` | 신규 217줄 | 합성 단위 시험 7건 (C) |
| `tests/helpers/scorerVariants.ts` | 신규 86줄 | `withScorerVariants` / `withScorerDefaults` / `pinShippedScorer` |
| `tests/band-structure.test.ts` | 10, 46-47 | `pinShippedScorer()` (수치 고정 -> off 전용) |
| `tests/ink-invariant.test.ts` | 10, 386-387 | 위와 같음 |
| `tests/photo-binary-floor.test.ts` | 9, 193-194 | 위와 같음 |
| `tests/photo-binary-refusal.test.ts` | 13, 236-237 | 위와 같음 |
| `tests/review-suggestion.test.ts` | 14, 32-33 | 위와 같음 |
| `tests/tone-normalization.test.ts` | 9, 85-86 | 위와 같음 |

`src` 쪽 변경은 `markDensity.ts` **한 파일**이다. 게이트 상수/UI/격자 코드/의존성은 손대지 않았고
`npm run build`는 돌리지 않았다.

---

## 2. 변형이 작용하는 정확한 자리

### A1. `MARK_BASELINE_DILATE=1` — 차분식 하나

`calculateTemplateInkFeatures`의 표본 루프, 곧 후보 점수를 만드는 **유일한** 차분이다
(나머지 두 `calculateResidualInk` 호출부 — `measureBrightnessReference`,
`calculateInsetResidualSignal` — 는 파일 주석이 못박은 대로 진단 전용이고 점수/판정에 들어가지
않으므로 건드리지 않았다).

**전 (2858행)**

```ts
const residualInk = calculateResidualInk(actualInk, baselineInk, pageCalibration);
```

**후 (2862-2873행)**

```ts
const subtrahendInk = baselineDilationEnabled()
  ? dilatedBaselineInk(blank, sampleWidth, sampleHeight, x + alignment.x, y + alignment.y)
  : baselineInk;
const residualInk = calculateResidualInk(actualInk, subtrahendInk, pageCalibration);
```

`actualTotal += actualInk` / `baselineTotal += baselineInk`는 **그 앞줄에 그대로 남아 있다.** 즉
잉크 밀도(`actualInk`/`baselineInk` 비율), 총잉크 불변식(`inkInvariantZeroed`), 모든 게이트는
계속 **팽창하지 않은** 기준선을 읽는다. 깃발이 움직이는 것은 차분 하나뿐이다.

`dilatedBaselineInk`(3498행)는 정렬된 위치에서 3x3 이웃의 `darkness` **최댓값**을 취한다.
`darkness`가 밝기에 대해 감소함수이므로 최댓값은 인쇄 잉크의 팽창이다.

### A2. `MARK_ALIGN_RADIUS=2` — 정렬 탐색의 하한 하나

**전 (3425-3430행)**

```ts
function alignmentRadius(pitch: number): number {
  if (!Number.isFinite(pitch) || pitch <= 0) return BASELINE_ALIGNMENT_RADIUS;
  return clamp(Math.round(1 / pitch), BASELINE_ALIGNMENT_RADIUS, BASELINE_ALIGNMENT_MAX_RADIUS);
}
```

**후 (3440-3446행)**

```ts
function alignmentRadius(pitch: number): number {
  const floor = alignmentRadiusFloor();
  if (!Number.isFinite(pitch) || pitch <= 0) return floor;
  return clamp(Math.round(1 / pitch), floor, BASELINE_ALIGNMENT_MAX_RADIUS);
}
```

`alignmentRadiusFloor()`(3469행)는 미설정이면 `BASELINE_ALIGNMENT_RADIUS`(=1), 설정되면
정수로 파싱해 `[1, BASELINE_ALIGNMENT_MAX_RADIUS=4]`로 클램프한다. 그래서 `MARK_ALIGN_RADIUS=3`
같은 값도 그대로 쓸 수 있다 — 위임자가 반경을 한 칸 더 밀어보고 싶을 때 코드를 또 고치지 않도록
숫자를 받게 했다(주문은 `=2`만 요구했다).

`radiusX/radiusY`는 `findBestBaselineAlignment`에 그대로 전달되므로 탐색 범위가
`-2..2`로 넓어진다. **분기는 없다** — 1비트 스캔/사진/회색조가 모두 이 한 함수를 지난다.

**주의해서 볼 것(6절에 다시 적는다): 반경은 비교 창의 인셋이기도 하다.** 반경 2에서 채점 창은
36x28 표본 중 32x24로 좁아진다(기본은 34x26). `usablePixels`가 실제로 더한 표본 수로 나누므로
점수 정의는 유지되지만, 재는 영역이 달라지는 것은 사실이다. 탐색 반경만 따로 넓히는 쪽은 택하지
않았다 — `findBestBaselineAlignment`의 주석이 못박은 불변식(모든 오프셋이 실제 범위 안 표본을
같은 개수로 비교한다)이 깨지고, 경계에서 클램프된 표본을 읽어 탐색이 스스로 경계로 끌려간다.
지금 방식은 **이미 과표본 칸이 하는 것과 같은 거래**다(pitch<1이면 반경이 이미 2~4다).

---

## 3. 프로브 사용법

```bash
CAGI_DIR=<쪽 JPEG 디렉터리> SAT_DIR=<쪽 JPEG 디렉터리> OUT=<out.jsonl> [SET=<라벨>] \
  [PHOTO=1] [NO_PROVENANCE=1] \
  npx vitest run tests/_probe-scorer-cells.test.ts
```

변형은 **바깥에서** 준다. 프로브는 환경변수를 스스로 설정하지 않는다.

```bash
MARK_BASELINE_DILATE=1 MARK_ALIGN_RADIUS=2 SET=dilate+r2 \
  CAGI_DIR=... SAT_DIR=... OUT=variant.jsonl \
  npx vitest run tests/_probe-scorer-cells.test.ts
```

`OUT`/`CAGI_DIR`/`SAT_DIR` 중 하나라도 없으면 `describe.skip`으로 건너뛴다(무설정 전체 실행에서
1건 skip으로 잡히는 것이 그것이다). 한 줄은

```
{set, page, field, candidateIndex, candidateValue, score, actualInk, baselineInk,
 alignX, alignY, largestComponentSize, largestComponentRatio, autoFilled}
```

이며 값은 전부 `recognitionMeasurements`에서 그대로 옮긴 것이다 — 프로브가 계산하는 수치는 없다.
**정답표를 읽지 않는다.** 학생 이미지는 경로로만 받고 열지도 복사하지도 커밋하지도 않았다.

---

## 4. 시험 결과 전문

`npx tsc --noEmit` — 통과(출력 없음).

```
########## 변형 없음 ##########
 Test Files  49 passed | 18 skipped (67)
      Tests  483 passed | 18 skipped (501)

########## MARK_BASELINE_DILATE=1 MARK_ALIGN_RADIUS=2 ##########
 Test Files  49 passed | 18 skipped (67)
      Tests  483 passed | 18 skipped (501)

########## MARK_BASELINE_DILATE=1 ##########
 Test Files  49 passed | 18 skipped (67)
      Tests  483 passed | 18 skipped (501)

########## MARK_ALIGN_RADIUS=2 ##########
 Test Files  49 passed | 18 skipped (67)
      Tests  483 passed | 18 skipped (501)
```

신규 합성 시험만 따로:

```
 ok tests/scorer-noise-variants.test.ts (7 tests) 15ms
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

7건의 내용:

1. 변형 없음에서 **글리프만 있는 칸**(1/4 표본 어긋난 기준선)이 `(0.2978-0.08)/34 = 0.00641`을
   남긴다 — 34.7절이 말하는 잔차가 이 픽스처에 실재한다.
2. `MARK_BASELINE_DILATE=1`이 그 잔차를 **0으로** 만든다.
3. 같은 칸에 **3px 획**(인쇄에서 7열 떨어짐)을 더하면 팽창 후에도 획 몫
   `3x20x0.92/(34x26)`이 그대로 남고, 팽창 전 점수의 **90.7%**를 유지한다(절반 아래로 깎지 않음).
   팽창이 없앤 양은 정확히 글리프 잔차뿐임을 별도로 확인한다.
4. 두 표본 어긋난 기준선을 기본 반경 +-1은 못 잡는다(점수 `0.92/34`).
5. `MARK_ALIGN_RADIUS=2`가 그것을 잡는다(점수 0).
6. 둘은 독립이다 — 분수 어긋남에는 반경 확대가 듣지 않고(양수 유지), 정수 어긋남에는 둘 다/각각
   0을 준다. 함께 켜도 동작한다.
7. 헬퍼가 "설정 안 됨"을 빈 문자열이 아니라 미설정으로 되돌린다.

시험의 기대값은 전부 산술로 유도해 주석에 적었고, 실행값이 `toBeCloseTo(..., 5)`로 맞았다.

### 4.1 변형 off 바이트 동일 — 실측

주장으로 두지 않고 쟀다. 임시 시험 파일에서 합성 셀 24세트 x 스캔/사진 두 갈래 =
**`analyzeChoiceGroup` 48회**를 돌려 결과 전체(`candidateMeasurements` 240건, 서로 다른 점수
39개 포함)를 JSON으로 덤프하고, `git stash`로 `markDensity.ts`만 `ffa87fd`로 되돌려 같은 덤프를
다시 떴다.

```
md5  80e11ab87bee74f47968e39de0e8189c  before.json   (ffa87fd)
md5  80e11ab87bee74f47968e39de0e8189c  after.json    (이 변경)
cmp: 차이 없음
```

임시 시험 파일은 확인 후 삭제했다(커밋에 없다). 덤프는 스크래치패드에만 있다.

코드로도 같은 말이 된다: `baselineDilationEnabled()`가 거짓이면 `subtrahendInk`는 **같은 변수**
`baselineInk`이고, `alignmentRadiusFloor()`가 `BASELINE_ALIGNMENT_RADIUS`를 돌려주면
`alignmentRadius`의 두 반환식은 이전과 문자 그대로 같다.

---

## 5. 명세와 다르게 한 것

1. **수치 고정 시험 6개를 off 전용으로 고정했다.** 주문 C의 "수치 고정 시험이 있으면 off 전용으로
   남기고"에 해당한다. 변형을 켜고 전체를 돌리면 `band-structure` / `ink-invariant` /
   `photo-binary-floor` / `photo-binary-refusal` / `review-suggestion` / `tone-normalization`
   6개 파일 **32건**이 깨졌는데, 전부 "0.065를 기대했으나 0.056" 류의 **자릿수 이동**이었다.
   이 자릿수는 변형이 움직이라고 만든 것이므로 그 실패는 계측기가 동작한다는 뜻이지 회귀가 아니다.
   그렇다고 그 파일들을 변형 실행에서 통째로 빼면 "변형에서도 통과"가 공허해지므로,
   `pinShippedScorer()`(파일당 import 1줄 + 호출 1줄)로 **그 스위트만 항상 출고 경로를 재게** 했다.
   나머지 스위트는 손대지 않았고 두 설정 모두에서 실제로 돈다 — 그쪽이 "동작한다"의 근거다.
   기존 `withAffineTone`이 `MARK_AFFINE_TONE`에 대해 하던 것과 같은 방식이다.
2. **`MARK_ALIGN_RADIUS`를 불리언이 아니라 정수로 받는다.** 주문은 `=2`만 말했지만 값을 파싱해
   1~4로 클램프한다. `=2`는 요구대로 동작하고, 반경을 한 칸 더 밀어보고 싶을 때 코드 수정이
   필요 없게 하려는 것이다.
3. **`MARK_ALIGN_RADIUS`용 합성 시험을 추가로 넣었다.** 주문 C는 팽창 시험 하나만 요구했다.
   반경 쪽도 "무엇이 나오면 이 변형이 안 듣는 것인가"를 적어두는 편이 낫다고 판단했다.
4. **프로브에 `SET` 라벨을 추가했다.** `_probe-bounds-gate`가 쓰는 것과 같은 필드로, 여러 실행을
   한 파일로 합칠 때 필요하다. 없으면 `"?"`다.

---

## 6. 확신이 없는 것 — 위임자가 판정 전에 봐야 할 것

1. **[중요] 이 저장소에 "기준선 팽창은 CORRECT 92 -> 64였다"는 기록이 있다.**
   `findBestBaselineAlignment` 주석이 못박고 있다: *"This is the opposite of dilating the blank
   form, which took this project from CORRECT 92 to 64: dilation adds ink to the subtrahend,
   permanently enlarging what is removed from every cell."*
   주문의 「확정된 사실」에는 이 항목이 없어서 위임자가 알고 있는지 알 수 없다. 지금 구현은
   그 실험과 **두 가지가 다르다** — (a) 기본 off이고, (b) 켜도 차분에만 작용해 잉크 비율/불변식/
   게이트는 팽창하지 않은 기준선을 읽는다. 그래도 "감수(subtrahend)에 잉크를 더한다"는
   성질 자체는 같으므로, 표시 칸의 점수가 함께 깎이는 방향은 그대로다. 합성에서 3px 획이
   90.7%를 유지한 것은 **획이 인쇄에서 7열 떨어져 있을 때**의 숫자이고, 실제 종이에서 동그라미가
   글리프에 닿아 있으면 훨씬 크게 깎일 수 있다. 실측 없이 낙관하지 말 것.
2. **"1px"의 단위.** `dilatedBaselineInk`는 주문의 "3x3 최대 필터" 그대로 **1 표본**을 팽창한다.
   표본은 언제나 원본 픽셀 1개가 아니다 — 격자가 페이지를 과표본하는 칸(pitch<1)에서는
   1 표본 < 1 원본 픽셀이고, 거기서는 팽창이 의도보다 **덜** 미친다. 물리적 1픽셀로 맞추려면
   `radiusX/radiusY` 표본만큼 팽창해야 한다. 어느 쪽이 맞는지는 재봐야 알고, 문자 그대로 3x3을
   택했다. `MARK_BASELINE_DILATE`도 정수를 받게 바꾸는 것은 쉬우니 필요하면 지시해 달라.
3. **반경 2가 채점 창을 34x26 -> 32x24로 좁힌다**(2절 끝). 분리도 변화 중 얼마가 "탐색이
   넓어져서"이고 얼마가 "재는 영역이 좁아져서"인지 이 구현으로는 분리되지 않는다. 분리해서 봐야
   한다면 반경은 2로 두고 인셋만 1로 고정한 세 번째 변형이 필요하고, 그건 위에서 말한 불변식을
   깨는 일이라 지시 없이는 만들지 않았다.
4. **합성으로는 아무것도 판정하지 않았다**(CLAUDE.md 2절). 4절의 7건은 산술이 주장대로 도는지만
   보인다. 실제 스캔/사진 기준선(`361/5/71 · 346/8/83 · 348/3/86 · 307/9/121`,
   사진 `61/0 · 34/0 · 42/0 · 32/0`, 브라우저 `346/337/9/91`)은 재지 않았다 —
   이 체크아웃에는 PDF도 정답표도 없다.
5. **`GRAY_CLASS` 계급 보정과의 상호작용을 재지 않았다.** 회색조 경로에서는
   `calculateResidualInk`가 `baselineInk * gain + margin`을 뺀다. 팽창은 그 `baselineInk`를
   키우므로 효과가 `gain` 배로 증폭된다. 별도 분기를 만들지 말라는 지시대로 두었지만,
   세트 4의 변화 폭이 세트 1~3과 다르게 나오면 원인은 여기일 수 있다.
