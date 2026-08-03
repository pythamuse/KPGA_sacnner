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
