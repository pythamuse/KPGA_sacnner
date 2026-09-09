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

1. `BLOB_OPS_TRACE`를 켠 dev 서버에서 순차·촬영 흐름을 한 학생 돌린다 → **`put` 로그 0줄**.
2. 첫 장을 올린 직후 시트 품질 배지가 예전처럼 뜬다.
3. 학생 두 명을 연속으로 인식·저장한 뒤 검수 화면이 각각 맞는 행을 가리킨다(B의 함정).
4. 단위 스위트 596개 유지.

## 5. 결과

(라운드가 돌아오면 채운다)
