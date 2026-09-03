# 라운드 B 위임 보고 — 클라이언트가 학생별로 두 이미지를 보낸다 (2026-09-03)

브랜치 `stateless-recognize`, 기준 `ef15353`. 주문서: `stateless-b-order.md` (스크래치패드),
계획: [STATELESS_RECOGNITION_PLAN_2026-09-03.md](STATELESS_RECOGNITION_PLAN_2026-09-03.md) §3·§4(3단계)·§5.

**자체 합격 판정을 하지 않았다.** 아래는 무엇을 어떻게 바꿨는지와, 측정자가 알아야 할 사실뿐이다.
판정은 위임자가 로컬 dev에서 플래그를 켜고 19명을 셀 단위로 대조해서 한다.

---

## 1. 바꾼 파일 (행 번호는 작업 후 기준)

### 신규

| 파일 | 줄 | 내용 |
|---|---|---|
| `src/lib/stateless/statelessSession.ts` | 130 | 플래그 상수(`STATELESS_RECOGNIZE_ENABLED`, :19), 메모리 보관 쪽 타입, `pairStatelessPages`(:60), 실패 학생 빈 초안 `buildFailedStudentDraft`(:91), 응답 배열 → 세션 `assembleStatelessSession`(:113). **순수 함수만** — fetch 없음 |
| `src/lib/stateless/statelessRecognizeClient.ts` | 201 | 동시성 2 워커 풀(`recognizeStudentsStateless`, :63), 학생 단위 재시도(:104), `StatelessFormTypeMismatchError`(:39), multipart 조립(:174) |
| `src/lib/stateless/formNotices.ts` | 109 | 배치 라우트의 업로드 칸 가드·조기개입 안내 문자열을 **한 학생 단위로** 표현. `decideSheetType`(:46)과 문구 빌더 4개 |
| `tests/stateless-session.test.ts` | 280 | 클라이언트 순수 함수 + 러너 단위 시험 13개 |

### 수정

| 파일 | 줄 | 내용 |
|---|---|---|
| `src/app/api/recognize/student/route.ts` | :113 | `trustUploadedTypes` multipart 필드 수신 |
| | :128 | `classifyForm` × 2 + `detectCagiEarlyIntervention` (인식 **전**, 배치 라우트와 같은 자리) |
| | :134–:169 | 칸 가드 판정 → 불일치면 400 `FORM_TYPE_MISMATCH`(:158), 신뢰 시 덮어쓰기 안내 |
| | :171–:177 | 조기개입 안내 2종, 페이지 번호 = `studentIndex + 1` |
| | :201–:212 | 안내를 `student.warnings`에 **덧붙여** 응답 + `recognitionPolicyVersion` |
| `src/components/ImageUploadPanel.tsx` | :60 | `StatelessBatchPages` 타입 export |
| | :68 | `onAnalyzeTrigger`에 선택 3번째 인자 추가 |
| | :485 | `statelessPagesRef` — 렌더한 쪽을 메모리에 보관 |
| | :1221 | `holdPreparedBatchInMemory` — `/api/upload` 대신 보관 (`shrinkImageFileIfNeeded` 동일 적용) |
| | :1244–:1268 | `uploadPreparedBatch` 분기. 플래그 on이면 업로드도 F3 품질 요청도 하지 않는다 |
| | :1611 | `handleResetBatch` — 플래그 on이면 `/api/jobs/cleanup` 호출 생략 |
| | :1645 | `statelessBatchPages()` — 플래그 off/사진 모드/한쪽만 준비됨이면 `null` |
| | :2165 | `전체 설문지 인식 시작` 버튼이 3번째 인자를 넘긴다 |
| `src/app/page.tsx` | :183 | 버전 문자열 `v2026-08-27.1` → **`v2026-09-03.1`** |
| | :217 | `recognitionProgress` 상태 (플래그 off면 항상 `null` → DOM 동일) |
| | :368–:417 | `runStatelessRecognition` — 짝짓기, 진행률, 칸 불일치 재확인 루프 |
| | :435 | `requestRecognition`의 분기 한 줄. 나머지 배치 경로는 그대로 |
| | :894 | 인식 중 화면의 `학생 N / M명 인식 완료` |
| `tests/recognize-student-route.test.ts` | :103–:113 | 라운드 A의 동일성 시험을 안내 덧붙임에 맞춰 **강화** |
| | :180–:361 | 배치 라우트 ↔ 학생 라우트 안내 대조 시험 4개 (아래 §4) |

---

## 2. 플래그 on일 때 클라이언트 흐름

1. **파일 선택** — `handleBatchFileChange`는 지금과 똑같이 PDF를 렌더하고(사다리 `PDF_RENDER_OPTIONS`),
   보정 판정(F2 게이트 포함)을 거쳐 `preparedPages`를 만든다. **여기까지 무변경.**
2. **보관** — `uploadPreparedBatch`가 `/api/upload` 대신 `holdPreparedBatchInMemory`를 부른다.
   `shrinkImageFileIfNeeded(page.file, MAX_UPLOAD_IMAGE_BYTES)`를 **그대로 적용**한 뒤 `statelessPagesRef`에
   담는다 — 업로드 경로가 Blob에 넣던 바이트와 같아야 두 경로가 셀 단위로 비교 가능하기 때문이다.
   F3 품질 요청(`/api/uploads/quality`)은 보내지 않는다(그 판정은 학생 초안의 `sheetQuality`로 온다).
3. **인식 시작** — 버튼이 `onAnalyzeTrigger(inventory, satisfactionOrder, statelessBatchPages())`.
   `page.tsx`의 `requestRecognition`이 3번째 인자가 있으면 `runStatelessRecognition`으로 간다.
4. **짝짓기** — `pairStatelessPages`가 `matchBatch`와 같은 규칙으로 짝을 짓는다: **저장 페이지 번호** 기준
   정렬(배치의 스크래치 파일명이 `<type>_page_<번호4자리>.jpg`이므로 배치 짝짓기도 사실상 페이지 번호
   기준이다), `reversed`면 만족도 쪽만 뒤집는다. 장수가 다르면 배치와 같은 문구로 `COUNT_MISMATCH` 에러.
5. **호출** — `recognizeStudentsStateless`가 동시성 2로 `POST /api/recognize/student`
   (`cagi`·`satisfaction`·`jobId`·`studentIndex`, 있으면 `cagiRegistration`/`satisfactionRegistration`,
   재실행 시 `trustUploadedTypes=1`). 학생 하나가 실패하면 **그 학생만** 최대 3회 재시도(400은 재시도하지
   않음 — 같은 요청은 같게 거절된다), 그래도 실패하면 그 자리에 빈 초안 + 실패 사유. 진행률은 학생 수
   기준으로 `학생 N / M명 인식 완료`.
6. **조립** — `assembleStatelessSession`이 `studentIndex` 순서로 초안을 놓고(도착 순서 아님),
   각 초안의 `warnings`를 이어붙여 세션 안내 목록을 만든다. `setDrafts` / `setNotices` /
   `setCurrentDraftIndex(0)` — 배치 응답을 받던 자리와 **같은 모양, 같은 호출**.
7. **칸 불일치** — 어느 학생이든 400 `FORM_TYPE_MISMATCH`가 오면 러너가 즉시 중단하고 던진다.
   `page.tsx`가 배치와 **같은 확인창**을 띄우고, 사용자가 진행을 고르면 `trustUploadedTypes=true`로
   전체를 다시 돈다. 거절하면 배치와 같은 에러 표시.
8. **초기화** — `handleResetBatch`는 플래그 on이면 `/api/jobs/cleanup`을 부르지 않고(저장된 것이 없다)
   메모리만 비운다.

Blob 연산이 생길 자리는 이 흐름에 없다: `/api/upload` 없음, `/api/uploads/quality` 없음,
`/api/jobs/cleanup` 없음, 새 라우트는 `uploadStore`를 import하지 않는다. `POST /api/jobs`와
`storeRecognitionMeasurements`도 Blob을 건드리지 않는 것을 확인했다(`BLOB_OPS_TRACE`는 `uploadStore.ts`에만 있다).

**플래그 off**: `statelessBatchPages()`가 `null`을 돌려주고 `STATELESS_RECOGNIZE_ENABLED`가 `false`이므로
업로드 루프·F3 요청·cleanup·`/api/recognize` 배치 호출이 모두 지금 그대로다. 새로 추가된 DOM은
`recognitionProgress`가 `null`이라 렌더되지 않는다. 사진(개별/순차) 경로는 어느 쪽 플래그에서도 손대지 않았다.

**dev 서버에서 켜는 법** (셋 중 하나):

```powershell
$env:NEXT_PUBLIC_STATELESS_RECOGNIZE='1'; npm run dev
```

```bash
NEXT_PUBLIC_STATELESS_RECOGNIZE=1 npm run dev
```

또는 워크트리 루트에 `.env.local`로 `NEXT_PUBLIC_STATELESS_RECOGNIZE=1` 한 줄
(`.gitignore`의 `.env.*`에 걸려 커밋되지 않는다). `.claude/launch.json`으로 띄울 때는 환경변수가
그 프로세스에 실려야 하므로 `.env.local` 방식이 확실하다. `NEXT_PUBLIC_*`은 빌드/컴파일 시점에 치환되므로
**서버를 껐다 켜야** 값이 바뀐다.

---

## 3. 시험 결과 전문

```
$ npx tsc --noEmit
(출력 없음)

$ npx vitest run
 Test Files  50 passed | 17 skipped (67)
      Tests  492 passed | 17 skipped (509)
   Duration  31.88s (transform 4.79s, setup 4ms, collect 24.03s, tests 87.38s,
                     environment 15ms, prepare 17.58s)
```

기준(`ef15353`) 대비 시험 수 492 = 라운드 A의 475 + 신규 17(러너·순수 함수 13, 라우트 안내 대조 4).
`npm run build`는 돌리지 않았다. 새 의존성 없음.

---

## 4. 안내·가드가 배치와 같은지 어떻게 고정했나

`tests/recognize-student-route.test.ts`의 두 번째 describe가 **같은 이미지 바이트를 두 라우트에 모두 넣고**
결과 문자열을 비교한다. 1명짜리 배치를 쓰는데, 그게 두 라우트를 비교할 수 있는 유일한 크기다(여러 장이면
배치는 페이지 번호를 한 문장에 모으고 학생 단위 라우트는 그럴 수 없다).

| 시험 | 입력 | 고정한 것 |
|---|---|---|
| 조기개입 표기 + 연락처 | `cagi-blank.png`에 조기개입 행을 가로지르는 검은 띠 합성 | 배치 `warnings` 2줄 == 학생 라우트가 초안에 붙인 2줄 |
| 연락처만 | `cagi-blank.png` 원본(이 빈 양식은 연락처 흔적이 잡힌다) | 배치 1줄 == 학생 라우트 1줄 |
| 칸 불일치 | 만족도 빈 양식을 선별검사 칸에 | 두 라우트 모두 400, `error`·`mismatches` 동일, 학생 라우트는 `code`·`canProceedWithUploadedTypes`·`recognitionPolicyVersion`까지 |
| 칸 신뢰 진행 | 같은 입력 + `trustUploadedTypes` | 배치 덮어쓰기 안내 == 학생 라우트 안내 (문자열 그대로) |

파일명은 양쪽을 같게 맞췄다(`cagi_page_0001.jpg`). 배치는 **저장된 페이지 번호**로 이름을 만들고 학생
라우트는 **클라이언트가 보낸 이름**을 쓰므로, 맞추지 않으면 가드가 아니라 픽스처 차이를 재게 된다.

라운드 A의 동일성 시험(:103)은 약화하지 않고 **강화**했다: 안내를 뺀 나머지 필드가 공유 인식기 결과와
완전히 같은지, 인식기 자신의 `warnings`가 앞쪽에 그대로 남아 있는지, 그리고 뒤에 붙은 것이 정확히
예상 안내인지를 따로 본다.

---

## 5. 명세와 다르게 한 것 (모두 의도적)

1. **안내를 `student.warnings`에 "덮어쓰지" 않고 "덧붙였다".**
   인식기(`detectCheckmarks.ts:710`)가 모든 초안에 `warnings: []`를 만들고 종이 경계가 불안정할 때
   거기에 직접 밀어 넣는다. 대입했다면 **값에 대한 경고를 지우고 종이에 대한 경고를 넣는** 셈이 된다.
   처음 구현에서 실제로 그렇게 썼다가 라운드 A 시험이 잡아냈다.
2. **여러 학생의 조기개입 안내가 배치처럼 한 줄로 합쳐지지 않는다.**
   배치는 `선별검사지 3, 7페이지에서 …`처럼 페이지 번호를 모아 한 줄을 만든다. 학생 단위로는 서버가
   한 학생만 보므로 `선별검사지 3페이지에서 …`, `선별검사지 7페이지에서 …` 두 줄이 된다.
   내용은 같고 셀 값과 무관하다. 합치려면 라우트가 문자열 대신 구조화된 플래그를 돌려주고 클라이언트가
   문장을 만들어야 하는데, 그건 "안내를 서버 쪽 새 라우트에 옮긴다"는 주문과 어긋나 보여 하지 않았다.
3. **덮어쓰기 안내의 파일명이 배치와 다르다** — 배치는 `cagi_page_0001.jpg`(저장 페이지 번호),
   학생 라우트는 클라이언트가 보낸 원래 파일명. 스캔 경로에서는 둘 다 `cagi_page_00N.jpg` 꼴이고
   사용자에게는 후자가 더 알아보기 쉽다. 시험에서는 양쪽 이름을 맞춰 문자열 동일까지 확인한다.
4. **재시도는 "첫 시도 + 최대 3회 재시도"**(요청 최대 4회, 400ms·800ms·1200ms 지연)로 읽었다.
   "3회까지 재시도"의 문자 그대로다. 상수는 `MAX_RETRIES_PER_STUDENT`.
5. **`handleResetBatch`가 플래그 on에서 `/api/jobs/cleanup`을 부르지 않는다.** 주문에 없지만,
   부르면 그것이 무상태 경로에 남는 유일한 Blob 연산이 된다. `/api/jobs/cleanup` 코드 자체는 무변경.
6. **안내 대조 시험을 별도 파일이 아니라 `tests/recognize-student-route.test.ts`에 넣었다.**
   따로 두었더니 라운드 A의 "스크래치가 남지 않는다" 검사가 **깨졌다** — 그 검사는 OS 임시 디렉터리의
   `kpga-student-*`를 전부 세는데, 다른 워커에서 같은 라우트를 부르는 시험 파일이 자기 작업 디렉터리를
   거기 만들어 두면 누수가 아닌 것을 누수로 본다. 같은 파일이면 한 워커에서 순차 실행되어 겹치지 않는다.

---

## 6. 확신 없는 것 / 측정자가 봐야 할 것

1. **한 요청 상한 4.5MB(`MAX_STUDENT_REQUEST_BYTES`, 라운드 A가 정한 값)를 건드리지 않았다.**
   쪽당 상한은 `MAX_UPLOAD_IMAGE_BYTES = 3.8MB`라 이론적으로 두 장이 7.6MB까지 갈 수 있다.
   계획 §3이 적은 실측은 두 장 합계 ~0.6MB이라 스캔 경로에서는 문제가 없겠지만, **고해상도 사진 두 장이면 400
   `PAYLOAD_TOO_LARGE`가 날 수 있다.** Vercel의 실제 본문 상한이 4.5MB라 올려도 불투명한 413이 될 뿐이라
   그대로 두었다. 세트 4(회색조 600dpi)를 돌린다면 요청 크기를 한 번 봐 두는 편이 좋다.
2. **칸 가드가 실제 19명에서 발화하면 전체가 한 번 더 돈다.** 배치 라우트가 같은 이미지에 같은
   `classifyForm`을 돌려 지금 통과하고 있으므로 발화하지 않을 것으로 보지만, 발화하면 확인창이 뜨고
   진행을 고를 때 19명을 다시 인식한다(값은 배치와 같은 규칙). 로그에 400이 보이면 이것이다.
3. **`classifyForm` + `detectCagiEarlyIntervention`가 학생당 요청에 추가됐다.** 배치는 38장을 한 번에
   병렬로 돌렸고 여기서는 학생마다 3번 돈다. 값에는 영향이 없지만 학생당 실행 시간은 라운드 A 실측
   (2.6s / 3.6s)보다 늘어난다. §5 위험 2의 `maxDuration = 30`에는 여유가 있어 보이나 실측이 필요하다.
4. **브라우저에서 한 번도 돌려보지 못했다.** 이 워크트리에는 실제 스캔 PDF도 정답표도 없고(§6 규칙),
   `npm run build`도 금지라 dev 구동 검증을 하지 않았다. 타입 검사와 단위·라우트 시험까지가 여기서 낼 수
   있는 증거의 전부다.
5. **메모리**: 38장을 `File`로 들고 있다(≈11MB). 인식이 끝나면 패널이 언마운트되면서 함께 사라진다.
   "검수 취소"로 돌아오면 파일을 다시 골라야 하는데, 이는 레거시 경로도 마찬가지다(인식 후 업로드본을
   지운다).
