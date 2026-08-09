# Vercel 무상태(stateless) 아키텍처 전환

> 이 문서는 기존 `Docs/14_PREVIEW_DEPLOYMENT_QA_2026-08-01.md`(git 이력에서 복원),
> `Docs/17_VERCEL_STATEFULNESS_AND_JBIG2_ISSUES.md`(1절), `Docs/18_STATELESS_SAVE_DOWNLOAD_FIX_RESULTS.md`,
> `Docs/19_STATELESS_PREVIEW_IMAGE_FIX_RESULTS.md`, `Docs/25_DATA_URI_TOPFRAME_NAVIGATION_BLOCKED.md`를
> 통합한 문서입니다.

## 배경

`src/lib/storage/jobStore.ts`와 `src/lib/excel/templateManager.ts`는 작업 세션·업로드 이미지·작업용 엑셀 사본을 전부 `os.tmpdir()`(로컬 디스크)에 저장했다. Vercel 서버리스 함수는 요청마다 다른 인스턴스로 처리될 수 있고, 각 인스턴스의 `/tmp`는 서로 공유되지 않는다. 작업을 만든 인스턴스가 아닌 다른 인스턴스가 이후 요청을 받으면 그 인스턴스엔 파일이 없어 404가 난다.

## 사이클 1 — 최초 발견 (2026-08-01, PR #2 Vercel 프리뷰 실기 테스트)

### 작업 내용

실제 Chrome으로 배포본(`.../pull/2` 프리뷰)에 접속해 청소년/성인 두 트랙을 새 작업 생성 → 업로드 → 인식 → 검수 → 저장 → 다운로드까지 직접 실행. 코드 변경은 없이 순수 조사.

### 테스트 결과

UI/트랙 분기 로직 자체는 정상 동작했으나, 다음 두 문제를 재현:

- **[Critical] 저장된 작업 세션이 유실될 수 있음**: `POST /api/students`가 몇 초~수십 초 뒤 `404 유효하지 않은 작업 세션입니다`로 실패. 더 심각하게는, 저장이 **실제로 성공했던 작업**(200 응답, 학생 목록 정상 반영 확인)도 몇 분 뒤 `GET /api/download`가 동일하게 404를 반환 — 저장 성공 화면을 본 뒤에도 다운로드 시점에 작업 전체가 사라져 있을 수 있었다. 원인: `jobStore.ts`가 인메모리 `Map` + `session.json` 파일 기반 복구를 병행했지만, 복구할 파일 자체가 해당 인스턴스에 없으면 무조건 404.
- **[Medium] 성인 트랙 "연령대" crop 미리보기가 청소년 좌표를 사용**: `/api/uploads/crop`의 `findFieldRegion()`이 트랙 구분 없이 청소년 전용 좌표만 사용 — 성인 이미지의 엉뚱한 영역을 200 OK로 잘라서 보여줌(오류처럼 보이지 않아 더 위험).

로컬 개발 서버(단일 Node 프로세스)에서는 인스턴스 분산이 재현되지 않아 그동안 발견되지 못했던 문제.

### 다음 작업을 위한 피드백

- Critical 이슈(저장/다운로드 세션 유실)는 앱 핵심 기능이 걸린 문제라 최우선 대응 필요.
- Medium 이슈(성인 트랙 crop 오표시)는 별도로 남겨둠 — 이번 스레드에서 계속 미착수 상태로 남는다(사이클 5 피드백 참고).

## 사이클 2 — 재확인 및 방향 결정 (2026-08-02, PR #3 Vercel 프리뷰)

### 작업 내용

같은 문제가 **핵심 저장 버튼(`/api/students`)까지 동일하게 영향받는다**는 게 재확인됨 — 단순 미리보기 문제가 아니라 앱 핵심 기능이 비결정적으로 완전히 막힐 수 있는 치명적 문제로 재분류.

검토한 방향:
- **방향 A. 클라이언트를 진실의 원천으로 삼는 무상태 재설계 (채택)**: 저장/다운로드 요청마다 클라이언트가 확정 학생 전체 목록을 함께 보내면, 서버는 매번 레포에 번들된 원본 템플릿에서 시작해 전체 목록을 다시 써서 반환. 이미지 미리보기도 서버 재조회 없이 클라이언트가 가진 File을 직접 사용. 새 인프라 불필요, 현재 규모(강사 1명, 학생 수십 명)에 적합.
- 방향 B. Vercel Blob Storage 등 외부 공유 저장소 도입: 개념적으로 단순하지만 대시보드 수동 설정이 필요하고(이 환경엔 `vercel` CLI 없음), 로컬/배포 저장 방식이 갈라져 코드가 복잡해짐 — 기각.

### 테스트 결과

(이 사이클은 방향 결정만 진행, 코드 변경 없음 — 검증은 사이클 3에서.)

### 다음 작업을 위한 피드백

- 방향 A로 저장/다운로드부터 구현 → 사이클 3.

## 사이클 3 — 저장/다운로드 무상태화 구현

### 작업 내용

- `src/lib/excel/generateWorkbookPair.ts`(신규): 클라이언트가 보낸 확정 학생 전체 목록을 받아, 레포 번들 원본 템플릿에서 매번 새로 CAGI/만족도 엑셀 2개를 생성. 요청마다 `crypto.randomUUID()` 스크래치 디렉터리 사용으로 동시 요청 간 경로 충돌 방지.
- `src/app/api/students/route.ts` 재작성: `POST {jobId, students}` — 목록 전체로 `generateWorkbookPair` 호출.
- `src/app/api/download/route.ts` 재작성: `GET ?jobId=&type=` → `POST {type, students}`로 변경.
- `src/app/page.tsx`: 저장 시 전체 목록 전송, 다운로드는 `fetch(POST) → blob → 프로그래밍적 클릭` 방식으로 변경.
- Codex CLI로 초안 작성 후 직접 리뷰: `generateWorkbookPair.ts`는 정확성이 핵심이라 직접 작성. Codex가 `page.tsx`에 남겨둔 옛 `<a href={downloadHref(...)}>` 죽은 참조를 grep으로 발견해 직접 제거.

### 테스트 결과

- `npm test`: 9 files, 33 tests 통과(`integration.test.ts` 6개 포함, 신규 계약 기준). `npm run build`: 통과.
- 로컬 dev 서버 E2E: 업로드 → 검수 화면 필드 채움 → "검수 완료 및 엑셀 반영" `POST /api/students` 200, 학생 목록 `(0명)→(1명)` 갱신 확인 → CAGI/만족도 다운로드 각각 `POST /api/download` 200, 콘솔 에러 0건.
- 세 요청 모두 이전 요청의 서버 로컬 상태 존재 여부와 무관하게 동작함을 코드상/네트워크 응답으로 확인.

### 다음 작업을 위한 피드백

- 같은 근본 원인이 검수 화면의 크롭/원본 이미지 미리보기(`/api/uploads/crop`, `/api/uploads/image`)에도 남아있음 — 다음 사이클에서 처리.
- Vercel 다중 인스턴스 환경 자체는 로컬 dev 서버로 재현 불가능하므로, 이번 검증은 "코드가 요청 간 서버 로컬 상태에 의존하지 않는다"는 것을 코드 리뷰 + 로컬 E2E로 확인한 것이지 실제 다중 인스턴스 환경에서의 최종 확인은 아니다.

## 사이클 4 — 이미지 미리보기 무상태화 구현

### 작업 내용

- `/api/recognize`가 업로드 파일이 쓰인 것과 같은 인스턴스에서 즉시 읽어 ROI 채점을 수행하는 시점에, 원본 이미지 축소본과 필드별 크롭(일반/디버그 오버레이)을 base64 data URI로 만들어 학생 draft의 `source`에 직접 실어 보내도록 변경.
- `src/lib/recognition/fieldCrop.ts`(신규): 크롭 영역 계산/추출/디버그 오버레이 로직을 재사용 가능한 함수로 추출.
- `src/lib/recognition/buildSourcePreview.ts`(신규): 학생 1명분(CAGI+만족도) 원본 축소본 2장 + 전체 필드(23개) 크롭을 일반/디버그 두 버전으로 생성.
- `src/components/RecognitionReview.tsx`: `imageUrl`/`cropUrl` 헬퍼가 `/api/uploads/*` URL 대신 `draft.source`의 data URI를 직접 반환.
- `/api/uploads/crop`, `/api/uploads/image`는 삭제하지 않고 유지(같은 인스턴스 접근 시 여전히 동작, 내부적으로 `fieldCrop.ts` 공용 함수 재사용).
- 구현 중 이 Windows 환경의 codex 샌드박스 헬퍼가 없어 `-s workspace-write`가 실패 → `--dangerously-bypass-approvals-and-sandbox`(사용자 승인 후)로 재시도해 정상 동작.

### 테스트 결과

- `npm test`: 9 files, 33 tests 통과(신규 assertion: `cagiImageDataUrl`/`satisfactionImageDataUrl`이 `data:image/jpeg;base64,`로 시작, `cropDataUrls` 비어있지 않음). `npm run build`: 통과.
- 로컬 dev 서버 E2E: 검수 화면 `<img>` 25개(원본 2장 + 필드 크롭 23장) 전부 `src`가 `data:` URI임을 DOM에서 확인. `/api/uploads/...` `<a href>` 0개 확인. 원본 이미지 `naturalWidth/Height` 실제 크기와 일치 확인. 크롭 이미지는 `loading="lazy"`로 뷰포트 밖에서 `naturalWidth=0`으로 보였으나 별도 `Image()` 객체 직접 로드로 정상 디코딩 확인(지연 로딩 특성일 뿐 결함 아님). 검증 전 과정에서 `/api/uploads/crop`·`/api/uploads/image` 신규 네트워크 요청 0건.

### 다음 작업을 위한 피드백

- 저장/다운로드/이미지 미리보기 모두 무상태화 완료. 성인 트랙 crop 오표시(사이클 1)는 여전히 미착수.
- data URI로 바뀐 이미지를 "새 탭에서 크게 보기"로 여는 기존 UI가 문제없이 동작하는지는 별도 확인이 필요 — 사이클 5에서 실제로 문제가 됨.

## 사이클 5 — 부작용: data URI 새 탭 열기 차단 (2026-08-03)

### 작업 내용

무상태화로 이미지가 `data:` URI가 되면서, 검수 화면의 크롭 썸네일/"ROI 확인"/원본 이미지 링크(전부 `<a href={dataUri} target="_blank">`)가 다음 에러로 깨짐:

> Not allowed to navigate top frame to data URL

`<img src={dataUri}>`로 화면에 표시하는 건 문제없지만, `data:` URI를 새 탭의 최상위 프레임 탐색 대상으로 쓰는 것은 최신 브라우저가 피싱 방지를 위해 명시적으로 차단하는 스펙 동작(버그 리포트로 고쳐질 사안 아님). Blob URL(`URL.createObjectURL()`)은 최상위 탐색이 허용됨.

수정: `src/components/RecognitionReview.tsx`의 세 `<a>`(크롭 썸네일, ROI 확인, 원본 이미지) 전부 클릭 시 `event.preventDefault()` → data URI를 fetch→blob 변환 → `URL.createObjectURL(blob)` → `window.open(blobUrl, '_blank')`로 교체. 이후 `URL.revokeObjectURL`로 메모리 해제.

### 테스트 결과

별도 검증 기록 없음 — 수정 방향까지만 기록되어 있었음(원본 `Docs/25`에 검증 결과 섹션이 없었음).

### 다음 작업을 위한 피드백

- **재배포 후 실제로 크롭/원본 이미지 링크가 새 탭에서 열리는지 확인 필요** — 아직 확인되지 않음.
- 성인 트랙 "연령대" crop 미리보기가 청소년 좌표를 쓰는 문제(사이클 1)는 이 스레드 전체에서 끝내 다루지 않았다 — 성인 ROI 좌표가 정의되기 전까지는 `track === 'adult'`일 때 `basic.age` crop 미리보기 자체를 숨기는 처리가 필요.
- JBIG2 PDF 렌더링 이슈([[PDF_BATCH_RENDER_HANG]])는 이 스레드와 무관한 별개 문제로, 계속 미해결 상태.

## 사이클 6 — 업로드·인식 경로의 무상태성 누락 재발 (2026-08-06)

### 재현

운영 배포본 `테스트 버전 v2026-08-06.1`에서 실제 19페이지 CAGI PDF와 19페이지 만족도 PDF를 업로드한 뒤, 인식 API가 `COUNT_MISMATCH`와 함께 CAGI 18장·만족도 19장을 반환했다. 원본 PDF의 페이지 수는 두 파일 모두 19장이다.

### 원인 확정

이전의 `unknown` 양식 분류 누락 문제와는 다르다. 현재 `classifyForm()`은 파일명 힌트를 최종 폴백으로 사용하므로 `cagi_`/`satisfaction_` 접두사가 있는 업로드 파일은 `unknown` 때문에 목록에서 사라지지 않는다.

문제는 `ImageUploadPanel`이 PDF 페이지마다 별도 `/api/upload` 요청을 보내고, `/api/upload`와 `/api/recognize`가 모두 `os.tmpdir()`의 작업 폴더를 요청 간 공유 저장소처럼 사용한다는 점이다. Vercel은 업로드 요청과 인식 요청을 서로 다른 서버리스 인스턴스에 배정할 수 있다. 한 인스턴스에만 기록된 페이지는 다른 인스턴스의 `fs.readdirSync(uploadDir)`에서 보이지 않는다. 따라서 화면의 18/19 집계는 실제 PDF 장수가 아니라 **인식 요청을 처리한 인스턴스가 우연히 관측한 임시 파일 수**다.

이전 무상태 전환은 학생 저장·엑셀 다운로드·검수 미리보기에만 적용됐고, 업로드·인식 파이프라인에는 "직후 요청은 같은 인스턴스일 것"이라는 잘못된 가정이 남아 있었다. 로컬 테스트는 단일 Node 프로세스를 사용하므로 이 결함을 재현하지 못했다.

### 즉시 적용할 설계 규칙

1. `/api/upload`의 성공 응답은 외부 영속 저장소에 파일과 페이지 인벤토리가 기록된 뒤에만 반환한다.
2. `/api/recognize`는 서버 로컬 파일 목록이 아니라 영속 인벤토리로 페이지를 읽고, 기대 장수·저장 장수·페어링 장수를 비교한다.
3. 영속 인벤토리를 도입하기 전에는 `COUNT_MISMATCH`에 "누락된 사진"이라는 단정을 넣지 않는다. 현재 인스턴스의 파일 가시성 오류는 별도 업로드 무결성 오류로 표시한다.
4. PDF 일괄 처리 회귀 테스트는 페이지 수가 같은 입력만 만드는 단위 테스트로 충분하지 않다. 서로 독립된 저장소 컨텍스트에서 업로드·인식 요청을 실행하거나, 영속 저장소 어댑터를 테스트 더블로 분리해 페이지 19장이 모두 조회되는지 검증한다.

### 필요한 다음 구현

권장안은 비공개 외부 객체 저장소에 원본 페이지와 작업별 인벤토리를 저장하는 것이다. Vercel Blob을 사용한다면 비공개 접근, 짧은 TTL, 작업 취소·완료 후 삭제, 개인정보를 포함하지 않는 난수 파일명으로 구성한다. 저장소를 쓰지 않는 대안은 페이지 쌍을 동일 요청에서 변환·인식하는 완전 무상태 API지만, 두 이미지의 요청 크기 제한과 브라우저 재시도 설계를 별도로 검증해야 한다.

두 안 모두 `os.tmpdir()`는 요청 내부의 일회성 처리 공간으로만 사용할 수 있으며, 이후 API 요청에서 다시 찾아야 하는 원본·세션·인벤토리를 보관해서는 안 된다.

## 사이클 7 — Vercel Blob 기반 업로드 영속화 구현 (2026-08-06~09)

> 이 사이클은 별도 문서였던 `Docs/UPLOAD_PERSISTENCE_IMPLEMENTATION.md`의 내용을 이관해 통합한 것이다. 원 위치가 문서 구성 규칙(`README.md`)과 맞지 않아(구현 기록은 `Docs/`가 아니라 `Task/`에 있어야 함) 이 사이클로 옮기고 원본 파일은 삭제한다.

### 작업 내용

사이클 6에서 권고한 대로, 업로드 원본을 외부 영속 저장소(Vercel Blob)로 이전했다(사용자가 이 대화 밖에서 Codex를 직접 실행해 구현, 커밋 `e27138c`).

- `src/lib/uploadInventory.ts`(신규): `UploadKind`, `UploadBatchReference`(`batchId`, `expectedPageCount`), `UploadInventory` 타입과 `isSafeJobId`/`isUploadBatchReference`/`isUploadInventory` 검증 함수. `batchId`는 `/^[a-zA-Z0-9_-]{8,128}$/`, `jobId`는 `/^job_[a-zA-Z0-9_-]+$/`로 검증해 Blob 경로 주입 위험을 차단.
- `src/lib/storage/uploadStore.ts`(신규): `storeUploadPage`/`readUploadPage`/`deleteJobUploads`/`deleteUploadBatch(es)`. `usesLocalMemoryStore()`(`NODE_ENV==='test' || !process.env.VERCEL`)가 참이면 인메모리 `Map`을, Vercel 배포본에서는 실제 `@vercel/blob`의 `put`/`get`/`list`/`del`(access: `private`)을 사용. Blob 경로는 `kpga-scan/jobs/{jobId}/uploads/{type}/{batchId}/page-NNNN.jpg` 형식으로 원본 파일명·PII를 노출하지 않음.
- `src/app/api/upload/route.ts` 재작성: `jobId`/`type`/`batchId`/`expectedPageCount`/`pageNumber`를 받아 `storeUploadPage` 성공 후에만 200을 반환. 기존 `ensureJobSession(jobId)` 검사(로컬 `jobStore` 기반)는 제거됨 — Blob 저장 자체가 성공/실패 판정 기준이 됨.
- `src/app/api/recognize/route.ts` 재작성: `{jobId, inventory}`를 받아, 선언된 두 배치(`cagi`/`satisfaction`)의 `expectedPageCount`가 다르면 파일을 읽기 전에 즉시 `COUNT_MISMATCH`. 이후 `materializeUploadBatch`가 배치의 모든 페이지를 `Promise.all`로 병렬 `readUploadPage`해 요청 스코프 임시 디렉터리(`os.tmpdir()/kpga-scanner/recognize/{randomUUID}`)에 내려받는다. 선언된 페이지 중 일부를 Blob에서 못 찾으면(사이클 6의 근본 버그였던 "일부만 보임" 상황) `COUNT_MISMATCH`가 아니라 별도의 `UPLOAD_INTEGRITY_ERROR`(기대/실제 페이지 번호 목록 포함)로 정직하게 실패한다. 인식 성공 후에는 해당 배치를 Blob에서 삭제.
- `src/app/api/jobs/cleanup/route.ts`: `scope=uploads`/`scope=job`이 `deleteJobUploads`(Blob, job 프리픽스 전체 삭제)를 호출하도록 배선. `scope=expired`(기존 `jobStore` TTL)는 "레거시 개발 워크스페이스 전용" 주석과 함께 유지되나, **Blob에 남은 업로드에는 적용되지 않는다** — 아래 "다음 작업 피드백" 참고.
- `src/components/ImageUploadPanel.tsx`: 촬영/선택마다(순차 모드는 파일 1장당, 배치 모드는 PDF 전체당) `createBatchId()`로 새 `batchId`를 발급해 `uploadInventoryRef`에 누적하고, cagi/satisfaction 배치가 모두 갖춰지면 `onAnalyzeTrigger(inventory)`를 호출.

### 테스트 결과

- 클로드 코드가 이 대화에서 구현물을 직접 리뷰(커밋 전)하고, 커밋 후 재검증: `npm test` 17개 파일 66개 테스트, `npm run build` 통과(둘 다 이 시점 기준 최신 수치 — Blob 작업 자체가 추가한 것은 그중 `tests/integration.test.ts`/`tests/job-cleanup.test.ts` 재작성과 신규 `tests/helpers/uploadApi.ts`).
- **중요한 한계**: `usesLocalMemoryStore()` 때문에 로컬/테스트 환경은 전부 가짜 인메모리 저장소를 쓴다. `@vercel/blob`의 실제 `put`/`get`/`list`/`del` 호출, `access: 'private'` 등 옵션, 실패 시 에러 메시지 형식은 테스트에서 단 한 번도 실행되지 않는다 — "테스트 통과"가 검증하는 것은 애플리케이션 로직뿐이고 Blob 연동 자체가 아니다.
- 클로드 코드가 배포 전 검토에서 지적한 리스크(Vercel Blob 스토어가 실제로 프로젝트에 연결됐는지 배포 전 확인되지 않음 — 연결 안 된 채 배포되면 모든 업로드가 503으로 완전히 막힘)는, 이후 사용자가 실제 19쌍 PDF 배치([[COORDINATE_REGISTRATION_AND_RESPONSE_PRIOR_PLAN]] §10.1)로 업로드~인식까지 정상 진행되는 것을 확인하면서 **간접적으로 해소된 것으로 판단**한다(Blob이 실제로 연결되어 있지 않다면 그 테스트 자체가 503으로 막혔을 것). 다만 이는 사후 관찰이지 사전 검증은 아니었다.

### 다음 작업을 위한 피드백

- **[미해결, PRD 위반 가능성] 업로드 파일의 자동 만료(TTL)가 없다.** `Docs/00_PRD.md` 10장은 "파일 만료: 작업 세션 파일은 일정 시간 후 자동 삭제"를 요구하는데, Blob 업로드는 (a) 인식 성공 시 해당 배치만, (b) 사용자가 명시적으로 "초기화"를 누를 때만 삭제된다. 사용자가 사진을 올리고 탭을 닫으면 그 이미지는 Blob에 영원히 남는다.
- **[미해결] 재촬영/재선택마다 새 `batchId`를 발급하므로, 이전 시도의 Blob 데이터가 고아로 남을 수 있다.** `/api/recognize`는 최종 배치만 삭제하고, 도중에 버려진 배치는 정리하지 않는다(같은 job에서 나중에 "초기화"를 누르면 job 프리픽스 전체가 삭제되어 함께 정리되지만, 초기화 없이 세션이 끝나면 남는다).
- **[미해결, 테스트 커버리지 회귀] `tests/integration.test.ts` 재작성 과정에서 `/api/students`·`/api/download`(엑셀 저장·다운로드) end-to-end 검증이 통째로 빠졌다.** 이 리포지토리 어디에도 이 두 라우트를 호출하는 테스트가 남아있지 않다. 두 라우트 자체는 이번 변경 대상이 아니었지만, 앱의 핵심 기능을 지키던 회귀 방지막이 사라졌다.
- **[낮음, 죽은 코드]** `/api/uploads/crop`, `/api/uploads/image`가 여전히 `getJobDir(jobId)/uploads`(로컬 디스크) 경로를 참조하는데, 업로드가 더 이상 로컬 디스크에 쓰이지 않으므로 이 두 라우트는 항상 실패한다. 프론트엔드는 사이클 4 이후 이미 이 라우트를 호출하지 않으므로 사용자 영향은 없지만, 정리 대상이다.
- **[낮음, 성능 미검증]** 19쪽 배치라면 인식 요청 1회에서 최대 38개의 Blob 읽기가 동시에 발생한다(`materializeUploadBatch`의 `Promise.all`). 이번 세션에서 OCR 기능이 "로컬은 빠른데 Vercel은 느림"으로 184초까지 늘어났던 전례([[OCR_ANCHORED_ROW_DETECTION]])가 있어, 이 동시성도 별도로 실측 확인이 필요하다.
- **[낮음]** `uploadStore.ts`의 `toStorageError`가 Blob SDK의 에러 **메시지 문자열**을 정규식으로 매칭해 "설정 안 됨" 여부를 판정한다 — SDK가 메시지 문구를 바꾸면 조용히 오분류될 수 있는 취약한 방식이다.
- 사이클 1의 "성인 트랙 crop 오표시"는 이 사이클에서도 다루지 않았다 — 계속 미착수.
