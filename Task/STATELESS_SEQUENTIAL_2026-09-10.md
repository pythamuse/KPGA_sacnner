# 순차·촬영 경로 무상태화 — Blob 의존 제거 (2026-09-10)

사용자 배경: 버셀 부하의 주범이 advanced Blob 작업이었고, 그 수치를 확보하려 새 계정으로 옮기는 안을 검토했다.
계정 회전은 약관의 다중 계정 우회에 해당할 수 있고 소유권 이전을 사후 명분으로 붙이는 것도 사실과 달라 방어가 되지 않는다고 판단했다.
그래서 **한도 문제 자체를 없애는 쪽**을 택했다 — Blob을 쓰지 않으면 한도도, 계정 이동도, 소명도 필요 없다.

## 1. 계측 — advanced 작업이 나오는 자리는 한 곳뿐이다

| 경로 | 학생당 Blob 쓰기 | 근거 |
|---|---|---|
| 일괄 스캔 업로드 (기본값) | **0** | 2026-09-03 무상태 전환. 페이지를 메모리에 들고 학생별로 `/api/recognize/student` 호출 ([STATELESS_RECOGNITION_PLAN_2026-09-03.md](STATELESS_RECOGNITION_PLAN_2026-09-03.md)) |
| 순차 파일 업로드 | 2 | `uploadSequentialFile` → `/api/upload` → `storeUploadPage` 장당 1회 |
| 카메라 촬영 | 4 | 위 + 촬영 메타 `storeUploadPageMeta` 장당 1회 |

즉 남은 발생원은 개별·순차 촬영 모드 하나다. 일괄 경로는 이미 0이다.

## 2. 바꾸는 것 셋

- **A. 두 장을 메모리에 보관.** `uploadSequentialFile`이 플래그를 보고 업로드 대신 `statelessPagesRef`에 넣는다.
  부품이 전부 있다: `StatelessPage`, `holdPreparedBatchInMemory`(일괄 경로의 같은 일), `statelessBatchPages()`,
  그리고 한 명짜리 묶음도 그대로 처리하는 `runStatelessRecognition`. `page.tsx`는 손대지 않는다 —
  이미 `statelessPages`가 오면 무상태 분기로 간다.
- **B. 이미지 식별자 충돌(함정).** 무상태 경로는 식별자를 `cagi_page_${studentIndex}`로 만든다.
  순차 모드는 학생을 한 명씩 처리하므로 번호가 매번 0이 되어 **모든 학생이 같은 식별자**를 갖는다.
  `page.tsx`의 `savedRowForDraft`(L585-590)가 그 식별자로 초안과 저장된 학생을 짝지으므로,
  그대로 두면 검수 화면이 조용히 항상 첫 번째 학생을 가리킨다. 지금은 서버가 매 업로드마다 새 묶음 아이디로
  고유값을 주기 때문에 문제가 없다. 순차 모드에서 세션 안 고유성을 보장하도록 고친다.
- **C. 품질 판정을 Blob 없이.** `/api/uploads/quality`가 Blob에서 이미지를 다시 읽는다.
  순차 모드의 핵심이 **종이가 손에 있을 때** 재촬영을 요구하는 것이라 일괄 경로처럼 뒤로 미룰 수 없다.
  학생별 인식 라우트가 이미 쓰는 방식(요청 본문 + 요청 단위 임시 디렉터리 + `finally` 삭제)을 그대로 쓴다.
  기존 JSON+Blob 경로는 플래그 오프용으로 남긴다.

**D. Blob 코드는 지우지 않는다.** `uploadStore.ts`·`/api/upload`·`/api/recognize`·`/api/jobs/cleanup` 다섯 파일 1,017줄은
`NEXT_PUBLIC_STATELESS_RECOGNIZE=0` 예비 경로로 남는다. 실행 중에 불리지 않으므로 작업 수는 0이 된다.
삭제는 두 경로 모두 실사용 이력이 쌓인 뒤 별도 결정.

## 3. 위임

난이도 **쉬움** — 판단이 필요한 부분(품질 판정을 미루지 않는다, 식별자 고유성 보장)은 주문서에서 이미 정했고
참조 구현이 바로 옆에 있다. [FEATURE_PLAN_2026-09-09.md](FEATURE_PLAN_2026-09-09.md) §1 기준으로 코덱스에 맡긴다.
워크트리 `.claude/worktrees/codex-w4-stateless-sequential`, 주문서는 스크래치패드 `orders/w4-stateless-sequential.md`.

## 4. 합격 판정 (메인 에이전트가 dev 브라우저에서)

1. ~~`BLOB_OPS_TRACE`를 켠 dev 서버에서 `put` 로그 0줄~~ → **쓸 수 없다.** dev는 `usesLocalMemoryStore()`가 참이라
   `storeUploadPage`가 로컬 분기로 빠져 `traceBlobOp`에 도달하지 않는다. 대신 **서버 라우트 로그에 `POST /api/upload`가 없을 것**으로 바꾼다 —
   페이지를 쓰는 라우트가 그것 하나뿐이므로 같은 것을 증명한다.
2. 첫 장을 올린 직후 시트 품질 배지가 예전처럼 뜬다.
3. 학생 두 명을 연속으로 인식했을 때 두 초안의 `source.cagiImageId`·`satisfactionImageId`가 서로 다르다(B의 함정).
   저장까지 거치지 않고 식별자 자체를 본다 — `savedRowForDraft`가 짝짓는 근거가 그 값이기 때문이다.
4. 단위 스위트 596개 유지.

## 5. 결과 — 병합 (같은 날)

코덱스 1회 왕복, 208k 토큰. 6파일 165줄 추가·14줄 삭제.

| 항목 | 구현 |
|---|---|
| A | `uploadSequentialFile`이 플래그 on이면 `shrinkImageFileIfNeeded` 후 `statelessPagesRef`에 한 장짜리 배열로 넣고, `statelessBatchPages()`의 `mode !== 'batch'` 가드를 풀어 트리거에 넘긴다 |
| B | `buildSequentialImageIds(batchId)`·`withSequentialImageIds(draft, ids)`를 `statelessSession.ts`에 두고, `page.tsx`가 **순차 모드에서만** 초안의 식별자를 덮어쓴다. 배치 식별자는 그대로 |
| C | `/api/uploads/quality`에 multipart 분기 추가. 이미지·양식·촬영 메타를 본문으로 받아 요청 단위 임시 디렉터리에 쓰고 판정 후 `finally`에서 삭제. 기존 JSON+Blob 경로는 플래그 오프용으로 유지 |
| D | Blob 코드 다섯 파일 1,017줄 그대로 |

**dev 브라우저 판정 (세트 1 원본 사진, 학생 2명 연속, 순차 파일 업로드 경로).** 서버 라우트 로그가 전부다:

```
POST /api/jobs                200
POST /api/uploads/quality     200   (학생1 앞면)
POST /api/uploads/quality     200   (학생1 뒷면)
POST /api/recognize/student   200
POST /api/uploads/quality     200   (학생2 앞면)
POST /api/uploads/quality     200   (학생2 뒷면)
POST /api/recognize/student   200
```

- **`/api/upload` 호출 0.** 페이지를 쓰는 라우트는 이것 하나뿐이므로 배포본에서 advanced 작업이 0이 된다는 뜻이다.
  (dev는 `usesLocalMemoryStore()`가 참이라 `BLOB_OPS_TRACE`가 애초에 발화하지 않는다. 그래서 라우트 호출 여부가 유일하게 유효한 증거다.)
- `/api/recognize`(Blob 배치 경로) 호출도 0. 무상태 경로로 갔다.
- 촬영 상태 판정이 **장마다 예전처럼** 떴다(검수 화면 "선별검사지 정상 · 만족도조사 정상").
- 식별자 충돌 해소 확인. 학생 1 `cagi_page_9fa1dfae…`·`satisfaction_page_1489fa83…`, 학생 2 `cagi_page_79e378bb…`·`satisfaction_page_f66935c8…`.
  고치기 전이었다면 둘 다 `cagi_page_0`이었다.
- 단위 스위트 **598 통과**(변경 전 596 + 신규 2), `tsc` 오류 0.

**남은 사실.** 카메라 촬영 경로는 같은 `uploadSequentialFile` 하나를 지나가므로 코드상 동일하게 무상태다.
다만 실기기 카메라로는 확인하지 못했다 — dev에서 판정한 것은 파일 업로드 경로다.

**이 라운드로 닫히는 것**: 버셀 Blob 한도를 이유로 한 계정 이동 검토. 실행 중 Blob 작업이 0이므로 한도 문제 자체가 없어졌다.

## 6. 값 대조 검증 (같은 날, 사용자 지적으로 추가)

§5는 배관만 쟀다 — 라우트 호출과 식별자다. 이 프로젝트의 판정 기준(CLAUDE.md §5.4)은 **인식값**이므로 그것을 따로 쟀다.

**방법.** 같은 학생 한 명(세트 1 원본 사진 `cagi-p1`+`sat-p1`)을 순차 경로로 두 번 인식시켰다.
A는 현재 기본값(무상태), B는 `.env.local`에 `NEXT_PUBLIC_STATELESS_RECOGNIZE=0`을 넣고 dev 서버를 재시작한 옛 Blob 경로다.
검수 세션 스냅샷에서 `{basic, cagi, satisfaction}` 값과 `recognitionValueSource`를 평탄화해 비교했다.

| | A 무상태 | B 옛 Blob 경로 |
|---|---|---|
| 자동 입력 칸 | 12 | 12 |
| 값 | `age 14`·`schoolType 중학교`·`grade 1학년`·`cagi.q01~q09 = 0` | **동일** |
| 출처 맵 | 자동 12 · 미해결 11(성별·만족도 10문항) | **동일** |
| 검수 화면 요약 | 확인 필요 23 · 경합 4 · 낮은 신뢰도 12 | **동일** |

**칸 단위 차이 0.** 무상태 전환이 인식값을 바꾸지 않는다.

**부수 확인 — 플래그 오프 예비 경로가 실제로 산다.** B의 서버 로그가 `POST /api/upload` ×2 → `POST /api/recognize`로,
옛 경로 그대로 돌았다. 남겨 둔 Blob 코드가 죽은 코드가 아니라는 것을 이 라운드에서 처음 확인했다.

## 7. 이 라운드가 드러낸 기존 결함 (B-25 후보, 별도 검증 필요)

B에서 초안의 식별자가 `cagi_page_0001`로 나왔다. 옛 순차 경로는 페이지 번호가 항상 1이므로 **모든 학생이 이 값을 갖는다.**
[page.tsx](../src/app/page.tsx)의 `savedRowForDraft`(L593)가 이 값으로 초안과 저장된 학생을 짝짓고,
`handleSaveStudent`(L520)는 짝이 잡히면 그 행을 **덮어쓴다**. 따라서 옛 순차 모드에서 학생 2를 저장하면 학생 1을 덮어썼을 것으로 보인다.

**측정한 것**: 옛 경로의 식별자가 학생과 무관하게 `cagi_page_0001`이라는 것, 새 경로는 학생마다 다르다는 것(§5).
**측정하지 못한 것**: 덮어쓰기 자체. 이 사진은 만족도 10문항이 전부 미해결이라 유효성 검사에서 저장이 400으로 막힌다
(두 경로 모두 동일, 이 변경과 무관). 두 학생을 끝까지 저장하려면 값이 온전히 인식되는 표본이 필요하다.

즉 §7은 **코드 근거 + 식별자 측정**이지 재현이 아니다. 이 변경이 전제(식별자 충돌)를 없애므로 지금 코드에서는 발생하지 않지만,
결함 자체는 별도 라운드에서 재현·기록해야 한다. 스캔 일괄 모드는 학생마다 페이지 번호가 달라 영향이 없다.
