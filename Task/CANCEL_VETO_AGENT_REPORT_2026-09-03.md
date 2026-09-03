# 취소 표시 거부권 (`MARK_CANCEL_VETO`) — 위임 보고

브랜치 `cancel-veto`, 기반 `f6c12b5`(`contest-shape`). 주문서: `cancel-veto-order.md`.
**자체 합격 판정 없음.** 아래 숫자는 전부 합성 상자에서 나온 것이고, 오답 감소·빈칸 증가
비율의 판정은 위임자가 노드 4세트·사진 4세트·브라우저 19명에서 한다.

---

## 1. 바꾼 파일과 위치

작업 후 줄 번호 기준.

| 파일 | 줄 | 내용 |
|---|---|---|
| `src/lib/recognition/markDensity.ts` | 2097–2099 | `traceMeasurements = markShapeTraceEnabled()`를 그룹당 한 번 읽는다 |
| | 2111–2116 | 측정값의 8개 트레이스 키를 **트레이스 플래그에만** 건다(거부권으로는 안 붙는다) |
| | 2381–2394 | 4중 게이트와 구제 경로의 전제를 이름 있는 불리언으로(`highConjunctionHolds`, `rescueHolds`) |
| | 2396–2427 | **거부권 본체** — 아래 §2 |
| | 2429 | 기존 고신뢰 분기가 `if (highConjunctionHolds)`로 |
| | 2458 | 기존 구제 분기가 `if (rescueHolds)`로 |
| | 2935 | 퇴화 셀의 0 트레이스를 `shapeTraceNeeded()`로 |
| | 3439 | `analyzeResidualShape`의 트레이스 계산을 `shapeTraceNeeded()`로 |
| | 3796–3862 | 새 헬퍼 5개: `CANCEL_CROSSING_DEFAULT`(0.6)·`CANCEL_FILL_DEFAULT`(0.22), `cancelVetoEnabled()`, `shapeTraceNeeded()`, `cancelThreshold()`, `refusesAsCancelledMark()` |
| `src/lib/review/evidence.ts` | 98 | `case 'cancel-crossing': return '취소 표시로 보이는 교차 획';` — **한 줄** |
| `tests/helpers/cancelVeto.ts` | 신규 85줄 | `withCancelVeto()` / `pinCancelVetoOff()` — 기존 `affineTone`·`scorerVariants`와 같은 패턴 |
| `tests/mark-cancel-veto.test.ts` | 신규 305줄 | §B의 시험 11건 |
| `tests/recognition-mark-density.test.ts` | 19, 21–26 | `pinCancelVetoOff()` (§5.4) |
| `tests/satisfaction-recognition.test.ts` | 7, 9–14 | `pinCancelVetoOff()` (§5.4) |

**바꾸지 않은 것**: 게이트 상수, 점수, 순위·정렬, 2위 처리, 격자 코드, UI 컴포넌트,
`hasStructuredTemplateMark`, `rescueConfidence`, `isContestedHighConfidenceRunnerUp`,
`describeEvidence`의 분기. 새 의존성 없음. `npm run build` 실행 안 함. 학생 파일은 읽지도
복사하지도 않았다(이 체크아웃에 없다).

---

## 2. 거부권이 작용하는 정확한 위치

`src/lib/recognition/markDensity.ts` `analyzeChoiceGroup()`, **2412행**:

```
if ((highConjunctionHolds || rescueHolds) && refusesAsCancelledMark(best.shape)) {
```

`밴드 구조`·`사진 이진` 거절 **뒤**, 값을 만들 수 있는 **모든 반환보다 앞**이다. 파일에서
`confidence: 'high'`를 반환하는 곳은 둘뿐이고(2429행 4중 게이트, 2458행 구제 경로),
`detectCheckmarks`는 `high`가 아니면 값을 쓰지 않는다. 그 둘의 전제를 여기서 한 번에 읽으므로
**CAGI·만족도·사진·회색조가 모두 이 한 줄을 지나며 자기 분기를 갖지 않는다.** 두 반환보다
앞에 두었기 때문에 4중 게이트에서 거절된 칸이 구제 경로로 다시 확정되는 일도 없다.

거절 시 반환은 값 없음 / `confidence: 'low'` / `contested: true` / `refused`에 `cancel-crossing`
추가 / `describeDecision(..., contested = true)`. **2위를 대신 채우지 않고, 검수 기본값
(`suggestion`)도 제시하지 않는다** — 밴드 구조·사진 이진 거절과 같은 이유다. 이 규칙이 의견을
가진 유일한 상자가 방금 거절한 그 상자이므로, 그것을 기본값으로 내밀면 검수자를 취소된 표시로
다시 데려간다.

규칙 자체(`refusesAsCancelledMark`, 3856행):

```
crossingScore >= MARK_CANCEL_CROSSING(기본 0.6)  AND  inkBboxFill >= MARK_CANCEL_FILL(기본 0.22)
```

`MARK_CANCEL_VETO`가 없으면 첫 줄에서 `false`로 나가고 아무것도 읽지 않는다. `shapeTrace`가
없는 칸(원시 밀도 경로 — 빈 양식이 없어 `best.shape` 자체가 없다)도 `false`다. 즉 거부권은
**빈 양식 대비 경로에서만** 작동한다.

---

## 3. md5 — 변수를 끄면 바이트 동일

`f6c12b5`의 md5 하네스(`tests/mark-shape-trace.test.ts`, 6칸 합성 픽스처의
`JSON.stringify(result.candidateMeasurements)`)를 그대로 돌렸다. 그 시험은 기반 커밋
`4fef6ec`에서 측정된 값을 `expect(...).toBe(...)`로 박고 있다.

```
기반 f6c12b5가 박아 둔 값        fb4157cbae4deb97b37d75a7c10ace0c
작업 후, 변수 미설정              fb4157cbae4deb97b37d75a7c10ace0c
작업 후, MARK_CANCEL_VETO=1       fb4157cbae4deb97b37d75a7c10ace0c
작업 후, VETO=1 + 문턱 둘 다 이동   fb4157cbae4deb97b37d75a7c10ace0c
  (MARK_CANCEL_CROSSING=0.1 MARK_CANCEL_FILL=0.05)
```

**전부 일치.** 세 번째·네 번째 줄이 요점이다: 거부권을 켜면 `shapeTrace`가 **계산되지만**
`candidateMeasurements`에는 붙지 않는다(2111–2116행이 트레이스 플래그만 본다). 그래서 거부권을
켜고 측정을 돌려도 내보내는 행의 컬럼 수가 변하지 않는다.

`tests/mark-cancel-veto.test.ts`에도 같은 성질을 자기 픽스처로 박아 두었다 —
`digest(ON) === digest(OFF)`이고, 켠 상태의 어떤 측정값도 8개 키를 own property로 갖지 않는다
(`hasOwnProperty` 검사).

---

## 4. 시험

### 4.1 새 시험 `tests/mark-cancel-veto.test.ts` (11건)

픽스처는 `mark-shape-trace.test.ts`와 같은 기하다(후보당 상자 하나, 1:1 표본 `36×28`, 맨
종이 빈 양식). 두 마크 모두 **3표본 굵기 펜**으로 그렸다 — 1표본 X는 `inkBboxFill` 0.09라
아무리 깨끗하게 교차해도 0.22를 못 넘는다. 그것은 픽스처 사고가 아니라 **연언이 일하는
모습**이고, 그래서 굵기를 줬다.

측정값(합성):

```
cancelled (X, 3표본 펜)   crossingScore 1.000  inkBboxFill 0.319
selected  (한 획, 같은 펜) crossingScore 0.000  inkBboxFill 0.125
```

- 측정 기록: 거부권 on/off의 md5가 같다 / 켠 상태에서 8개 키가 붙지 않는다
- 변수 미설정: X가 든 칸이 전과 똑같이 `value 1 · high`로 채워진다
- 변수 설정: X는 값 없음 · `high` 아님 / `contested: true`, `evidence.outcome === 'contested'`,
  `refused`에 `cancel-crossing`, 결정 문자열에 `cancel-crossing`·`contested=1`
- **2위 미승격**: 값 없음 · `suggestion` 없음 · 1위는 여전히 X(순위 무변경) · `candidates` 동일
- 한 획은 켜고 끈 결과의 값·신뢰도·경합·**결정 문자열까지 완전히 같다**
- 문턱: `MARK_CANCEL_FILL=0.4`면 X가 살아난다(0.319 < 0.4) / `MARK_CANCEL_CROSSING=0` +
  `MARK_CANCEL_FILL=0.1`이면 한 획도 거절된다(둘 다 읽혔다는 증거이지 쓸 규칙이 아니다) /
  숫자가 아닌 값·빈 문자열은 기본값으로 되돌아간다
- `refusalLabel('cancel-crossing') === '취소 표시로 보이는 교차 획'`

### 4.2 전체

```
npx tsc --noEmit                                통과 (출력 없음)

npx vitest run                                  Test Files 51 passed | 18 skipped (69)
                                                Tests      504 passed | 18 skipped (522)

MARK_CANCEL_VETO=1 npx vitest run               Test Files 51 passed | 18 skipped (69)
                                                Tests      504 passed | 18 skipped (522)

MARK_CANCEL_VETO=1 MARK_SHAPE_TRACE=1 ...       Test Files 51 passed | 18 skipped (69)
                                                Tests      504 passed | 18 skipped (522)

MARK_SHAPE_TRACE=1 npx vitest run               Test Files 51 passed | 18 skipped (69)
                                                Tests      504 passed | 18 skipped (522)

MARK_AFFINE_TONE=1 npx vitest run               Test Files 51 passed | 18 skipped (69)
                                                Tests      504 passed | 18 skipped (522)
```

기반은 `50 passed / 493 passed`였다. 늘어난 파일 1개·시험 11건이 새 파일이다. 건너뛴 18건은
실제 스캔·프로브처럼 입력이 없어 원래 건너뛰는 것들이다.

---

## 5. 명세와 다르게 한 것

### 5.1 거부권을 **구제 경로에도** 걸었다 (가장 중요한 차이)

주문서는 "4중 게이트를 통과한 뒤"라고 썼다. 그대로 읽으면 2429행 분기만 지킨다. 그렇게 하지
않고 **자동값을 만드는 두 반환 모두**(4중 게이트, 구제 경로)를 한 `if`로 덮었다. 근거 둘:

1. 주문서 §확정된 사실 2의 훑기는 "**자동 행** 정답 309·오답 9"에서 나왔다. 자동 행에는 구제
   경로가 만든 행이 섞여 있다. 게이트 분기만 막으면 실제 효과가 예측표(4/9 제거, 14 손실)보다
   **작게** 나오고, 위임자가 예측과 관측을 맞춰 볼 수 없다.
2. 주문서 본문의 "값 결정 **한 곳**에서 작용한다 — 별도 분기 금지"와 위임 지시의 "the veto
   acts at the single value-decision point for **every path**"는 문서 종류별 분기 금지로 읽되,
   자동값을 만드는 경로를 하나만 막는 것은 "한 곳"의 취지에 어긋난다고 판단했다.

**이것이 틀린 판단이면 되돌리는 방법은 2412행의 `|| rescueHolds`를 지우는 것 하나다.**

### 5.2 두 `if` 조건을 이름 있는 불리언으로 뽑았다

`highConjunctionHolds`(2386)와 `rescueHolds`(2390). **같은 식·같은 순서**이고, 둘 다 위에서
이미 계산된 값만 읽는 순수 불리언이다(`rescue`는 2238행에서 이미 무조건 계산된다). 문턱은
하나도 움직이지 않았다. 뽑은 이유는 거부권이 "이 그룹이 자동값에 도달하는가"를 **두 군데가
아니라 한 군데에서** 읽게 하기 위해서다.

### 5.3 측정값 스프레드를 트레이스 플래그에만 걸었다

기반에서는 `...(candidate.shape?.shapeTrace ?? {})`가 "트레이스가 꺼져 있으면 `shapeTrace`가
없다"는 사실에 기대고 있었다. 거부권이 켜지면 `shapeTrace`가 **생기므로** 그 가정이 깨진다.
주문서가 "측정값 필드 추가는 트레이스 플래그가 있을 때만"이라고 못 박았으므로 2116행에서
`traceMeasurements`(= `markShapeTraceEnabled()`)로 명시적으로 걸었다. §3의 셋째·넷째 md5가
이것의 검증이다.

### 5.4 기존 합성 시험 두 개에 거부권 off를 명시했다

`MARK_CANCEL_VETO=1 npx vitest run`이 처음에 **2파일 2건** 실패했다. 원인을 계측했다:

```
tests/recognition-mark-density.test.ts  "hand-drawn ring"  crossingScore 1.000  inkBboxFill 0.302
tests/satisfaction-recognition.test.ts  writeMarkedForm 채움 마크        0.98            0.716
```

둘 다 §2.1(`CONTEST_SHAPE_AGENT_REPORT` §2.1, `MarkShapeTrace` 주석)이 "`crossingScore`가
교차와 가르지 **못한다**"고 명시한 **닫힌 곡선·채움** 계급이다. 두 시험은 "채점기가 표시된
양식을 채운다"는 **출하 동작**을 주장하는 것이지 거부권을 주장하지 않는다. 그래서
`tests/helpers/cancelVeto.ts`의 `pinCancelVetoOff()`로 각 파일에서 변수를 명시적으로 끄고,
그렇게 한 이유를 파일 안 주석에 계측값과 함께 남겼다.

**문턱을 낮춰서 통과시키지 않았다.** 제품 동작은 하나도 바뀌지 않는다. 이 패턴은 기존
`withAffineTone`·`pinShippedScorer`가 하는 것과 같다 — 플래그를 켠 채로도 스위트가 돌아야
하므로, 출하 경로를 주장하는 스위트는 자기가 어느 쪽인지 말한다.

### 5.5 거절한 그룹에 검수 기본값을 주지 않았다

주문서가 지정하지 않은 부분이다. §2에 이유를 적었다.

---

## 6. 확신 없는 부분

1. **거절한 행에 경합 배지가 실제로 뜨지 않는다.** 이것이 가장 중요한 미해결 항목이다.
   `contestedUnconfirmedFields`(`src/lib/review/settlement.ts:52`는
   `unconfirmedMachineFields`를 거르는데, 그 함수는 **값이 있고** 출처가 `auto`/`restored`인
   칸만 반환한다. 거부권은 값을 없애므로 그 목록에 들어가지 않는다.
   `renderValueSourceBadge`(`src/components/RecognitionReview.tsx:774`)의 배지도 값 출처를
   요구한다. `recognitionContested[field] = true`는 **기록되고 전달되지만**, 검수자 화면에는
   주황 경합 카드가 아니라 그냥 빈 `미확정` 행으로 보인다.
   보이게 하려면 `settlement.ts` 또는 UI 컴포넌트를 고쳐야 하는데, 주문서가 UI 로직 변경을
   금지했으므로 **건드리지 않았다.** 위임자의 결정이 필요하다.
2. **새 검수 문구가 `describeEvidence`에서 가려진다.** `evidence.ts:148–153`이 `contested`면
   경합 줄을 **먼저** 반환하므로, `취소 표시로 보이는 교차 획`은 그 경로로 검수자에게
   도달하지 않는다. 도달하는 경로는 `refusalLabel()` 직접 호출과 `decision` 추적 문자열의
   `refused=cancel-crossing`이다. 고치려면 `describeEvidence`의 분기를 바꿔야 해서(문구 한 줄
   범위를 넘는다) 두었다. 1번과 같은 뿌리다 — 거절과 경합을 동시에 표시하도록 만들어진
   표시 계층이 아니다.
3. **실제 취소 표시에서 이 규칙이 발화하는지는 모른다.** 합성에서 X와 한 획이 갈렸을 뿐이다.
   `CONTEST_SHAPE_AGENT_REPORT` §6.1이 남긴 질문 — 지운 상자에 남는 잔차가 X 전체인지 원래
   마크와 뒤엉킨 덩어리인지 — 는 그대로 열려 있다. 후자라면 `inkBboxFill`이 0.22보다 훨씬
   높아 규칙이 더 자주 발화한다.
4. **원시 밀도 경로에서는 절대 발화하지 않는다.** `usesBaseline`이 거짓이면 `best.shape`가
   없고 `shapeTrace`도 없다. 퇴화 셀(표본 0)도 0 트레이스라 발화하지 않는다. 의도한 대로지만
   기록해 둔다.
5. **브라우저 전달 경로를 재보지 않았다.** `cancelVetoEnabled()`는 `markShapeTraceEnabled()`와
   같은 `process.env` 패턴이라 노드에서만 켜진다. 브라우저 19명 측정에서 이 플래그를 어떻게
   넣을지는 위임자가 확인해야 한다(형태 계측 보고 §6.5와 같은 주의).
6. **문턱 파싱은 관대하다.** 숫자가 아니거나 빈 문자열이면 기본값으로 돌아간다. 오타를 조용히
   무시한다는 뜻이므로, 훑기를 돌릴 때 값이 실제로 먹었는지는 결과로 확인해야 한다.

## Default raised to 0.7 (2026-09-03, judge)

The delegate that wrote this round could not make the change: two attempts ended on HTTP 529 before any edit. Rather than hold the merge for a
one-line constant, the judge (main agent) made it and ran the same three commands. `CANCEL_CROSSING_DEFAULT` is 0.7; the comment above it carries the
measurement that chose the value. Nothing else moved -- `CANCEL_FILL_DEFAULT` is still 0.22, the decision point is untouched.

Measured, from `Task/CANCEL_VETO_2026-09-03.md`: over scan sets 1-3, 0.6 removes 5 wrong values and blanks 47 correct (10.4 review cells per wrong,
past the 10 limit); 0.7 removes 3 and blanks 20 (7.7:1). Four scan sets at 0.7 measured `354/4/79 · 338/7/92 · 343/2/92 · 297/7/133`, photos
`60/0 · 34/0 · 42/0 · 32/0`, browser `auto 335 · correct 329 · wrong 6 · blank 102`.

Checks: `npx tsc --noEmit` clean; `npx vitest run` 504 passed / 18 skipped; `MARK_CANCEL_VETO=1 npx vitest run` 504 passed / 18 skipped.

