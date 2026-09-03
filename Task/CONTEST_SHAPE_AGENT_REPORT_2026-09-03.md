# 경합 칸 형태 계측 (`MARK_SHAPE_TRACE`) — 위임 보고

브랜치 `contest-shape`, 기반 `4fef6ec`. 주문서: `contest-shape-order.md`.
**계측 라운드다. 자체 합격 판정 없음** — 아래 숫자는 전부 합성 상자에서 나온 것이고,
실제 래스터의 분포 비교는 위임자가 한다.

---

## 1. 바꾼 파일과 위치

작업 후 줄 번호 기준. 삭제된 줄은 없다(`302 insertions(+)`, 0 deletions).

| 파일 | 줄 | 내용 |
|---|---|---|
| `src/lib/recognition/markDensity.ts` | 78–93 | `CandidateMeasurement`에 8개 **선택적** 필드 추가 |
| | 275–276 | `TemplateInkShape.shapeTrace?: MarkShapeTrace` |
| | 279–358 | `MarkShapeTrace` 인터페이스(정의 주석 포함) + `EMPTY_MARK_SHAPE_TRACE` |
| | 2108–2111 | `candidateMeasurements` 생성 시 `...(candidate.shape?.shapeTrace ?? {})` |
| | 2890–2893 | 표본이 0인 퇴화 셀: 플래그가 켜져 있으면 0으로 채운 트레이스 |
| | 3395–3400 | `analyzeResidualShape` 반환에 조건부 `shapeTrace` |
| | 3407–3533 | `analyzeShapeTrace()` — 새 함수, 읽기만 |
| | 3744–3753 | `markShapeTraceEnabled()` — `baselineDilationEnabled()` 바로 아래 |
| `src/lib/recognition/detectCheckmarks.ts` | 9 | `type CandidateMeasurement` 임포트 추가 |
| | 763–782 | `pickShapeTrace()` — 있을 때만 8개 키를 이름으로 골라 넘긴다 |
| | 815 | `buildCandidateMeasurements`에서 `...pickShapeTrace(measurement)` |
| `tests/_probe-scorer-cells.test.ts` | 53–63 | `MeasuredCandidate`에 8개 선택적 필드 |
| | 98–105 | JSONL 행에 8개 컬럼(`?? null`) |
| `tests/mark-shape-trace.test.ts` | 신규 348줄 | C의 시험 |

**바꾸지 않은 것**: 점수·게이트·순위·정렬·격자·UI 코드 어디에도 손대지 않았다.
`hasStructuredTemplateMark`, `analyzeChoiceGroup`의 랭킹, `evidence.shape`,
`src/lib/review/evidence.ts`는 그대로다. 새 의존성 없음. `npm run build` 실행 안 함.
학생 파일은 읽지도 복사하지도 않았다.

---

## 2. 특징 정의 (정확히)

전부 **기존 문턱 이후의 같은 이진 잉크 맵** 위에서 센다:
`residual[y * width + x] > 0.08`, 창 `1 <= x < width-1`, `1 <= y < height-1`.
`analyzeResidualShape`가 `largestComponentSize`/`diagonalRatio`를 재는 창과 동일하다
(테두리 한 줄을 버리므로 3×3 필터는 항상 이웃 여덟 개를 갖는다).
아래에서 "잉크 픽셀"은 그 창 안의 문턱 초과 표본이고, `activePixels`는 그 개수다.
`width`/`height`는 표본 격자 `36 × 28`이다.

| 필드 | 정의 |
|---|---|
| `componentCount` | 창 안 잉크의 **8-연결 성분 개수** |
| `component2Size` | **둘째로 큰** 성분의 픽셀 수. 성분이 하나면 `0` |
| `inkBboxFill` | `activePixels / (잉크 경계상자 넓이)`. 경계상자는 축 정렬, 폭 = `maxX-minX+1` |
| `diagonalPos` | `(x-1,y-1)`과 `(x+1,y+1)`이 **둘 다** 잉크인 잉크 픽셀 수 ÷ `activePixels` (좌상→우하 획) |
| `diagonalNeg` | `(x+1,y-1)`과 `(x-1,y+1)`이 **둘 다** 잉크인 잉크 픽셀 수 ÷ `activePixels` (우상→좌하 획) |
| `crossingScore` | 아래 참조 |
| `spanX` | `(경계상자 폭) / (width - 2)` |
| `spanY` | `(경계상자 높이) / (height - 2)` |

`crossingScore`는 **배타 집합** 위에서 계산한다.
`P` = `diagonalPos` 조건은 만족하고 `diagonalNeg`는 아닌 픽셀, `N` = 그 반대.

```
iou      = area(bbox(P) ∩ bbox(N)) / area(bbox(P) ∪ bbox(N))
balance  = 2 * min(|P|, |N|) / (|P| + |N|)
crossingScore = iou * balance          # |P|=0 또는 |N|=0 이면 0
```

두 집합 모두 축 정렬 경계상자로만 비교한다(픽셀 단위 교집합이 아니다).
배타로 만든 이유: 채워진 덩어리는 내부 픽셀마다 두 조건을 **동시에** 만족해서,
포함 집합으로 재면 교차로 읽힌다.

### 2.1 `crossingScore`가 가르는 것과 못 가르는 것 — 반드시 같이 읽어라

합성 픽스처(§4) 측정값:

```
두 획 교차 (X)      crossingScore 1.00   inkBboxFill 0.09   diagPos 0.45  diagNeg 0.45
한 획               crossingScore 0.00   inkBboxFill 0.05   diagPos 0.91  diagNeg 0.00
동그라미(고리)      crossingScore 1.00   inkBboxFill 0.16   diagPos 0.17  diagNeg 0.17
직선 모서리 채움    crossingScore 0.00   inkBboxFill 1.00   diagPos 0.69  diagNeg 0.69
```

**가르는 것**: 교차 대 **한 획**. 주문서 §C가 요구한 것이 이것이고, 이것은 된다.

**못 가르는 것**: 교차 대 **닫힌 곡선**. 고리도 1.00이고, 실제로 칠해진 마크의
너덜한 경계도 그렇게 읽힌다 — 합성 양식을 end-to-end로 돌린 실제 채움 마크가
**0.98**이었다(§4.2). `crossingScore = 0`이 나오는 채움은 모서리가 곧고 축에 정렬된
사각형뿐이고, 손으로 그린 마크는 그렇지 않다.

**그러므로 `crossingScore`는 `inkBboxFill`과 한 쌍으로만 읽어야 한다.** 고리·채움을
교차와 가르는 것은 `inkBboxFill`이다. 이 한계는 소스 주석(`markDensity.ts` 296–348)과
시험 주석 양쪽에 적어 두었다.

---

## 3. md5 — 플래그를 끄면 바이트 동일

고정된 합성 픽스처(6칸: 교차·한 획·고리·채움·두 틱·빈칸) 한 그룹을
`analyzeChoiceGroup`으로 돌려 `JSON.stringify(result.candidateMeasurements)`의 md5를 잰다.
`MARK_SHAPE_TRACE`는 본문 안에서 명시적으로 지운다.

```
기반 4fef6ec (변경분 stash)  fb4157cbae4deb97b37d75a7c10ace0c
작업 후, 변수 미설정          fb4157cbae4deb97b37d75a7c10ace0c
```

**일치.** 절차: `git stash push -- <추적 3파일>` → 미추적 상태로 남은 시험 파일을
기반 코드에 대고 실행 → 값 확인 → `git stash pop` → 상수로 고정.
이 md5는 `tests/mark-shape-trace.test.ts`에 `expect(...).toBe(...)`로 박혀 있어서,
키가 하나 늘거나 순서가 바뀌면 실제 export의 diff가 아니라 여기서 먼저 깨진다.

`recognitionMeasurements`까지의 동일성은 §4.2에서 따로 확인했다.

---

## 4. 시험

### 4.1 새 시험 `tests/mark-shape-trace.test.ts` (10건)

픽스처는 `ink-invariant.test.ts`와 같은 모양이다 — 후보당 상자 하나, 1:1 표본
(`36×28`), 그래서 찍은 픽셀 하나가 표본 하나다. 빈 양식은 맨 종이라 찍은 잉크는
잔차 ~0.92로 살아남아 문턱 0.08을 넉넉히 넘는다. `pinShippedScorer()`와
`withAffineTone(false, ...)`로 다른 계측 플래그의 영향을 끊었고, `MARK_SHAPE_TRACE`는
케이스마다 자기 쪽을 명시한다(주변 환경을 상속하지 않는다).

- 변수 미설정: md5가 기반과 같다 / 어떤 측정값에도 8개 키가 **존재하지 않는다**
  (`hasOwnProperty` 검사)
- 변수 설정: 모든 후보가 8개 필드를 다 갖는다 / X는 교차로 읽힌다
  (`crossingScore > 0.6`, `diagPos·diagNeg > 0.3`) / 한 획은 `crossingScore === 0` /
  고리는 `inkBboxFill < 0.3`이고 `spanX ≈ spanY` / 직선 모서리 채움은 `0` /
  두 틱은 `componentCount 2`, `component2Size 8` / 빈칸은 전부 `0` /
  **켜고 끈 결과의 값·신뢰도·경합·후보·decision 문자열·트레이스를 뺀 측정값이 완전히 같다**

주문서가 "체크 한 획"이라고 명시했으므로 체크 픽스처는 대각 한 획으로 만들었다.

처음 돌렸을 때 세 건이 실패했고, **픽스처 기하가 틀린 것이었지 계측기가 틀린 것은
아니었다**: (a) X의 획이 45°가 아니라 27:21이라 수평 구간이 생겨 3×3 필터가 발화하지
않았다 → 21:21로 고쳤다. (b) 고리를 셀 종횡비가 아니라 표본 격자에 맞춰 그려서
`spanX ≠ spanY`가 나왔다 → 두 축에서 같은 비율(26/34 대 20/26)을 차지하도록 고쳤다.
어느 쪽도 임계값을 낮춘 것이 아니다.

### 4.2 end-to-end 배선 확인 (일회성, 커밋하지 않음)

`recognitionMeasurements`까지 실제로 실리는지를 기존 합성 양식 시험
(`tests/satisfaction-recognition.test.ts`, `writeMarkedForm`)에 임시 `console.info`를
꽂아 확인하고 **원본을 그대로 복구했다**(무거운 헬퍼를 복제하지 않으려고 빌렸다).
같은 칸, 같은 실행:

```
ON  : ...,"diagonalRatio":0.49013367281986,"componentCount":1,"component2Size":0,
      "inkBboxFill":0.7163461538461539,"diagonalPos":0.7315436241610739,
      "diagonalNeg":0.727069351230425,"crossingScore":0.9827586206896551,
      "spanX":0.7647058823529411,"spanY":0.9230769230769231,"registrationStatus":"verified",...
OFF : ...,"diagonalRatio":0.49013367281986,"registrationStatus":"verified",...
```

OFF 쪽은 8개 키만 없을 뿐 **키 순서도 자릿수도 동일**하다. 8개 키는 `diagonalRatio`
뒤, `registrationStatus` 앞에 들어간다. (이 실행이 §2.1의 0.98을 낸 그 마크다.)

### 4.3 전체

```
npx tsc --noEmit                     통과 (출력 없음)
npx vitest run                       Test Files 50 passed | 18 skipped (68)
                                     Tests      493 passed | 18 skipped (511)
MARK_SHAPE_TRACE=1 npx vitest run    Test Files 50 passed | 18 skipped (68)
                                     Tests      493 passed | 18 skipped (511)
```

두 상태의 통과 수가 같다. 건너뛴 18건은 실제 스캔·프로브처럼 입력이 없어 원래
건너뛰는 것들이다(이 체크아웃에 학생 파일이 없다 — 접근하지 않았다).

---

## 5. 명세와 다르게 한 것

1. **`crossingScore`를 배타 집합 위에서 정의했다.** 주문서는 "두 대각 방향 잉크가 같은
   영역에 겹치는 정도, 0~1"까지만 지정했다. 포함 집합으로 하면 채워진 덩어리가
   교차로 읽혀 쓸모가 없어서 배타로 바꿨다. 겹침은 픽셀 교집합이 아니라 **경계상자
   IoU × 개수 균형**이다 — 한 획을 0으로 만드는 것이 균형 항이고, 같은 영역인지를
   보는 것이 IoU다. 한계는 §2.1에 그대로 적었다.
2. **`spanX`/`spanY`의 분모를 셀 전체가 아니라 계측 창(`width-2`, `height-2`)으로 했다.**
   잔차가 채워지는 범위·성분을 세는 범위와 같아야 값이 뜻을 가진다.
3. **퇴화 셀(표본 0)에도 0으로 채운 트레이스를 낸다.** 플래그를 켠 실행의 JSONL에
   구멍이 생기지 않게 하려는 것이다. 끄면 이 경로도 키를 만들지 않는다.
4. **프로브에 `diagonalRatio` 컬럼을 넣지 않았다.** 기존 JSONL에 없던 칸이고 주문서가
   요구한 8개에 들어 있지 않아, 플래그와 무관하게 출력을 바꾸게 되므로 뺐다.
5. **`detectCheckmarks.ts`에서 `...measurement` 전체를 펴지 않고 이름으로 골랐다**
   (`pickShapeTrace`). 앞으로 채점기가 무엇을 더 붙이든 export 행에 우연히 새는 일이
   없게 하려는 것이다.

---

## 6. 확신 없는 부분

1. **`crossingScore`가 실제 취소 표시를 잡을지는 모른다.** 합성에서 교차와 한 획이
   갈린 것뿐이다. §34.7이 말하는 실패는 "0에 표시했다가 X로 지우고 1에 다시 표시"인데,
   **지운 쪽 상자에 남는 잔차가 X 전체인지, 원래 마크 + X의 뒤엉킨 덩어리인지**를 나는
   보지 못했다(학생 파일 접근 금지). 후자라면 `componentCount`·`component2Size`·
   `inkBboxFill` 쪽이 더 나은 신호일 수 있다.
2. **`crossingScore` 단독으로는 고리와 교차가 안 갈린다**(§2.1). 위임자가 분포를 볼 때
   `inkBboxFill`을 짝지어 보지 않으면 이 컬럼은 오히려 오도한다.
3. **문턱 0.08을 그대로 썼다.** 주문서가 "문턱 이후"라고 했으므로 그렇게 했지만, §34.7의
   잡음 바닥이 ~0.03이라면 약한 취소 획의 일부는 이 문턱 아래에서 잘려 형태가 끊길 수
   있다. `componentCount`가 실제 칸에서 부풀어 보이면 이것을 의심해야 한다.
4. **경계상자 IoU는 거칠다.** 두 획이 만나기만 하고 교차하지 않는(꼭짓점에서 만나는)
   진짜 체크표는 배타 집합 둘이 다 생기고 경계상자도 상당히 겹쳐서 중간값이 나올 수
   있다. 합성으로는 재지 않았다 — 주문서의 체크가 한 획이었다.
5. **브라우저 경로에서 재보지 않았다.** `markShapeTraceEnabled()`는 기존
   `baselineDilationEnabled()`와 같은 `process.env` 패턴이라 노드에서만 켜진다.
   브라우저 래스터로 분포를 볼 계획이라면 이 플래그가 그쪽에서 어떻게 전달되는지
   위임자가 확인해야 한다.
