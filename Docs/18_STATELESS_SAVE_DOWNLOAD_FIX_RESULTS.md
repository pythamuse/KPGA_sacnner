# 18. 무상태 저장/다운로드 재설계 - 구현 및 검증 결과

관련 문서: [[17_VERCEL_STATEFULNESS_AND_JBIG2_ISSUES]]에서 정의한 "이번 범위: 1번(Vercel 저장소 문제) 방향 A(무상태 재설계)"의 구현 및 테스트 결과.

## 배경

Vercel 서버리스 환경에서는 각 요청이 서로 다른 인스턴스로 라우팅될 수 있고, 인스턴스 로컬 `/tmp`는 인스턴스 간 공유되지 않는다. 기존 구현은 `/api/jobs`에서 만든 작업 파일(및 세션 정보)이 이후 `/api/students`(검수 완료 저장), `/api/download`(엑셀 다운로드) 요청에서도 같은 인스턴스에 남아있다고 가정했기 때문에, 실제 배포 환경에서 "작업 세션이 존재하지 않습니다" 404가 간헐적으로 발생했다 (검수 완료 및 엑셀 반영 버튼, 다운로드 버튼 모두 영향).

## 구현 내용

- `src/lib/excel/generateWorkbookPair.ts` (신규): 클라이언트가 들고 있는 확정 학생 전체 목록을 받아, 레포에 번들된 원본 템플릿에서 매번 새로 CAGI/만족도 엑셀 2개를 생성한다. 이전 요청의 작업 파일에 전혀 의존하지 않는다. 요청마다 `crypto.randomUUID()` 기반 스크래치 디렉터리를 사용해 동시 요청 간 경로 충돌도 방지했다.
- `src/app/api/students/route.ts` (재작성): `POST {jobId, students: StudentData[]}` — 마지막 원소(새로 저장할 학생)만 검증하고, 목록 전체로 `generateWorkbookPair`를 호출해 무결성 검증까지 마친 뒤 저장된 학생 정보를 반환한다.
- `src/app/api/download/route.ts` (재작성): `GET ?jobId=&type=` → `POST {type, students}`로 변경. 서버는 매번 템플릿부터 새로 생성해 반환하므로 이전 저장 요청이 실제로 인스턴스에 파일을 남겼는지와 무관하게 동작한다.
- `src/app/page.tsx`: 저장 시 `students: [...students, currentDraft]` 전체 목록 전송, 다운로드는 `<a href>` 방식에서 `fetch(POST) → blob → 프로그래밍적 클릭` 방식으로 변경.
- `tests/integration.test.ts`: 새 계약(POST 방식, 학생 목록 전체 전송)에 맞게 갱신.

구현은 Codex CLI(`codex exec`)로 초안을 작성시키고, 내가 직접 리뷰·수정했다. `generateWorkbookPair.ts`는 정확성이 가장 중요한 핵심 로직이라 내가 직접 작성했다. Codex가 만든 `page.tsx` 수정본에서 `handleSaveStudent`/`handleDownload` 함수 본문은 정확했지만, JSX의 `<a href={downloadHref(...)}>` / `onClick={blockEmptyDownload}` 참조를 지우지 않고 남겨둔 것을 grep으로 발견해 버튼 방식으로 직접 교체했다.

## 검증

### 자동 테스트

```
npm test
```

9개 테스트 파일, 33개 테스트 전부 통과 (`tests/integration.test.ts` 6개 포함, 신규 계약 기준으로 검증).

```
npm run build
```

타입 체크 및 프로덕션 빌드 성공 (에러 없음).

### 브라우저 E2E 검증 (로컬 개발 서버)

1. 로컬 dev 서버에서 "개별/순차 촬영" 모드로 CAGI/만족도 이미지 2장을 업로드 → 인식 결과 검수 화면(`1 / 1번째 학생 데이터`) 진입 확인.
2. 검수 화면의 모든 필드(연령대, 성별, 학교유형, 학년, CAGI 01-09, 문항1-10)를 값으로 채운 뒤 **"검수 완료 및 엑셀 반영"** 버튼 클릭.
   - `POST /api/students` → **200 OK** 확인.
   - 우측 패널 "작성 완료된 학생 데이터"가 `(0명)` → `(1명)`으로 갱신되고, `순번 1 / 엑셀 행 3행 / 연령대 15 / 성별 여 / 학교유형 고등학교 / 학년 1학년 / 상태 엑셀 반영 완료`로 정확히 표시됨.
3. **FORM 01 (CAGI) 다운로드** 버튼 클릭 → `POST /api/download` → **200 OK** 확인.
4. **FORM 02 (만족도) 다운로드** 버튼 클릭 → `POST /api/download` → **200 OK** 확인.
5. 두 요청 모두 콘솔 에러 없음 (`read_console_messages` onlyErrors 결과 0건).

세 요청(저장 1회, 다운로드 2회) 모두 이전 요청이 만든 작업 파일 존재 여부와 무관하게 매번 템플릿부터 새로 생성하는 경로로 동작했음을 코드상으로도, 네트워크 응답 상태로도 확인했다.

## 결론

- [[17_VERCEL_STATEFULNESS_AND_JBIG2_ISSUES]]에서 지적한 두 가지 문제 중 **1번(Vercel 인스턴스 간 `/tmp` 미공유로 인한 저장/다운로드 404)은 해결**되었다. `/api/students`, `/api/download`가 더 이상 이전 요청의 서버 로컬 상태에 의존하지 않는다.
- **2번(JBIG2 디코더 행)과 크롭/원본 이미지 미리보기 404(`/api/uploads/crop`, `/api/uploads/image`)는 이번 범위에서 다루지 않았다** — 여전히 `jobStore`/`getJobDir` 기반 로컬 상태에 의존하므로 같은 종류의 Vercel 인스턴스 문제가 남아있을 수 있다. 후속 과제로 남긴다.
- 실제 Vercel 배포 환경에서의 인스턴스 분산 상황은 로컬 dev 서버(단일 프로세스)로는 재현할 수 없으므로, 이번 검증은 "코드가 요청 간 서버 로컬 상태에 의존하지 않음"을 코드 리뷰 + 로컬 E2E로 확인한 것이다. 배포 후 실제 다중 인스턴스 환경에서의 최종 확인이 필요하다.
