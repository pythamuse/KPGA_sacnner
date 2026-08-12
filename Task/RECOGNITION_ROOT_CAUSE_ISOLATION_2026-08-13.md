# 인식 실패 원인 격리 (2026-08-13~)

실제 스캔에서 자동 인식이 채우지 못하는 항목의 원인을, **한 번에 하나씩 브랜치를 나눠 수정하고 같은 숫자로 재측정**해 확정한다. 원인이 하나인지 둘 이상인지도 이 과정에서 판정한다.

관련 상위 문서: [Docs/04_OCR_FORM_RECOGNITION_SPEC.md](../Docs/04_OCR_FORM_RECOGNITION_SPEC.md), [Docs/BUG_REPORTS.md](../Docs/BUG_REPORTS.md), [README.md](../README.md#원인-격리-실험-브랜치-규칙)

선행 스레드: [[REPEATED_COORDINATE_FAILURE_ROOT_CAUSE_AND_REMEDIATION_2026-08-12]], [[BLANK_FORM_GROUND_TRUTH_MEASUREMENT]], [[SAVE_BUTTON_SILENT_VALIDATION_FAILURE]]

---

## 1. 왜 이 스레드가 필요한가

2026-08-11~12에 인식 계층에 2,121줄이 추가됐지만 측정값은 전혀 움직이지 않았다. 원인은 코덱스의 태만이 아니라 **판정 기준이 되는 숫자가 없었다**는 것이다. 최적화 대상이던 빈 양식 픽스처는 이미 통과 중이었고, 실제로 실패하는 자료는 측정되지 않았다.

따라서 이 스레드의 첫 산출물은 코드 수정이 아니라 **계측기**다.

---

## 2. 계측기 — `tests/real-scan-measure.test.ts`

실제 스캔 PDF를 앱과 동일한 pdf.js 경로로 렌더한 뒤 `recognizeStudentForms`를 그대로 돌려, 다음 네 숫자를 출력한다.

| 지표 | 의미 |
|---|---|
| **CORRECT** | 자동 입력됐고 **정답표와 일치**하는 항목 수 (23개/학생) ← **작업의 성패는 이 숫자로 판정한다** |
| **WRONG** | 자동 입력됐으나 정답표와 **다른** 항목 수 ← **0이어야 하며, 테스트가 강제한다** |
| BLANK | 자동 입력되지 않은 항목 수 (안전 — 검수자가 채운다) |
| OFF | 검출 행 중심이 실측 템플릿과 0.01 초과로 벌어진 항목 수 |
| MISSING | 격자/행 검출이 아예 실패한 항목 수 |

**빈칸은 검수자의 키 입력 한 번이지만, 오답은 사람이 확인한 것처럼 중앙 시스템에 저장된다.** 둘을 맞바꾸지 않는다. 그래서 `WRONG > 0`이면 테스트가 실패한다.

> **2026-08-13 지표 교체**: 최초 지표는 `AUTO`(채워진 개수)였다. 이 지표는 오답 4개를 추가한 변경을 "+4 개선"으로 판정했다 — 사이클 1 참고. **채워진 개수가 아니라 맞은 개수를 세야 한다.** 이는 코덱스가 빈 양식 프록시를 최적화하던 것과 같은 종류의 오류였다.

**실제 스캔과 정답표는 모두 학생 응답이므로 저장소에 절대 커밋하지 않는다.** 스캔 경로는 환경변수로 주입하고, 정답표는 gitignore된 `local-scans/answer-key.json`에 둔다. 변수가 없으면 스킵되어 `npm test`는 그대로 통과한다.

```bash
REAL_SCAN_CAGI_PDF="C:/Users/night/Desktop/선별검사 샘플1.pdf" REAL_SCAN_SAT_PDF="C:/Users/night/Desktop/만족도조사1.pdf" REAL_SCAN_PAGES=2 npx vitest run tests/real-scan-measure.test.ts
```

---

## 3. 기준선 (main, `34538ce` / v2026-08-12.1, 2026-08-13 측정)

```
CORRECT 34/46   WRONG 0   BLANK 12   OFF 6   MISSING 1
  page 1: CORRECT 19/23  (blank: age, gender, schoolType, grade)
  page 2: CORRECT 15/23  (blank: age, gender, schoolType, grade, sat.q01, q03, q07, q08)
```

**현재 자동 입력되는 34개는 전부 정답이다.** 즉 지금 배포본은 "덜 채우지만 틀리지는 않는" 상태다. 개선의 정의는 **BLANK를 CORRECT로 옮기는 것**이며, BLANK를 WRONG으로 바꾸는 변경은 개선이 아니라 회귀다.

정답표는 실제 양식 이미지를 직접 판독해 작성했다(`local-scans/answer-key.json`, 미커밋). 두 페이지 모두 성별 여·학교유형 중학교·학년 2학년·나이 14, CAGI 1~9 전부 0. 만족도는 p1이 4/1·1·1·1·1/4·4·4·4, p2가 3/1·1·1·0·1/4·4·4·4.

---

## 4. 확정된 원인 목록

미충족 12개(46 − 34)가 원인별로 정확히 나뉜다. **단일 원인이 아니라 최소 네 개다.**

### 원인 A — 기본정보 3개 항목에 자동 입력 경로가 아예 없다 (6/12) ★최우선

성별·학교유형·학년은 스캔 품질이나 좌표 정확도와 **무관하게** 항상 수동 입력이다.

자동 입력 게이트는 [`detectCheckmarks.ts:552`](../src/lib/recognition/detectCheckmarks.ts):

```ts
function isVerifiedGrid(registration?: FieldRegistration): boolean {
  return registration?.source === 'grid' && registration.status === 'verified';
}
```

이 값이 `allowAutoValue`를 결정한다(`:205`, `:224`, `:321`, `:338`). 그런데 기본정보의 등록 정보를 만드는 [`tableGridDetection.ts:212`](../src/lib/recognition/tableGridDetection.ts)는 두 조건을 **하드코딩으로 배제**한다:

```ts
source: hasCandidateCells ? 'row' : 'fixed',        // 'grid' 가 될 수 없음
status: hasCandidateCells ? 'candidate' : 'failed', // 'verified' 가 될 수 없음
```

`"column geometry is not independently verified"`라는 화면 문구도 사실이다 — [`tableGridDetection.ts:191`](../src/lib/recognition/tableGridDetection.ts)에서 기본정보의 X좌표는 검출값이 아니라 **템플릿 상수**를 쓴다. 열을 검출한 적이 없으니 검증될 수도 없다. 이 문구는 스캔 결함이 아니라 **설계를 서술하고 있다.**

증거: 실제 스캔 page 1에서 기본정보 3개의 좌표 오차는 각각 −0.0006 / +0.0017 / −0.0003(0.06~0.17%)로 정확한데도 전부 `낮음` + `src=fixed` + 값 없음이다.

### 원인 B — 연령대 OCR이 예산 안에 끝나지 않는다 (2/12)

화면 진단 문구 그대로다: `Age OCR did not finish within the allowed time`, `Age OCR was skipped because the shared OCR worker was still initializing`. 좌표 문제가 아니다(`OCR region uses the measured template anchor`). 관련 배경: [[OCR_ANCHORED_ROW_DETECTION]].

### 원인 C1 — 격자 거부 시 템플릿 폴백이 오히려 더 부정확하다 (2/12)

page 2 만족도에서 격자가 `최대 편차 78% (허용 35%)`로 거부되고 실측 템플릿 좌표로 되돌아갔다. 그 결과 q01~q06의 행 중심이 0.012~0.021 어긋났고 q01·q03이 값을 얻지 못했다.

주의: 같은 페이지에서 q07~q10은 정상 범위다. 페이지 전체가 밀린 것이 아니라 **중간 표만 다른 위치에 있다.** 즉 그 페이지에서는 격자 쪽이 오히려 진실에 가까웠을 가능성이 있으며, 이는 실험으로 확인해야 한다.

### 원인 C2 — 좌표가 정확한데도 마킹 근거가 부족하다 (2/12)

page 2 만족도 q07·q08은 좌표 오차가 −0.0049 / −0.0054로 **허용 범위 안**인데도 값이 비었다(`conf=low`, `src=grid`). 좌표와 무관한 **마킹 판별** 문제다. 인쇄된 원과 손으로 표시한 마크의 구분 문제로 추정되나 미확정.

### 기각된 가설

| 가설 | 기각 근거 |
|---|---|
| ~~좌표표(템플릿)가 부정확하다~~ | 빈 양식 Y 최대 편차 0.0058, 템플릿 X ≈ 그리드 X ≈ 실측(최대 0.0097). 과거 `cagiOptionXs` 0.05 오차는 이미 수정됨 |
| ~~PDF 경로에 기울기 보정이 없어서 실패한다~~ | 실제 스캔 4페이지 모두 격자 검출 성공(page 1 오차 ≤0.0021). 합성 회전 취약성은 사실이나 이 PDF들의 실패 원인은 아님 |

---

## 5. 실험 계획 — 원인 하나당 브랜치 하나

| 순서 | 브랜치 | 원인 | 기대 결과 | 상태 |
|---|---|---|---|---|
| 1 | `exp/cause-c2-mark-evidence` | C2 | CORRECT 34 → **36**, WRONG 0 유지 | 진행 중 |
| 2 | `exp/cause-a-basic-registration` | A | C2 이후 재측정 → **40** | **보류** (C2 선행 필요) |
| 3 | `exp/cause-b-age-ocr` | B | CORRECT 34 → **36** | 대기 |
| 4 | `exp/cause-c1-grid-fallback` | C1 | CORRECT 34 → **36** | 대기 |

**각 브랜치는 `main`에서 분기하고 원인 하나만 건드린다.** 두 원인을 한 브랜치에서 고치면 어느 쪽이 효과를 냈는지 판정할 수 없으므로 금지한다. 규칙 전문은 [README의 "원인 격리 실험 브랜치 규칙"](../README.md#원인-격리-실험-브랜치-규칙).

**순서가 바뀌었다.** 원래 A를 먼저 했으나, 사이클 1에서 **A의 게이트를 열면 C2가 즉시 오답을 만들어낸다**는 것이 확인됐다. C2를 A의 선행 조건으로 승격한다. C2 해결 후 A 브랜치를 재측정해 함께 병합한다.

---

## 6. 작업지시서 — 원인 A (코덱스, 루나-최대)

### 목표

성별·학교유형·학년이 **자동 입력될 수 있는 경로 자체를 만든다.** 임계값 조정이 아니라 상태 등급의 문제다.

### 배경 (반드시 읽을 것)

지금 구조에서 이 세 항목은 `isVerifiedGrid()`의 두 조건(`source==='grid'`, `status==='verified'`)을 **코드상 만족할 수 없다.** 행은 검출되지만 열은 템플릿 상수를 쓰기 때문에 "열 기하가 독립 검증되지 않았다"가 영구히 참이다.

### 방향 (둘 중 하나를 선택하고, 고른 이유를 문서에 남길 것)

1. **열 좌표를 실제로 검출한다** — 기본정보 표의 세로선을 찾아 후보 열 경계를 얻고, 성공하면 `source: 'grid'`, `status: 'verified'`를 부여한다. 근본적이지만 기본정보 표는 2차원 불규칙 구조라 난도가 높다.
2. **"행 검증됨 + 열은 템플릿" 상태에 대한 승인 등급을 정의한다** — 예: `status: 'row-verified'`를 추가하고, `isVerifiedGrid` 대신 "자동 입력 허용 여부"를 판정하는 함수를 두어 이 등급도 통과시키되 `requiresHighVisualConfidence`는 유지한다.

### 제약 (위반 시 되돌림)

1. **`markDensity.ts`의 신뢰도 임계값과 `allowAutoValue` / `requireHighVisualConfidence`의 의미를 바꾸지 말 것.** 이 작업은 "검증 등급을 부여할 경로가 없다"를 고치는 것이지 판정 기준을 낮추는 것이 아니다. 틀린 값이 자동 저장되는 것보다 비어 있는 편이 안전하다는 원칙은 그대로다.
2. **원인 A 외의 코드를 건드리지 말 것** — 연령대 OCR, 만족도 폴백, 마킹 판별은 별도 브랜치에서 다룬다.
3. 브랜치는 `main`에서 분기한 `exp/cause-a-basic-registration` 하나만 쓴다.
4. `npm test` 및 `npm run build` 통과. `templates/` 원본 무변경([Docs/05_HARNESS.md](../Docs/05_HARNESS.md) 규칙 1).
5. 배포해 테스트할 경우에만 버전 마커 갱신([README](../README.md#배포마다-테스트-버전-번호-갱신-필수)).

### 보고 시 반드시 포함할 것

수정 전후로 아래를 실행해 **AUTO / HIGH / OFF / MISSING 네 숫자를 모두** 적는다.

```bash
REAL_SCAN_CAGI_PDF="<경로>" REAL_SCAN_SAT_PDF="<경로>" REAL_SCAN_PAGES=2 npx vitest run tests/real-scan-measure.test.ts
```

- (a) 선택한 방향과 이유
- (b) 파일별 변경 내용
- (c) **수정 전/후 AUTO 숫자** — 기준선은 `AUTO 34/46`
- (d) `npm test` / `npm run build` 결과
- (e) 자동 확정 임계값을 건드리지 않았다는 확인

**AUTO가 오르지 않으면 가설 기각이며 브랜치는 병합하지 않고 삭제한다.** 실패도 유효한 결과이므로 숫자를 그대로 보고할 것.

---

## 6-2. 작업지시서 — 원인 C2 (코덱스, 루나-최대)

### 목표

마킹 판별을 고쳐 `CORRECT 34 → 36`, `WRONG 0` 유지. 대상은 만족도 p2 문항 7·8(좌표는 정상인데 값이 비어 있음).

### 가장 중요한 사실 — 새 메커니즘을 만들지 마라

**요청받은 방식("인쇄된 박스 테두리를 배경으로 빼고 그 위의 추가 잉크만 센다")은 이미 구현되어 있다.**

- [`templateBaseline.ts`](../src/lib/recognition/templateBaseline.ts)가 커밋된 빈 양식을 런타임에 한 번 로드한다.
- [`markDensity.ts:671`](../src/lib/recognition/markDensity.ts)이 실제로 그 뺄셈을 한다:
  ```ts
  difference += Math.max(0, actualInk - baselineInk - 0.08);
  ```
- 엔진은 [`markDensity.ts:560`](../src/lib/recognition/markDensity.ts)에서 켜진다:
  ```ts
  const usesBaseline = baseline?.candidatePixelOverrides.length === group.candidates.length;
  ```

**따라서 이 작업은 "왜 이미 있는 뺄셈이 효과를 내지 못하는가"를 규명하는 것이다.** 병렬로 두 번째 판별 방식을 추가하지 마라 — 그러면 어느 쪽이 판정했는지 알 수 없게 되고, 지금까지의 실패 패턴을 반복하게 된다.

### 조사 순서 (이 순서대로 확인하고 결과를 기록할 것)

1. **베이스라인이 실제로 켜지는가.** 대상 필드에서 `usesBaseline`이 `true`인지 직접 확인한다. `candidatePixelOverrides`의 길이가 후보 수와 다르면 조용히 꺼지고 원시 밀도로 되돌아간다.
2. **켜진다면 정렬이 맞는가.** 뺄셈은 실제 스캔의 셀과 빈 양식의 셀이 같은 곳을 가리킬 때만 의미가 있다. 스캔 셀이 몇 픽셀만 어긋나도 인쇄된 박스 테두리가 "새 잉크"로 잡힌다.
3. **정렬이 맞다면 임계값 문제인가.** 상수 `0.08`과 이후 점수화가 얇은 체크 표시를 삼키는지 확인한다.

### 결정적 증거 (이미 확보됨)

원인 A 브랜치에서 게이트를 열었을 때, p1 성별의 채점 셀 두 개를 그대로 잘라본 결과:

- `남` 칸: **빈 체크박스가 온전히** 프레임 안에 들어옴 → 테두리 픽셀이 그대로 점수가 됨
- `여` 칸: **박스가 잘린 채 체크 표시만** 걸쳐 있음 → 실제 정답인데 점수가 낮음

즉 판별기가 **인쇄된 박스 테두리를 세고 있다.** 베이스라인 뺄셈이 제대로 작동했다면 두 칸 모두 테두리가 상쇄되고 체크 표시만 남았어야 한다.

참고로 CAGI·만족도의 원 표시 문항은 정확하게 읽힌다 — 원을 그리는 방식은 잉크량이 인쇄 보기를 압도하기 때문이다. **결함은 잉크량이 적은 작은 체크박스에서만 드러난다.**

### 제약 (위반 시 되돌림)

1. **`WRONG`을 늘리지 마라.** 이것이 유일한 절대 조건이다. `CORRECT`가 오르지 않는 것은 기각으로 끝나지만, `WRONG`이 오르는 것은 회귀다. 빈칸은 검수자의 키 입력 한 번이고, 오답은 사람이 확인한 것처럼 중앙 시스템에 저장된다.
2. **원인 C2 외의 것을 건드리지 마라.** 등록 등급(원인 A), 연령대 OCR(B), 격자 폴백(C1)은 각각 별도 브랜치다. 특히 `exp/cause-a-basic-registration`의 변경을 가져오지 마라 — C2 단독 효과를 측정해야 한다.
3. **`tests/real-scan-measure.test.ts`와 `local-scans/`를 수정하지 마라.** 계측기와 정답표를 고쳐 숫자를 맞추는 것은 금지다.
4. `npm test`·`npm run build` 통과, `templates/` 무변경, 미커밋 잔여 없음.
5. 브랜치는 `main`에서 분기한 `exp/cause-c2-mark-evidence` 하나만 쓴다. 버전 마커는 배포 테스트 시에만 갱신한다.

### 보고에 반드시 포함할 것

```bash
REAL_SCAN_CAGI_PDF="<경로>" REAL_SCAN_SAT_PDF="<경로>" REAL_SCAN_PAGES=2 npx vitest run tests/real-scan-measure.test.ts
```

- (a) 조사 순서 1~3의 각 결과 — 특히 `usesBaseline`이 대상 필드에서 참이었는지
- (b) 파일별 변경 내용
- (c) 수정 전/후 **CORRECT / WRONG / BLANK** (기준선 `CORRECT 34/46, WRONG 0`)
- (d) `npm test` / `npm run build` 결과
- (e) 병렬 판별 경로를 추가하지 않았다는 확인

`CORRECT`가 오르지 않아도 (a)의 규명 자체가 성과다. 숫자를 그대로 보고하라.

---

## 7. 사이클 기록

### 사이클 2 — 판정 지표 교체: AUTO → CORRECT (2026-08-13, 클로드 코드)

**작업 내용**
- 실제 양식 이미지를 직접 판독해 두 페이지 46개 항목의 정답표를 작성하고 `local-scans/answer-key.json`(gitignore)에 저장했다. 스캔뿐 아니라 **정답값도 학생 응답이므로 커밋하지 않는다.**
- `tests/real-scan-measure.test.ts`를 `CORRECT / WRONG / BLANK` 기준으로 교체하고, **`WRONG > 0`이면 테스트가 실패하도록** 단언을 추가했다.

**테스트 결과**

| 브랜치 | CORRECT | WRONG | 판정 |
|---|---|---|---|
| `main` | 34/46 | **0** | 통과 |
| `exp/cause-a-basic-registration` | 34/46 | **4** | 실패 |

**두 브랜치의 CORRECT가 동일하다.** 원인 A 브랜치는 맞은 값을 하나도 늘리지 못한 채 오답만 4개 추가했다. 이전 지표(`AUTO`)로는 "+4 개선"으로 보였던 변경이다.

**다음 작업 피드백**
- 현재 배포본은 "덜 채우지만 틀리지는 않는" 상태이며, 이것이 지켜야 할 성질이다. 개선의 정의는 **BLANK → CORRECT**이지 BLANK → 채워짐이 아니다.
- 계측기가 판정 기준인 이상, 실험 브랜치에서 계측기와 정답표 수정을 금지 조항으로 명시했다.

### 사이클 1 — 원인 A 수정 시도 → 병합 보류 (2026-08-13, 코덱스 + 클로드 코드 검증)

**작업 내용 (코덱스, `ca21987`)**
- 방향 2 선택: `RegistrationStatus`에 `row-verified`를 추가하고, `isVerifiedGrid` 대신 `isAutoValueAllowed()`가 기존 검증 격자와 새 등급을 함께 통과시키도록 했다. 기본정보 표는 2차원 불규칙 구조라 세로선 검출(방향 1)보다 좁은 수정이라는 이유다.
- `markDensity.ts`, 임계값, `requiresHighVisualConfidence`는 변경하지 않았다. 회귀 가드는 약화가 아니라 **강화**됐다(`fixed` 허용 → `row` + `row-verified` 등록 상태 요구).

**검증 결과 (클로드 코드 독립 측정)**
- 게이트는 의도대로 열렸다: 기본정보가 `src=row`, `status=row-verified`로 등록되고 자동 입력이 발생한다.
- **그러나 새로 채워진 4개 값이 전부 틀렸고 전부 `높음`이다.**

| | 정답 | 브랜치 출력 |
|---|---|---|
| p1 성별 | 여 | **남** |
| p2 성별 | 여 | **남** |
| p2 학교유형 | 중학교 | **고등학교** |
| p2 학년 | 2학년 | **3학년** |

- **메커니즘**: 채점 셀을 그대로 잘라 확인한 결과, `남` 칸은 빈 체크박스가 온전히 들어와 있고 `여` 칸은 박스가 잘린 채 체크 표시만 걸쳐 있었다. 판별기가 **인쇄된 체크박스 테두리를 세고 있다.**
- **기존 34개는 정답이다**: CAGI·만족도의 원 표시 문항은 잉크량이 인쇄 보기를 압도해 정확히 읽힌다. 결함은 잉크량이 적은 작은 체크박스에 국한된다.

**판정 및 다음 작업 피드백**
- 원인 A의 진단(등급 부여 경로 부재)과 수정 자체는 옳다. 그러나 게이트를 열면 **원인 C2가 즉시 오답을 만들어낸다.** 지금까지의 하드코딩 차단은 의도치 않게 사용자를 이 오답으로부터 보호하고 있었다 — 수동 입력의 불편이 유일한 방어선이었다.
- **브랜치는 삭제하지 않고 보존한다**(기각이 아니라 선행 조건 미충족). **C2를 A의 선행 조건으로 승격**하고, C2 해결 후 A를 재측정해 함께 병합한다.
- 이 사이클에서 계측기 결함이 드러났다 → 사이클 2.

### 사이클 0 — 계측기 구축 및 기준선 확정 (2026-08-13, 클로드 코드)

**작업 내용**
- `tests/real-scan-measure.test.ts` 신설. 실제 PDF를 pdf.js(Node canvas factory)로 렌더 → `recognizeStudentForms` 실행 → AUTO/HIGH/OFF/MISSING 출력. 실제 스캔은 환경변수 경로로만 받고 저장소에 넣지 않는다.
- 코덱스가 남긴 미커밋 변경(`detectCheckmarks.ts` +56/−22)과 잔여 스크립트 `chk-tmp.ts` 폐기(스크래치패드에 백업). 이 미커밋 변경이 로컬에서 4개 테스트를 깨뜨리고 22개 필드를 전부 `missing`으로 만들던 원인이었다. **배포본에는 들어간 적이 없다.**

**테스트 결과**
- 깨끗한 배포 커밋 `34538ce`: `npm test` **101/101 통과**.
- 실제 스캔 기준선: **AUTO 34/46, HIGH 34/46, OFF 6, MISSING 1**.
- 미충족 12개가 원인 A(6) / B(2) / C1(2) / C2(2)로 정확히 분해됨 → **단일 원인이 아님이 숫자로 확정.**

**다음 작업 피드백**
- 원인 A는 코드 경로 추적으로 확정됐고 전체 누락의 절반이다. 먼저 착수한다.
- C1과 C2는 같은 페이지의 만족도 항목이지만 **성격이 다르다** — C1은 좌표, C2는 마킹 근거. 한 브랜치에서 함께 고치면 판정이 불가능하므로 반드시 분리한다.
- 기울기(skew) 가설은 이 자료에서 기각됐다. 다만 합성 회전 0.3°에서 검출이 깨지는 취약성 자체는 실재하므로, 다른 스캐너/모바일 촬영 자료가 확보되면 별도 스레드로 재검토한다.
