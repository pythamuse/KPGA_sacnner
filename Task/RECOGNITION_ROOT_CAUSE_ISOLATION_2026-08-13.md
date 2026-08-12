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
| **AUTO** | 자동으로 값이 채워진 항목 수 (23개/학생) ← **작업의 성패는 이 숫자로만 판정한다** |
| HIGH | `높음` 신뢰도 항목 수 |
| OFF | 검출 행 중심이 실측 템플릿과 0.01 초과로 벌어진 항목 수 |
| MISSING | 격자/행 검출이 아예 실패한 항목 수 |

**실제 스캔은 학생 응답과 연락처 흔적을 포함하므로 저장소에 절대 커밋하지 않는다.** 경로는 환경변수로 주입하며, 변수가 없으면 스킵되어 `npm test`는 그대로 통과한다.

```bash
REAL_SCAN_CAGI_PDF="C:/Users/night/Desktop/선별검사 샘플1.pdf" REAL_SCAN_SAT_PDF="C:/Users/night/Desktop/만족도조사1.pdf" REAL_SCAN_PAGES=2 npx vitest run tests/real-scan-measure.test.ts
```

---

## 3. 기준선 (main, `34538ce` / v2026-08-12.1, 2026-08-13 측정)

```
AUTO 34/46   HIGH 34/46   OFF 6   MISSING 1
  page 1: AUTO 19/23  (blank: age, gender, schoolType, grade)
  page 2: AUTO 15/23  (blank: age, gender, schoolType, grade, sat.q01, q03, q07, q08)
```

**모든 후속 실험은 이 숫자와 비교한다.** AUTO가 오르지 않으면 그 가설은 기각이다.

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

| 브랜치 | 원인 | 기대 결과 |
|---|---|---|
| `exp/cause-a-basic-registration` | A | AUTO 34 → **40** |
| `exp/cause-b-age-ocr` | B | AUTO 34 → **36** |
| `exp/cause-c1-grid-fallback` | C1 | AUTO 34 → **36** |
| `exp/cause-c2-mark-evidence` | C2 | AUTO 34 → **36** |

**각 브랜치는 `main`에서 분기하고 원인 하나만 건드린다.** 두 원인을 한 브랜치에서 고치면 어느 쪽이 효과를 냈는지 판정할 수 없으므로 금지한다. 규칙 전문은 [README의 "원인 격리 실험 브랜치 규칙"](../README.md#원인-격리-실험-브랜치-규칙).

A → B → C1 → C2 순으로 진행한다(A가 전체 누락의 절반이고 원인이 확정적이므로).

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

## 7. 사이클 기록

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
