# 사이클 2 에이전트 보고: 기본정보 체크박스 배치 -- 결손 허용 + 프레임 가중 + 작은 이동 우선

주문서: `cycle2-order.md`. 브랜치 `cycle2-basic-placement`, 시작 커밋 `7eacbed`(사이클 1 프로브 포함, main 기준).
모든 변경은 `src/lib/recognition/basicCheckboxDetection.ts`와 새 시험 파일 하나에 한정했다. `markDensity.ts`, `detectCheckmarks.ts`는
`git status`로 미변경을 확인했다(수정된 파일은 `basicCheckboxDetection.ts` 하나뿐).

## 바꾼 파일

- `src/lib/recognition/basicCheckboxDetection.ts` -- 356줄 추가, 21줄 삭제(`git diff --stat`).
- `tests/basicCheckboxDetection.test.ts` -- 신규, 합성(Section E) 시험 2건.

### 주요 위치 (커밋 후 줄 번호)

| 무엇 | 줄 |
|---|---|
| `Match` 인터페이스에 `missing?: boolean` 추가 | `:43-50` |
| `TranslationMatch`에 V2 전용 선택 필드(`missingCount`, `frameMean`, `smallCandidateFound`, `usedLargeShift`) 추가 | `:54-70` |
| `isBasicBoxMatchV2Enabled()` (플래그, `GRID_BAND_V2`와 같은 `!== '0'` 규약) | `:97-99` |
| `MAX_MISSING_PER_GROUP = 1`, `MAX_MISSING_TOTAL = 3` | `:104,106` |
| `SMALL_TRANSLATION_LIMIT = MATCH_TOLERANCE / 2` | `:111` |
| `getFrameWeight()` (env `BASIC_BOX_FRAME_WEIGHT`, 기본 1) | `:124-126` |
| `getLargeShiftMargin()` (env `BASIC_BOX_LARGE_SHIFT_MARGIN`, 기본 0.2) | `:132-134` |
| `matchBasicCheckboxes` -- `matchReferencesToCandidates` 호출로 교체, diagnostic에 V2 절 추가 | `:187-247`(대략, JSDoc 포함) |
| `constrainMatchesToLayout` -- missing 인지 처리 | `:264-360`대 (원본 182-258에서 이동) |
| `matchReferencesToCandidates` (플래그 분기) | `:945-957` |
| `referenceGroupIndices` | `:959-967` |
| `findTranslationMatchV2` (Section C) | `:978-1058`대 |
| `assignCandidatesWithMissing` (Section A+B) | `:1074-1160`대 |
| `__probe` 확장 | `:1272-1281` |

## 규칙 A~C의 정확한 정의 (구현 그대로)

**A. 결손 허용 배정** (`assignCandidatesWithMissing`): 기준마다 실후보 배정 또는 "결손" 중 하나를 고른다. 결손을 고르면
비용은 `tolerance`(호출부에서 항상 `MATCH_TOLERANCE`)이고, `Match.missing = true`, `Match.candidateIndex = -1`을 기록한다.
결손은 그룹당(`groupOfReference`로 식별) 최대 `MAX_MISSING_PER_GROUP = 1`, 전체 최대 `MAX_MISSING_TOTAL = 3`까지만 허용한다.
탐색은 기존 `assignCandidates`와 같은 가지치기 백트래킹(가중 총비용이 지금까지 최선 이상이면 가지치기)이며, 결손 옵션은
실후보 옵션들과 나란히 매 기준에서 시도된다.

**B. 프레임 점수 가중**: 실후보의 비용을 `rawDistance × (1 + frameWeight × (1 − candidate.frameScore))`로 계산한다
(`frameWeight` 기본 1.0, `BASIC_BOX_FRAME_WEIGHT`로 조절). 후보가 허용 오차 안에 있는지 판단하는 필터 자체는 여전히
`rawDistance <= tolerance`(가중 전)로, 주문서가 "거리 비용"만 바꾸라고 한 것과 일치시켰다.

**C. 작은 이동 우선** (`findTranslationMatchV2`): 모든 시드(0,0 포함 + 기준×후보 쌍이 만드는 이동, `MAX_TRANSLATION` 이내)를
`|t| = max(|x|,|y|)` 오름차순으로 순회하되, 최종 승자는 두 버킷의 전역 최소값 비교로 정한다 -- 순회 순서는 결과에 영향이
없고(가지치기 성능에만 영향), 주문서의 "오름차순 평가"라는 설명을 코드 구조에 그대로 반영하기 위해 넣었다.
`|t| <= SMALL_TRANSLATION_LIMIT(0.009)`인 시드들 중 가중 총비용 최소(`bestSmall`)가 있으면 그것을 기본값으로 삼는다.
`|t| > 0.009`인 시드들 중 최소(`bestLarge`)가 `bestSmall`보다 있고 `bestLarge.weightedTotal <= bestSmall.weightedTotal ×
(1 − margin)`(`margin` 기본 0.2)이면 `bestLarge`를 채택한다. `bestSmall`이 아예 없으면 `bestLarge`를 그대로 쓴다(비교할
대상이 없으므로).

## D. 계측

`matchBasicCheckboxes`의 diagnostic 문자열에 V2 경로일 때만(=`match.missingCount !== undefined`일 때만) 다음을 덧붙인다:
`translation=x,y missing=N frameMean=F altSmall=(none|used|found,large-won).` 플래그 off에서는 이 절이 절대 붙지
않으므로 diagnostic 문자열이 바이트 동일하다. `TranslationMatch`에 `missingCount`/`frameMean`/`smallCandidateFound`/
`usedLargeShift`를 선택 필드로 추가해 두어, V1 경로(`findTranslationMatch`/`assignCandidates`, 미변경)가 만드는 객체는
이 필드들을 전혀 채우지 않는다(타입은 optional이라 컴파일도 통과).

## `constrainMatchesToLayout`의 처리 (주문서 A절 마지막 요구사항)

`missing: true`인 매치는 후보가 없으므로 `matched[index] = undefined`로 남기고, 잔차/중앙값 계산에서 `NaN`으로
표시해 필터링한다 -- `NaN <= limit`는 항상 `false`이므로 자동으로 "레이아웃과 불일치" 가지로 떨어져, 기존에
이탈 상자를 처리하던 바로 그 경로(미사용 후보 재탐색 → 없으면 `rectAroundNormalizedPoint`로 예측 위치에 배치)를
탄다. `corrections`에는, 대조할 이전 후보가 없으므로 `Math.hypot(MATCH_TOLERANCE*width, MATCH_TOLERANCE*height)`
(정규화 허용 오차를 페이지 픽셀로 환산한 값)를 넣어 항상 0이 아니게 했다 -- 정확히 무엇을 넣을지는 주문서에
없어서 내가 고른 값이다(아래 "확신 없는 부분" 참조). 이 필드는 `describeBasicCheckboxPlacement`의 `fix=` 디버그
문자열에만 쓰이고(주석: "Nothing here changes a decision, and it carries no answer, only geometry"), 게이트나
UI 판단에는 들어가지 않는 것을 `detectCheckmarks.ts`에서 직접 확인했다.

`missing`이 전혀 없는 경우(플래그 off, 또는 on이어도 결손이 0건인 정상 페이지) `matched`에 `undefined`가 없으므로
`NaN` 필터가 전부 no-op이 되어 사이클 1까지의 계산과 완전히 동일한 결과를 낸다 -- 이 동치성은 코드 검토로
확인했고, 아래 시험 결과(플래그 on/off 534→536 동일 개수로 전부 통과)로도 뒷받침된다.

## E. 시험

`tests/basicCheckboxDetection.test.ts` 신규 -- 합성, 이미지 없이 `__probe.matchReferencesToCandidates`(실제
`matchBasicCheckboxes`가 쓰는 분기 함수)를 직접 호출한다. 12기준(2+4+6), 그룹당 1개씩 총 3개 결손, 결손이 아닌
9개는 정확한 위치의 "상자" 후보(frameScore 0.6)를 가지며, 12개 전부에 "글자" 후보(frameScore 0.46)를 5~29px
왼쪽에 비균일 간격으로 둔다. 결손 3개의 글자 오프셋(27~29px)은 `MATCH_TOLERANCE + SMALL_TRANSLATION_LIMIT`
(18+9=27px)보다 크게 잡아, 작은 이동 버킷(|t|<=9px) 안에서는 그 글자가 아예 도달 불가능하게 만들었다 -- 그래서
"결손이 글자보다 싸다"는 미세한 비용 비교가 아니라 "결손이 유일한 선택지다"가 되어 시험이 강건하다. 나머지
9개(존재하는 기준)의 글자 오프셋은 5~21px로 넓게 흩어 두어, 어떤 단일 이동으로도 12개 전부가 동시에 낮은
잔차로 정렬되지 않게 했다(이걸 좁게 잡았던 첫 시도에서는 큰 이동 쪽이 20% 마진을 넘겨 이겨버려 실패했다 --
아래 "명세와 다르게 한 것" 참조).

- **on**: `translation = {0,0}`, `missingCount = 3`, `smallCandidateFound = true`, `usedLargeShift = false`,
  `frameMean ≈ 0.6`(상자만), 결손 3개는 `missing:true`+`candidateIndex:-1`, 나머지 9개는 전부 상자 후보(frameScore
  0.6) -- 글자 배정 없음.
- **off**(`BASIC_BOX_MATCH_V2=0`): `missingCount`가 `undefined`(V1 경로는 이 필드를 만들지 않음), 12개 전부가
  frameScore 0.46(글자) 후보로 배정, `|translation.x| > 0.009`(작은 이동이 아님) -- "오늘처럼 글자 열로 밀림"을
  그대로 재현.

## 시험 결과 전문

### `npx tsc --noEmit`
출력 없음(통과).

### `npx vitest run` (플래그 기본값 = on)
```
Test Files  55 passed | 19 skipped (74)
     Tests  536 passed | 19 skipped (555)
  Start at  11:59:20
  Duration  31.15s
```

### `BASIC_BOX_MATCH_V2=0 npx vitest run`
```
Test Files  55 passed | 19 skipped (74)
     Tests  536 passed | 19 skipped (555)
  Start at  11:59:58
  Duration  31.62s
```

두 실행의 통과/스킵 개수가 완전히 같다(536/19, 74개 파일 중 55 통과). 사이클 2 이전 기준(534 통과)에 신규
시험 2건이 더해져 536이 됐고, on/off 사이에 회귀나 차이가 없다. `tests/_probe-basic-boxes.test.ts`는 두 실행
모두에서 수집은 되고 `IMAGE`/`OUT` 환경변수가 없어 스킵된다(단독 실행으로도 재확인: `1 skipped`).

## 명세와 다르게 한 것과 이유

1. **시드 순회를 `|t|` 오름차순으로 정렬**했지만(주문서 문구 그대로), 최종 승자는 정렬 순서와 무관하게 두 버킷의
   전역 최소값을 비교해서 정한다. 정렬 자체는 결과에 영향이 없다(모든 시드를 끝까지 보고 각 버킷의 최솟값을
   추적하므로) -- 주문서의 "오름차순으로 평가한다"는 문구를 코드 구조로 정직하게 반영하되, 정렬을 생략해도
   같은 결과가 나온다는 점을 남겨 둔다.
2. **결손 비용을 별도 상수로 두지 않고 `tolerance` 매개변수를 그대로 썼다**(주문서는 "비용 MATCH_TOLERANCE"라고
   명시). 호출부가 항상 `MATCH_TOLERANCE`를 넘기므로 값은 같지만, 함수를 자기완결적으로 두려고 매개변수를
   재사용했다.
3. **합성 시험의 글자 오프셋을 주문서 예시(균일한 12px)보다 넓게, 비균일하게 잡았다.** 처음에는 12개 전부
   동일한 12px 오프셋으로 시도했는데, 그 경우 정확히 그 오프셋만큼 이동하면 12개 전부가 잔차 0으로 완벽히
   정렬되는 퇴화 사례가 생겨(거리 0이면 프레임 가중을 곱해도 비용 0), 큰 이동 쪽이 결손 3개를 쓰는 작은 이동
   대비 압도적으로 싸져 20% 마진을 넘기고 이겨버렸다(직접 계산·디버그 시험으로 확인, 아래 "확신 없는 부분"
   참조). 실제 인쇄된 라벨 글자들은 폭이 서로 달라 정확히 같은 오프셋일 리 없으므로, 비균일 오프셋이 더
   현실적이라고 보고 그렇게 바꿨다. 결손 3개의 오프셋만 작은 이동 버킷 밖(27~29px)으로 밀어 시험을 결정적으로
   만들었다 -- 이 부분은 순수 시험 설계 선택이라, 실제 페이지의 결손 슬롯이 이만큼 멀리 떨어진 글자를 가진다는
   뜻은 아니다.
4. **`constrainMatchesToLayout`을 플래그로 분기하지 않고 통째로 "missing 인지형"으로 바꿨다.** 결손이 전혀 없는
   입력에서는 새 코드가 예전 코드와 수학적으로 동일하다는 것을 리뷰로 확인했고(위 "constrainMatchesToLayout의
   처리" 절), on/off 시험 534→536건 전부 통과로도 뒷받침되므로, 별도의 `if (flag)` 분기 없이 이 함수 하나로
   두 경로를 모두 지원하게 했다. 주문서가 이 함수까지 플래그로 감싸라고 명시하지는 않았고, "재조사 금지"
   섹션이 확정한 사실과도 충돌하지 않는다.

## 확신 없는 부분

- **결손 슬롯의 `corrections` 값으로 `Math.hypot(MATCH_TOLERANCE*width, MATCH_TOLERANCE*height)`를 골랐다.**
  주문서는 "0이 아닌 값을 넣어 diagnostic에 드러나게"라고만 했고 정확한 크기는 명시하지 않았다. 이 값은
  디버그 문자열(`fix=`)에만 쓰이고 게이트에는 안 들어가는 것을 확인했지만, 위임자가 실제 스캔에서 이 숫자를
  다른 fix 값과 비교해 읽을 계획이라면 다른 크기(예: 항상 1px, 또는 그룹의 상자 크기 기준)가 더 읽기 쉬울 수
  있다. 바꾸기 쉬우니 필요하면 알려달라.
- **`altSmall` diagnostic 문자열의 세 값(`none`/`used`/`found,large-won`)이 실제 로그 grep 습관과 맞는지
  확인하지 못했다.** 주문서는 필드 이름만 지정했지 값의 형식은 지정하지 않아서 내가 고른 표현이다.
- **`findTranslationMatchV2`의 시드 생성이 결손 가능성을 고려하지 않는다** -- 여전히 "기준×후보 쌍이 만드는
  이동"만 시드로 만든다(원본과 동일). 결손인 기준은 후보가 없으므로 그 기준이 시드를 만드는 데 기여하지
  못하지만, 다른 기준들의 후보가 충분히 시드를 공급하므로 실제 페이지에서 문제가 될 것 같지는 않다 --
  다만 브라우저 19명 재측정에서 이 부분이 병목이면(결손 3개가 몰려 있어 시드가 부족한 경우) 별도로 봐야 한다.
- **실제 스캔(p2·p4·p11·p5)에서 이 변경이 사실 #2를 어떻게 바꾸는지 직접 확인하지 않았다** -- 주문서 지시대로
  학생 이미지 파일을 열지 않았고, 자체 합격 판정도 하지 않았다. 위임자가 프로브 PNG와 브라우저 19명·노드
  4세트·사진 4세트로 판정해야 한다.

## 커밋

`git -C wt-c2 add -A && git -C wt-c2 commit` (브랜치 `cycle2-basic-placement`), 푸시하지 않음.

## Scoped to non-photo images (2026-09-05 follow-up)

위임자 측정: 브라우저 19명 +12정답·오답 0, 노드 4세트 +18정답·오답 0으로 스캔 경로는 개선됐지만, 사진 경로에서
새 오답 1건(사진 세트2 p4 `basic.schoolType`이 정답표의 `중학교`(수평으로 이웃한 상자) 대신 `학교외기관`을
읽음)과 정답 1건 손실(사진 세트3)이 나왔다. 사진은 오답이 0이어야 하는 판정 표본이므로, 새 배정(Section A~C)을
사진 출처 이미지에서는 끈다.

### 변경

- `matchBasicCheckboxes`에 `options: MatchBasicCheckboxesOptions = {}` 매개변수를 추가했다(`photoProvenance?: boolean`).
- `matchReferencesToCandidates`에 `photoProvenance = false` 매개변수를 추가하고, 분기 조건을
  `isBasicBoxMatchV2Enabled()` 대신 `isBasicBoxMatchV2EnabledFor(photoProvenance)`로 바꿨다:
  ```ts
  function isBasicBoxMatchV2EnabledFor(photoProvenance: boolean): boolean {
    if (!isBasicBoxMatchV2Enabled()) return false;
    if (!photoProvenance) return true;
    return process.env.BASIC_BOX_MATCH_V2_PHOTOS === '1';
  }
  ```
  즉 `photoProvenance`가 거짓이면 기존과 완전히 동일(`BASIC_BOX_MATCH_V2`만 본다). 참이면 `BASIC_BOX_MATCH_V2`가
  꺼져 있을 때는 당연히 꺼지고, 켜져 있어도 `BASIC_BOX_MATCH_V2_PHOTOS`가 정확히 `'1'`이 아니면 꺼져 사진에서는
  사이클 2 이전(`BASIC_BOX_MATCH_V2=0`)과 같은 경로(`findTranslationMatch`/`assignCandidates`)를 탄다.
- `src/lib/recognition/detectCheckmarks.ts`의 유일한 호출부(`matchBasicCheckboxes` 호출, 원래 232-238줄)에
  다섯 번째 인자 `{ photoProvenance: options.cagiPhotoProvenance ?? false }`를 추가했다 -- CAGI 시트에 이미
  들어오는 `options.cagiPhotoProvenance` 값을 그대로 넘긴다(바로 위 `selectGridDetectionStream` 호출이 쓰는
  것과 같은 표현식). 이 파일의 diff는 `git diff --stat`으로 `1 file changed, 1 insertion(+)` 한 줄임을 확인했다
  -- 다른 어떤 것도 옮기지 않았다.
- `__probe`에 `isBasicBoxMatchV2EnabledFor`를 추가로 노출했다.

### 시험 (`tests/basicCheckboxDetection.test.ts`에 3건 추가, 신규 `describe` 블록)

기존 12기준/9상자+3결손/비균일 글자오프셋 합성 픽스처를 그대로 재사용한다.

1. `photoProvenance=true`는 `BASIC_BOX_MATCH_V2`가 켜져 있어도 `BASIC_BOX_MATCH_V2=0`(사진 아님)과 바이트
   동일하다 -- `toEqual`로 두 `TranslationMatch` 객체 전체(번역·매치 배열·missingCount 등 선택 필드 포함)를
   비교해 확인.
2. `BASIC_BOX_MATCH_V2_PHOTOS=1`이면 사진 경로도 새 배정이 재활성화되어 비사진 경로와 동일한 결과(`missingCount
   3`, `translation {0,0}`)를 낸다.
3. `isBasicBoxMatchV2EnabledFor`의 진리표를 직접 확인: 비사진은 항상 `BASIC_BOX_MATCH_V2`만 따르고, 사진은
   `BASIC_BOX_MATCH_V2_PHOTOS='1'`이 없으면 `BASIC_BOX_MATCH_V2`가 켜져 있어도 꺼진다.

### 시험 결과 전문

`npx tsc --noEmit`: 출력 없음(통과).

`npx vitest run`:
```
Test Files  55 passed | 19 skipped (74)
     Tests  539 passed | 19 skipped (558)
```

`BASIC_BOX_MATCH_V2=0 npx vitest run`:
```
Test Files  55 passed | 19 skipped (74)
     Tests  539 passed | 19 skipped (558)
```

두 실행 모두 개수가 완전히 같다(팔로업 이전 536건 + 신규 3건 = 539건). `tests/_probe-basic-boxes.test.ts`는
여전히 수집되고 `IMAGE`/`OUT` 미설정으로 스킵된다.

### 확신 없는 부분 (팔로업)

- `BASIC_BOX_MATCH_V2_PHOTOS`가 `BASIC_BOX_MATCH_V2`보다 하위 개념(사진에서만 의미 있음)이라, `BASIC_BOX_MATCH_V2=0`
  이면 `BASIC_BOX_MATCH_V2_PHOTOS=1`을 줘도 사진에서 여전히 꺼진다(`isBasicBoxMatchV2EnabledFor`가 먼저
  `isBasicBoxMatchV2Enabled()`를 확인). 위임 메시지가 이 조합을 명시하지 않아서 내가 고른 우선순위이며,
  "측정용 재활성화 스위치"라는 취지에는 맞다고 판단했다.
- 실제 사진 세트2 p4·세트3에서 이 변경이 오답을 정말로 없애는지는 확인하지 않았다(자체 합격 판정 금지,
  학생 파일 미접근). 위임자가 사진 4세트로 재측정해야 한다.
