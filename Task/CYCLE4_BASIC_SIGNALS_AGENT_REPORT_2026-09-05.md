# 사이클 4 (기본정보 체크박스, A/B) 위임 결과 보고

브랜치 `cycle4-basic-signals`(worktree `wt-c4`, 시작 커밋 `18afb40`). 주문서:
`cycle4-order.md`. `Task/CYCLE2_BASIC_PLACEMENT_AGENT_REPORT_2026-09-05.md`가 심은
`BASIC_BOX_MATCH_V2`(및 `photoProvenance` 옵션)는 그대로 두고 그 위에 얹었다.

## 변경 파일: 행 번호

### `src/lib/recognition/basicCheckboxDetection.ts` (Section A)
- 69-77: `TranslationMatch.framePrefer?: 'n/a' | 'no' | 'yes'` 필드 추가.
- 160-190: `isFramePreferEnabled()`(env `BASIC_BOX_FRAME_PREFER`, `!== '0'`),
  `getFramePreferMargin()`(env `BASIC_BOX_FRAME_PREFER_MARGIN`, 기본 0.06),
  `computeFrameMean(assignment, candidates)`(기존 인라인 frameMean 계산을 재사용
  가능한 함수로 추출 — 동작 변경 없음, `winner`/`bestSmall`/`bestLarge` 세 곳에서
  같은 계산을 쓰기 위함).
- 291-299: `matchBasicCheckboxes`의 `v2Note` 조립부. `framePreferNote`를
  `match.framePrefer !== undefined`일 때만 추가 — 꺼져 있으면(즉 `framePrefer`가
  `undefined`) 진단 문자열은 사이클 4 이전과 바이트 단위로 같다.
- 1110-1158: `findTranslationMatchV2`. 기존 비용 마진 선택(`usedLargeShift`) 로직
  그대로 둔 뒤, `isFramePreferEnabled()`일 때만 `bestSmall`·`bestLarge`가 모두
  존재하면 두 평균 frameScore 차이를 비교해 `winner`/`usedLargeShift`를 덮어쓴다.
  꺼져 있으면 `framePrefer`는 `undefined`로 남고 선택 로직은 손대지 않는다.

### `src/lib/recognition/detectCheckmarks.ts` (Section B)
- 1370-1378: `describeBasicCheckboxDecision`. `runnerUpCoreNote`를
  `evidence?.runnerUpCore !== undefined`일 때만 추가 — 꺼져 있으면 `[pick=... gate=...
  scr=...]` 문자열은 이전과 동일.
- 1402-1409: `isRunnerUpCoreEnabled()`(env `CHECKBOX_RUNNERUP_CORE`, `!== '0'`).
- 1410-1425: `coreWindow(rect)` — `measureBasicCheckboxPlacement`
  (basicCheckboxDetection.ts:657-660)의 core 정의를 그대로 옮긴 것(가로/세로 각각
  25%씩 축소). 상수·공식 변경 없음, 함수로 옮겨 재사용했을 뿐.
- 1437-1447: `DirectCheckboxEvidence.runnerUpCore?: number` 필드 추가.
- 1494-1521: `evaluateDirectCheckboxEvidence`. `named`(전체 창)은 그대로 두고,
  `runnerUp`을 `isRunnerUpCoreEnabled()`일 때 named를 제외한 각 상자를
  `coreWindow`로 축소한 창으로 `calculateCheckboxInteriorDifference`를 다시 계산해
  구함(off면 기존과 동일하게 `signals`에서 named만 뺀 max). `runnerUpCore`는 켜져
  있을 때만 값을 갖고, 꺼져 있으면 `undefined`.
- 1608-1619: `__probe` 신설 — `evaluateDirectCheckboxEvidence`, `coreWindow`,
  `isRunnerUpCoreEnabled`만 노출(basicCheckboxDetection.ts의 `__probe` 관례와 동일,
  테스트 전용, 동작 추가 없음).

### 테스트
- `tests/basicCheckboxDetection.test.ts` (기존 파일에 추가, +161줄): Section A용
  `describe('findTranslationMatchV2 frame-prefer override (BASIC_BOX_FRAME_PREFER)')`
  4개 테스트.
- `tests/checkboxRunnerUpCore.test.ts` (신규): Section B용 `coreWindow` 순수함수
  테스트, `isRunnerUpCoreEnabled` on/off 테스트, `evaluateDirectCheckboxEvidence`
  시나리오 3개(테두리만/코어 실제 잉크/named는 항상 전체 창), 총 6개 테스트.

## A와 B의 정확한 정의

**A (`BASIC_BOX_FRAME_PREFER`, 기본 on)**: `findTranslationMatchV2`가 비용 마진
규칙(`bestLarge.weightedTotal <= bestSmall.weightedTotal * (1 - margin)`)으로
승자를 고른 **뒤**, 두 대안이 모두 존재하고 `frameMean(bestSmall) -
frameMean(bestLarge) >= getFramePreferMargin()`(기본 0.06)이면 비용 마진의 결과와
무관하게 `winner = bestSmall`, `usedLargeShift = false`로 덮어쓴다. `framePrefer`는
`'n/a'`(둘 중 하나가 없음) / `'no'`(둘 다 있지만 마진 미달) / `'yes'`(마진 충족,
강제 전환)를 기록하고, 켜져 있을 때만 진단 문자열에 `framePrefer=…`로 찍힌다.
상수(`SMALL_TRANSLATION_LIMIT`, `getLargeShiftMargin()` 기본값 0.2 등)는 무변경.

**B (`CHECKBOX_RUNNERUP_CORE`, 기본 on)**: `evaluateDirectCheckboxEvidence`에서
`named`(고른 상자, `valueIndex`)는 계속 전체 창으로 잰 `signals[valueIndex]`를
쓴다. `runnerUp`(다른 모든 상자 중 최댓값)만 각 상자의 창을 `coreWindow`(가로·세로
25%씩 축소 — `measureBasicCheckboxPlacement`의 core와 동일 공식)로 바꿔
`calculateCheckboxInteriorDifference`를 다시 계산한 값의 최댓값으로 바꾼다.
`runner-up-inked`/`not-dominant`/`ok` 판정은 이 `runnerUp`(core 버전)을 그대로
쓰고, 그 값을 `runnerUpCore`로 반환·기록한다. `CHECKBOX_DOMINANCE_RATIO`(4),
`CHECKBOX_RUNNER_UP_SIGNAL`(0.025) 등 상수는 무변경.

## 시험 결과 전문

### `npx tsc --noEmit`
출력 없음, 종료 코드 0 (오류 없음).

### `npx vitest run` (두 변수 기본값, 즉 on)
```
 Test Files  56 passed | 21 skipped (77)
      Tests  549 passed | 21 skipped (570)
   Duration  31.20s
```

### `BASIC_BOX_FRAME_PREFER=0 CHECKBOX_RUNNERUP_CORE=0 npx vitest run`
```
 Test Files  56 passed | 21 skipped (77)
      Tests  549 passed | 21 skipped (570)
   Duration  31.65s
```
두 실행의 파일/테스트 수가 완전히 같다 — 기존 스위트 중 어느 것도 새 필드나
진단 문구 추가에 걸려 넘어지지 않았고(꺼졌을 때 문자열이 바이트 동일하다는
방증), 새로 추가한 두 테스트 파일도 각 테스트 안에서 스스로 env를 지정/삭제하므로
바깥 env가 0이어도 각 케이스가 의도한 값으로 실행되어 그대로 통과했다.

`tests/_probe-basic-boxes.test.ts`는 `IMAGE`/`OUT` 미설정 시 `describe.skip`이라
위 두 실행 모두에서 스킵 목록(21개)에 포함되어 수집·통과했다 — 오류 없이 "여전히
돈다".

## 명세와 다르게 한 것과 이유

1. **`tests/basicCheckboxDetection.test.ts`의 translation 비교를 `toEqual`에서
   `toBeCloseTo`로 바꿈.** 부동소수 오차(`-0.020000000000000004` vs `-0.02`)로
   3개 테스트가 실패해 `x`/`y`를 각각 6자리로 비교하도록 고쳤다. 로직 변경 아님.
2. **`DirectCheckboxEvidence.runnerUpCore`를 끄기 상태에서 값을 세팅하지 않고
   `undefined`로 명시.** 주문서는 "결정 추적에 찍는다"만 요구했는데, 절대 조건의
   바이트 동일성을 지키려면 꺼졌을 때 진단 문자열에서 완전히 사라져야 해서
   `evidence?.runnerUpCore !== undefined`로 게이팅했다(Section A의 `framePrefer`도
   같은 방식).
3. **`computeFrameMean` 헬퍼 함수를 새로 뽑아냄(주문서에 명시 없음).** 기존 코드는
   `winner`에 대해서만 인라인으로 frameMean을 계산했는데, Section A는 `bestSmall`과
   `bestLarge` 모두에 대해 같은 계산이 필요해 순수 함수로 추출했다 — 계산식은
   1바이트도 바꾸지 않았다(같은 필터·같은 합/나눗셈).
4. **테스트 시나리오 수치는 주문서 예시(마진 20%+, frameMean 차이 0.15)를 그대로
   재현했지만 구체적 offset(±0.001/±0.02, frameScore 0.6/0.45)은 이 보고서에서
   새로 설계함.** 주문서가 "사이클 2 시험의 배치에서" 만들라고 했으나 사이클 2
   고정구는 12칸/3그룹 구조라 A의 표적 조건(작은 이동이 이미 비용에서 졌는데 프레임
   차이로 뒤집히는 경우)을 최소로 보이려면 별도의 2후보 1그룹 고정구가 더 명확해
   새로 만들었다. 계산은 주석에 전부 남겨 검산 가능하게 했다.
5. **Section B 테스트를 별도 파일(`tests/checkboxRunnerUpCore.test.ts`)로 만듦.**
   `evaluateDirectCheckboxEvidence`를 노출하는 `__probe`가 detectCheckmarks.ts에
   없었으므로(있던 것은 `export { isAutomaticGridEligible }` 하나뿐) 새로 추가했다
   — basicCheckboxDetection.ts의 기존 `__probe` 관례와 동일한 형태(읽기 전용,
   테스트 전용, 동작 추가 없음)이고 주문서의 "새 의존성 금지"는 위배하지 않는다
   (외부 패키지 아님).

## 확신 없는 부분

- **A의 `framePrefer` 값이 `bestSmall`이 이미 비용 마진으로 이겼을 때도 계산된다.**
  즉 `usedLargeShift`가 원래부터 `false`였던 경우에도 `bestLarge`가 존재하면
  `framePrefer`가 `'no'`/`'yes'`로 채워진다(승자는 바뀌지 않음). 이것이 진단
  문자열에 잡음을 늘릴 수 있다 — 실제 p11 등에서 `bestLarge`가 항상 붙어있다면
  `framePrefer=no`가 대부분의 정상 케이스에도 찍힐 수 있다. 주문서가 진단 표시
  범위를 규정하지 않아 "항상 계산해서 켜져 있으면 찍는다"로 해석했는데, 위임자가
  실사용 로그에서 잡음으로 판단하면 "usedLargeShift가 true였을 때만 계산"으로
  좁히는 편이 나을 수 있다.
- **B에서 `not-dominant`/`named-box-empty` 등 다른 거절 사유와 core 신호의 상호작용
  은 실제 스캔에서 재보지 않았다.** 합성 시험(named 자체가 강한 잉크, dominance
  비율 4 대비 넉넉한 차이)만 확인했다 — 실제 p11/p1/p8류처럼 named 자체가 약한
  경우 core 축소가 dominance 판정에 어떻게 얽히는지는 위임자의 실측 대상이다
  (주문서가 명시한 대로 자체 합격 판정은 하지 않았다).
- **`coreWindow`가 아주 작은 창(가로·세로가 4px 미만)에서 `right < left`가 될 수
  있는 이론적 경계는 그대로 두었다** — `measureBasicCheckboxPlacement`의 기존 core
  계산도 같은 특성을 갖고 있어 새 실패 유형을 추가한 것은 아니라고 판단했지만,
  실제 상자 크기(12-34px, `MIN_COMPONENT_SIZE`/`MAX_COMPONENT_SIZE`)에서는 발생하지
  않을 것으로 본다 — 확인은 하지 않았다.

## 후속: B 기각, 옵트인으로 전환 (2026-09-05)

브라우저 19명 측정에서 A는 p11 세 칸을 오답 없이 회복했지만, B는 새 오답을
하나 만들었다 — 학생 1 `basic.grade`가 정답표상 2학년인데 1학년로 채워졌다.
정확히 주문서가 미리 지목한 B의 반증 조건이다: 러너업 상자(2학년)에 학생의
진짜 표시가 있었는데, 안쪽 창으로 재면 그 표시가 창의 바깥쪽 25% 링(=core가
제외하는 영역)에 걸쳐 있어 문턱 아래로 떨어졌고, 그 결과 오답 쪽이 게이트를
통과했다. **B는 기각, A는 유지.** 위임자 지시에 따라 B를 옵트인으로 전환했다.

### 변경 파일: 행 번호

- `src/lib/recognition/detectCheckmarks.ts`
  - 1402-1415: `isRunnerUpCoreEnabled()`를 `process.env.CHECKBOX_RUNNERUP_CORE
    !== '0'`(기본 on)에서 `=== '1'`(기본 off, `'1'`일 때만 on)로 변경. 주석을
    측정 결과·기각 사유·`Task/IMPROVEMENT_CYCLES_2026-09-05.md` cycle 4 인용으로
    교체.
  - 1370-1373: `describeBasicCheckboxDecision`의 `runnerUpCoreNote` 주석 —
    "the switch is on (the default)"가 더 이상 사실이 아니므로 "explicitly
    turned on ('1')"로 고침. 로직(값이 `undefined`가 아닐 때만 찍는다)은 무변경.
  - Section A(`BASIC_BOX_FRAME_PREFER`, `basicCheckboxDetection.ts`)는 손대지
    않음 — 기본 on 그대로.
- `tests/checkboxRunnerUpCore.test.ts`: 기본 상태 기대값을 on→off로 뒤집음.
  - `isRunnerUpCoreEnabled` 테스트: `delete`(미설정) 시 `false`를 기대하도록
    변경, `'0'`도 `false`, 임의의 다른 문자열(`'true'`)도 `false`, `'1'`만
    `true`임을 추가로 확인.
  - `evaluateDirectCheckboxEvidence` 테스트 4개 모두에서 "core 켜짐" 기대 결과가
    필요한 경우 `process.env.CHECKBOX_RUNNERUP_CORE = '1'`을 명시적으로 설정하도록
    바꾸고, "기본(미설정)" 케이스와 "명시적 `'0'`" 케이스를 별도 테스트로 분리해
    두 경로가 같은 결과(거절)를 내는 것을 각각 확인 — 파일 상단 설명에 기각 배경과
    `Task/IMPROVEMENT_CYCLES_2026-09-05.md` cycle 4 인용을 추가.
  - `coreWindow` 순수 함수 테스트는 무변경(스위치와 무관).

### 시험 결과 전문

`npx tsc --noEmit`: 출력 없음, 종료 코드 0.

`npx vitest run` (B는 기본 off, A는 기본 on):
```
 Test Files  56 passed | 21 skipped (77)
      Tests  550 passed | 21 skipped (571)
   Duration  30.51s
```
(이전 라운드의 549개에서 1개 늘어난 것은 `checkboxRunnerUpCore.test.ts`의
"border-bleed 기본(미설정)"과 "명시적 `'0'`" 테스트를 둘로 나눴기 때문 —
로직 변경으로 인한 실패/스킵은 없음.)

`BASIC_BOX_FRAME_PREFER=0 npx vitest run` (A만 끔, B는 여전히 기본 off):
```
 Test Files  56 passed | 21 skipped (77)
      Tests  550 passed | 21 skipped (571)
   Duration  31.60s
```

### 명세와 다르게 한 것과 이유

- 주문서가 요구한 세 명령 중 `BASIC_BOX_FRAME_PREFER=0 CHECKBOX_RUNNERUP_CORE=0`
  조합 실행은 이번 라운드 지시에 포함되지 않았다(코디네이터가 지정한 세 명령은
  `tsc`, 기본 `vitest run`, `BASIC_BOX_FRAME_PREFER=0 vitest run`뿐) — B가 이제
  기본 off이므로 이 조합은 기본 실행과 사실상 같은 신호(B off, A on/off)이고
  별도로 요구되지 않아 생략했다.
- `git diff --stat`으로 확인한 변경 파일은 `detectCheckmarks.ts`와
  `checkboxRunnerUpCore.test.ts` 둘뿐이다 — `basicCheckboxDetection.ts`,
  `basicCheckboxDetection.test.ts`(Section A 관련 파일)는 이번 라운드에서
  건드리지 않았다.

### 확신 없는 부분

- `isRunnerUpCoreEnabled` 테스트에서 `'true'`같은 임의 문자열도 off로 남는지
  확인하는 케이스를 추가했는데, 주문서는 이를 요구하지 않았다 — "정확히 `'1'`일
  때만"이라는 조건을 더 분명히 검증하려는 판단이었다. 과하다고 보면 제거해도
  로직에는 영향 없다.
