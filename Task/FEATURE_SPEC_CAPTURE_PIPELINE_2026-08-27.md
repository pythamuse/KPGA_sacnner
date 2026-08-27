# 촬영 파이프라인 기능 정의 — F1 오류 보정 · F2 재촬영 요구 · F3 메타 해석

작성 2026-08-27. 근거 측정은 [EXTERNAL_ADOPTION_PLAN_2026-08-27.md](EXTERNAL_ADOPTION_PLAN_2026-08-27.md)
§2~3, UX 설계는 [CAPTURE_GUIDANCE_2026-08-27.md](CAPTURE_GUIDANCE_2026-08-27.md).
**이 문서는 구현 전 기능 정의다.** 구현 트랙과 병렬 계획은 §5.

전체 흐름:

```
촬영/파일 선택
  → F1: 오류 보정 (쿼드 + ORB 이중 경로, 원본 해상도 워프, 자체 검증)
  → 보정 성공  → 업로드 + F3 메타 해석 → 판정 good/retake/unusable
  → 보정 실패  → F2: 재촬영 요구 (이유별 문구, 명시적 강행만 허용)
```

---

## F1 — 촬영 오류 보정 (이중 경로 정합 + 원본 해상도 워프)

### F1.1 무엇이 문제인가 (측정 근거)

| 사실 | 출처 |
|---|---|
| 쿼드 검출은 38장 중 26장만 정합 | ADOPTION §1 |
| ORB 정합은 38/38, 쿼드 실패 12장 전부 포함 | ADOPTION §3.2~3.3 |
| 다운스케일에서 워프하면 오답이 생긴다 (스파이크 p2에 오답 3개) | ADOPTION §3.3 |
| "보정 성공"이 실패일 수 있다 — p14 한 모서리 192px 어긋남, p10 종횡비 1.725 통과 | ADOPTION §3.1 |

### F1.2 정의

워커의 `correct` 처리를 다음으로 교체한다.

1. **입력이 원본 해상도가 된다.** 클라이언트는 EXIF 정방향화된 **원본 크기** ImageData를
   transferable buffer로 워커에 보낸다(현재는 1600px 축소본을 보낸다). 축소는 워커 안에서
   한다 — 검출은 지금처럼 긴 변 1600에서, **워프의 화소 샘플링만 원본에서**.
2. **검출은 이중 경로다.**
   - 경로 1(기존): `detectDocumentQuadFromMat` — 쿼드 검출.
   - 경로 2(신규): **ORB 정합** — 빌드 시 생성해 커밋한 blank 템플릿 ORB 특징(JSON,
     양식별 1개)과 사진의 ORB 3000점을 BFMatcher(NORM_HAMMING) knn=2, Lowe 0.75로
     대응시키고 `findHomography(RANSAC, 4.0)`.
3. **ORB는 항상 돈다** (검출 크기에서 ~150ms). 역할이 둘이다:
   - **폴백**: 쿼드가 거절될 때 H_orb로 워프.
   - **검증자**: 쿼드가 성공해도, ORB 인라이어 쌍을 쿼드-H로 옮겨 본 잔차(중앙값 px)를
     잰다. 잔차가 문턱을 넘고 H_orb가 유효하면 **H_orb로 교체**한다. p14(한 모서리
     192px)·p10(늘어난 워프)이 잡히는 지점이 여기다.
4. **워프는 항상 원본 해상도에서 샘플한다.** H는 검출 크기에서 추정하고 스케일 행렬로
   합성해(`H_full = H_det ∘ diag(1/sx, 1/sy, 1)`) 원본 → 1422×1968(cagi 기준
   `baseSize × PERSPECTIVE_CORRECTION_SCALE`)로 워프한다.
5. **결과 메타가 생긴다.** 성공/실패 모두 다음을 응답에 싣는다(F2·F3의 입력):

```ts
interface RegistrationMeta {
  method: 'quad' | 'orb' | 'none';
  confidence: number;            // 쿼드 신뢰도 (orb 단독이면 0)
  orbInliers: number;
  orbInlierRatio: number;        // inliers / good matches
  quadResidualPx: number | null; // ORB 대응쌍 기준 쿼드-H 잔차 중앙값 (검출 크기 px)
  rejection: QuadRejection | null;
  verified: boolean;             // 채택된 H가 검증 문턱을 통과했는가
}
```

### F1.3 상수와 출처 (전부 잠정 — T3/T5에서 보정)

| 상수 | 초안 | 출처 |
|---|---|---|
| `ORB_MIN_INLIERS = 50` | 성공 사례 최소 60(sat-p14), 나쁜 워프 36(p10) 사이 | ADOPTION §3.2~3.3 |
| `ORB_MIN_RATIO = 0.55` | 성공 최저 0.62(sat-p6), 나쁜 워프 0.49 사이 | 〃 |
| `QUAD_RESIDUAL_MAX_PX = 20` (검출 1600 기준) | 정상 잔차 5~10px대, p14는 130px대 환산 | ADOPTION §3.1 |

상수 옆에는 이 표의 출처를 주석으로 남긴다. **문턱 완화로 이득을 만들지 않는다** — 문턱은
검증 실패를 더 잡는 방향으로만 조인다(CLAUDE.md §5.4).

### F1.4 수용 기준

- [ ] 19명 전수(중앙 측정, 통합 후): **`WRONG` ≤ 쿼드 경로의 7.** 넘으면 §5.4 기각.
- [ ] 정합 수 ≥ 26/38 (기존 쿼드 경로 이상).
- [ ] 스캔(PDF) 경로 무변경 — `shouldCorrectBatchPerspective`가 이미 막고 있음을 테스트로 고정.
- [ ] 기존 `evaluateQuad` 회귀 테스트 8건 통과 유지.
- [ ] 워커 왕복(원본 12MP 기준) < 3초 — 배치 페이지당 타임아웃(3s)과의 정합.
- [ ] 템플릿 특징 JSON은 생성 스크립트와 함께 커밋(재생성 가능해야 함).

### F1.5 범위 밖

- 라이브 프리뷰 오버레이(CAPTURE_GUIDANCE §4~5의 실시간 유도)는 **이번 범위가 아니다** —
  촬영 *후* 판정까지가 F1~F3. 라이브는 다음 단계.
- `findTransformECC` 미세 정합 — Stage B 측정에서 필요가 증명될 때만.

---

## F2 — 재촬영 요구 (촬영 상태 확인 로직 포함)

### F2.1 무엇이 문제인가

지금은 보정이 실패하면 **조용히 원본을 올린다.** 그 경로에서 오답이 나온다는 것이 측정돼
있다(5명 세트의 유일한 오답이 보정 실패 장에서 나옴; 19명 원본 세트 오답 11건 전부 미정합
장). 사용자는 실패를 알 수 없고, 검수자는 오답 위험이 큰 장을 구분 없이 받는다.

### F2.2 정의 — 촬영 상태 확인 로직

**판정 입력**은 F1의 `RegistrationMeta`다. 새 알고리즘이 아니라 F1 부산물의 해석이다.

| 상태 | 조건 | 동작 |
|---|---|---|
| **정상** | `method ≠ 'none'` 그리고 `verified` | 보정본 업로드 진행 |
| **보정 불가** | `method = 'none'` | **업로드 중단 + 재촬영 요구.** 이유별 문구(아래) |
| **보정 의심** | `method ≠ 'none'`이지만 `verified = false` | 재촬영 권고 배너 + 진행 허용(메타에 기록) |

이유별 문구 (`rejection` → 사용자 행동, CAPTURE_GUIDANCE §3의 표를 그대로 구현):

| `rejection` / 상태 | 문구 |
|---|---|
| `null` (종이 자체를 못 찾음) | "종이가 배경과 구분되도록 어두운 바닥을 피해 다시 찍어주세요" |
| `cropped` | "종이의 네 모서리가 모두 화면 안에 들어오게 찍어주세요" |
| `too-small` | "종이가 화면을 더 채우도록 가까이서 찍어주세요" |
| `wrong-shape` | "종이 정면에서, 세로 방향으로 찍어주세요" |
| verified=false | "촬영 상태가 좋지 않아 인식 정확도가 낮을 수 있습니다. 다시 찍는 것을 권장합니다" |

### F2.3 강행(override) 정책

- 재촬영 요구 화면에는 **"그대로 사용(정확도 낮음)"** 버튼을 둔다. 완전 차단은 검출기 오탐
  때 사용자를 가두므로 두지 않는다. 단:
  - 강행 시 `RegistrationMeta.method='none'` 그대로 업로드되고, F3 판정에 `overridden:
    true`가 남아 검수 화면에서 구분 가능해야 한다.
  - 강행은 **명시적 클릭**으로만 — 기본 흐름은 재촬영이다. 지금의 "조용한 폴백" 코드는
    제거한다.
- 일괄(batch) 경로: 페이지별 판정을 모아 업로드 전 요약("19장 중 3장 보정 실패: p7, p12,
  p18 — 다시 스캔/촬영 권장")을 보여주고, 동일한 명시적 강행을 요구한다.

### F2.4 수용 기준

- [ ] 조용한 폴백 코드 경로 제거(순차·카메라·일괄 셋 다).
- [ ] 보정 불가 사진 → 재촬영 UI + 이유 문구 표시 (컴포넌트 테스트).
- [ ] 강행 시 메타에 `overridden` 기록, 업로드는 성공.
- [ ] 재촬영 선택 시 같은 단계로 되돌아가 파일 선택/촬영 재시도 가능.

---

## F3 — 샘플 데이터 메타 해석 (장당 인식 가능성 판정)

### F3.1 무엇이 문제인가

정합 성공은 충분조건이 아니다 — 불량 묶음(p6~p15)은 잘 정합돼도 0칸이다(ADOPTION §3.3).
격자 필드 수(1~11)와 `pageInkRatio`(0.35~0.61)가 성패와 같이 움직이지만, 이 신호는 서버
(`sharp` 경로)에만 있고 **장당으로 물어볼 방법이 없다** — `/api/recognize`는 양면이 모인
뒤에야 돈다.

### F3.2 정의

**신규 모듈** `src/lib/recognition/sheetQuality.ts`:

```ts
interface SheetQualityInput {
  imagePath: string;
  formType: 'cagi' | 'satisfaction';
  registration?: RegistrationMeta;   // F1이 클라이언트에서 보낸 값 (선택)
}
interface SheetQualityVerdict {
  verdict: 'good' | 'retake-suggested' | 'unusable';
  signals: {
    width: number; height: number;
    pageInkRatio: number; pageIsBinarySource: boolean;
    gridFields: number;              // buildGridDetection 필드 수 (0~13)
    contentBoundsSource: string; contentBoundsConfident: boolean;
    registration: RegistrationMeta | null;
  };
  reasons: string[];                 // 판정 근거 (기계 판독용 코드)
  hints: string[];                   // 사용자 문구 (F2 문구 표와 일관)
}
```

해석 규칙 — **T3 측정(아래 §F3.4)이 초안 밴드를 기각했다. 확정 규칙은 다음이다:**

| verdict | 조건 (정합 메타만 사용) |
|---|---|
| `unusable` | `registration.method = 'none'` |
| `retake-suggested` | `method ≠ 'none'`이지만 `verified = false` |
| `good` | `verified = true`, 또는 registration 메타가 없음(스캔·기존 업로드 — 스캔에 재촬영을 말해선 안 된다. reason `no-registration-meta`) |

`gridFields` / `pageInkRatio` 등 이미지 신호는 **signals로 보고만 하고 판정에 쓰지 않는다.**

### F3.4 T3 측정 — 초안 밴드 기각 근거 (2026-08-27)

19명을 "정답을 한 칸이라도 낸 학생"(7명: 1~5, 16, 17)과 못 낸 학생(12명)으로 갈라, 장당
신호의 최적 단일 절단 정확도를 섞은 라벨 대조군 500회의 p95와 비교했다.

| 신호 | 최적 절단 (19명 중) | 섞은 라벨 p95 | 판정 |
|---|---|---|---|
| gridFields | 14 | 14 | **우연 수준** |
| pageInkRatio | 16 | 15 | 경계선, 그리고 **방향이 반대** — 성공 학생의 ink가 더 높다(0.56~0.61) |
| orbInliers (cagi/sat) | 13 / 13 | 15 | 우연 이하 |
| 쿼드 confidence (cagi/sat) | 13 / 17 | 16 / 15 | 우연 수준 |

초안의 "ink > 0.55 → retake"는 **좋은 묶음을 걸러내는 규칙**이었다. 시트 수준 이미지
신호로는 이 표본에서 밴드를 자를 수 없다 — 성패를 가르는 것은 셀 수준 게이트 신호이며,
그것은 Stage A 계측(잔여 오답 기제)의 몫이다. 새 증거 없이 이 신호들에 문턱을 다시 달지
않는다.

**신규 엔드포인트** `POST /api/uploads/quality`
`{ jobId, type, imageId, registration? }` → `SheetQualityVerdict`.
업로드 직후 장당 호출 — 종이가 아직 눈앞에 있을 때 판정이 도착한다.

**일관성 요건**: `/api/recognize`도 **같은 `evaluateSheetQuality`를 호출**해 학생 draft에
장당 판정을 첨부한다. 두 경로가 다른 판정기를 쓰면 "괜찮다더니 왜"가 생긴다(노드와
브라우저가 다른 답을 낸 전례 — CLAUDE.md §5.1).

### F3.3 수용 기준

- [ ] 두 양식 모두에서 엔드포인트가 판정을 반환 (blank 자산 기반 테스트).
- [ ] recognize 경로가 같은 판정기를 호출해 draft에 첨부.
- [ ] 판정 밴드 상수에 T3 측정 출처 주석. **19명 라벨과 대조한 분리표 + 섞은 라벨
      대조군**(과적합 확인)이 문서에 남을 것.
- [ ] `WRONG = 0` 서열 준수: 판정은 **게이트를 완화하지 않는다** — 인식 값에는 손대지
      않고, 검수자에게 주는 신호만 만든다.

---

## §4 세 기능의 경계

```
F1은 이미지를 만든다      (더 잘 편 이미지 + RegistrationMeta)
F2는 사람을 움직인다      (RegistrationMeta 해석 → 재촬영/강행)
F3는 검수자를 준비시킨다  (서버 신호까지 합쳐 장당 판정)
```

F2는 F1의 메타만 읽고, F3는 F1의 메타 + 서버 신호를 읽는다. **어느 것도 인식 게이트의
문턱을 건드리지 않는다.**

---

## §5 실행 계획 — 병렬 트랙

### 5.1 트랙 분해

| 트랙 | 내용 | 파일 영역 | 실행 주체 | 병렬성 |
|---|---|---|---|---|
| **T1** | F1: 워커 이중 경로 + 원본 해상도 워프 + 템플릿 특징 생성 스크립트 | `src/lib/documentScanner/**`, `scripts/`, 신규 테스트 | 병렬 에이전트 A (워크트리 격리) | T2와 **동시** |
| **T2** | F3 서버부: `sheetQuality.ts` + `/api/uploads/quality` + recognize 첨부 | `src/lib/recognition/sheetQuality.ts`(신규), `src/app/api/uploads/quality/**`(신규), recognize route 소폭 | 병렬 에이전트 B (워크트리 격리) | T1과 **동시** |
| **T3** | 판정 밴드 측정: 19명 라벨(격자 수·인라이어·성패)로 절단면 탐색 + 섞은 라벨 대조군 | 스크래치패드만 | **Claude 직접** (정답표는 워크트리에 없음) | T1·T2와 **동시** |
| **T4** | F2: 패널 배선 — 재촬영 UI·강행·조용한 폴백 제거·quality 호출 | `ImageUploadPanel.tsx`, `page.tsx` | T1·T2 합류 후 (같은 파일 충돌 방지) | 직렬 |
| **T5** | 중앙 측정: 19명 전수 정확도, F1.4/F3.3 게이트 판정, 병합/기각 | — | **Claude 직접** | 최종 |

### 5.2 병렬이 안전한 이유

- T1과 T2는 **파일이 겹치지 않는다** (documentScanner ↔ recognition/api). 워크트리 격리로
  서로의 중간 상태도 보지 않는다.
- **워크트리에는 `local-scans/`가 없다**(§6 gitignore). 위임 트랙은 정답표에 접근할 수
  없으므로 **자체 합격 판정이 구조적으로 불가능**하다 — CLAUDE.md §1.3·§1.4의 안전 속성이
  Codex 위임과 동일하게 유지된다. 합격 판정은 T5에서 중앙(이 체크아웃)만 한다.
- T4를 직렬로 두는 이유: `ImageUploadPanel.tsx`는 T1의 워커 API 형태에 의존하고, 두
  에이전트가 같은 파일을 만지면 병합 비용이 병렬 이득을 먹는다.

### 5.3 트랙별 완료 조건 (에이전트에게 주는 계약)

- 공통: `npx tsc --noEmit` 클린, 자기 트랙의 신규 테스트 + 기존 관련 테스트 통과, 브랜치에
  커밋. **실제 스캔·사진·정답표 접근 금지**(어차피 없음), 자체 정확도 주장 금지.
- T1: 합성 픽스처(커밋된 blank 자산을 기하 변환한 것)로 워프·게이트·메타 단위 테스트.
  기존 perspective-correct 테스트 8건 무수정 통과.
- T2: blank 자산 기반으로 두 양식 판정 반환 테스트. verdict 밴드는 잠정 상수 + `PROVISIONAL`
  주석(T3가 확정).

### 5.4 합류 후 게이트 (T5, 중앙)

1. 병합 → `tsc` + 전체 회귀(53+) →
2. 19명 전수(Node 프로브) → **`WRONG` ≤ 7 아니면 F1 기각·되돌림** (발견은 문서에) →
3. T3 밴드를 F3 상수에 반영 →
4. 브라우저 확인(§5.2 절차) → 커밋.

---

## §6 이 문서가 정의하지 않는 것

- 라이브 촬영 오버레이(실시간 테두리·기울기 경고) — CAPTURE_GUIDANCE §4~5의 다음 단계.
- 잔여 오답 7건의 기제 — Stage A 계측은 별도로 진행하며, 그 결과가 F1.3 상수를 다듬는다.
- 판정 밴드의 최종 숫자 — T3 측정 전에는 전부 잠정.
