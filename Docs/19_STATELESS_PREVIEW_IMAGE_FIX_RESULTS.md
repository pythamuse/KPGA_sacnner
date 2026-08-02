# 19. 검수 화면 이미지/크롭 미리보기 무상태화 - 구현 및 검증 결과

관련 문서: [[17_VERCEL_STATEFULNESS_AND_JBIG2_ISSUES]], [[18_STATELESS_SAVE_DOWNLOAD_FIX_RESULTS]]에서 이미 저장/다운로드 엔드포인트에 적용한 것과 동일한 원인·동일한 해법 패턴을 검수 화면의 이미지 미리보기에도 적용했다.

## 배경

사용자가 배포 환경에서 실제로 크롭 이미지를 클릭했을 때 원시 404 JSON 응답이 뜨는 화면을 스크린샷으로 제보했다. 원인은 `/api/uploads/crop`, `/api/uploads/image`가 `getJobDir(jobId)/uploads` 로컬 디스크 파일에 의존하는데, 이 파일은 `/api/upload`를 처리한 서버리스 인스턴스에만 존재하고 이후 이미지를 클릭하는 요청이 다른 인스턴스로 라우팅되면 파일을 찾지 못해 404가 발생하는, [[18_STATELESS_SAVE_DOWNLOAD_FIX_RESULTS]]에서 저장/다운로드에 대해 이미 고쳤던 것과 동일한 근본 원인이었다.

## 구현 내용

- `/api/recognize`는 업로드된 이미지 파일을 방금 그 파일이 쓰인 것과 같은 인스턴스에서 즉시 읽어 ROI 채점을 수행하므로, 이 시점에 원본 이미지 축소본과 필드별 크롭(일반/디버그 오버레이 두 종류)을 base64 data URI로 만들어 각 학생 드래프트의 `source`에 직접 실어 보내도록 바꿨다. 이후 검수 화면은 별도 요청 없이 이 data URI를 그대로 렌더링하므로 인스턴스 간 상태 공유 문제 자체가 사라진다.
- `src/lib/recognition/fieldCrop.ts` (신규): 기존 `/api/uploads/crop/route.ts`에 인라인으로 있던 크롭 영역 계산·이미지 추출·디버그 오버레이 로직을 재사용 가능한 함수(`findCropRect`, `generateFieldCropBuffer` 등)로 추출.
- `src/lib/recognition/buildSourcePreview.ts` (신규): `fieldCrop.ts`를 사용해 학생 한 명분(CAGI+만족도 이미지 쌍)의 원본 축소본 2장과 전체 필드(CAGI 13개 + 만족도 10개, 총 23개) 크롭을 일반/디버그 두 버전으로 생성해 data URI 묶음으로 반환.
- `src/app/api/recognize/route.ts`: 드래프트 생성 루프에서 `buildSourcePreview`를 호출해 결과를 `source`에 병합.
- `src/lib/recognition/detectCheckmarks.ts`: `RecognitionDraft.source`에 `cagiImageDataUrl`, `satisfactionImageDataUrl`, `cropDataUrls`, `cropDebugDataUrls` 필드 추가.
- `src/components/RecognitionReview.tsx`: `imageUrl`/`cropUrl` 헬퍼가 더 이상 `/api/uploads/*` URL을 만들지 않고 `draft.source`의 data URI를 직접 반환하도록 변경.
- `src/app/api/uploads/crop/route.ts`는 삭제하지 않고 유지했다 (같은 인스턴스에서 바로 접근하는 경우엔 여전히 동작하며, 내부적으로 `fieldCrop.ts`의 공용 함수를 재사용하도록만 바꿈). `/api/uploads/image/route.ts`도 변경 없이 유지.

구현은 Codex CLI(`codex exec`)에 위임했다. 이번 실행에서는 이 Windows 환경의 codex 샌드박스 헬퍼(`codex-windows-sandbox-setup.exe`)가 아예 없어 일반 `-s workspace-write` 모드로는 파일을 읽지도 못하고 두 번 실패했고, `--dangerously-bypass-approvals-and-sandbox` 플래그(사용자 승인 후 사용)로 재시도해서야 정상 동작했다. Codex가 만든 `src/app/api/uploads/crop/route.ts`의 404 에러 메시지 문자열에서 새로운 인코딩 깨짐(mojibake)이 발견되어 `'해당 필드의 crop 영역이 정의되어 있지 않습니다.'`로 직접 수정했다.

## 검증

### 자동 테스트

```
npm test
```

9개 파일 33개 테스트 전부 통과. `tests/integration.test.ts`의 recognize 테스트에 `recognizedDraft.source.cagiImageDataUrl`/`satisfactionImageDataUrl`이 `data:image/jpeg;base64,`로 시작하고 `cropDataUrls`가 비어있지 않은지 검증하는 assertion을 추가했다.

```
npm run build
```

타입 체크 및 프로덕션 빌드 성공.

### 브라우저 E2E 검증 (로컬 개발 서버)

1. 실제 폼 크기(474x656)와 유사한 합성 PNG 2장(CAGI/만족도)을 업로드해 검수 화면(`1 / 1번째 학생 데이터`, `확인 필요 항목 23개`)까지 도달.
2. 화면의 `<img>` 25개(원본 이미지 2장 + 필드 크롭 23장) 전부 `src`가 `data:` URI임을 DOM에서 직접 확인. `/api/uploads/...`로 시작하는 `<a href>`가 0개임을 확인.
3. 원본 이미지 축소본은 `naturalWidth/Height`가 실제 크기(474x656)로 정상 디코딩됨을 확인.
4. 필드 크롭 이미지는 화면에서 `loading="lazy"` 속성 때문에 뷰포트 밖에서는 `naturalWidth`가 0으로 보였으나, 같은 data URI를 별도 `Image()` 객체로 직접 로드했을 때 정상 디코딩(예: `basic.age` 크롭 83x65)되고 PNG 헤더의 width/height도 일치함을 바이트 단위로 직접 파싱해 확인 — 지연 로딩 특성일 뿐 실제 결함이 아님을 확인했다.
5. 이 검증 과정 전체(작업 생성 여러 번, 업로드, 인식 여러 회)에서 `/api/uploads/crop` 또는 `/api/uploads/image`로 가는 새 네트워크 요청이 한 번도 발생하지 않았음을 확인 (남아있던 요청 2건은 이 작업을 시작하기 전, 수정 이전 상태에서 있었던 요청이었다).
6. 콘솔 에러 0건.

## 결론

- [[17_VERCEL_STATEFULNESS_AND_JBIG2_ISSUES]]에서 남겨두었던 "크롭/원본 이미지 미리보기 404" 후속 과제를 해결했다. 이제 검수 화면 전체(값 검수, 저장, 다운로드)가 서버 로컬 상태에 의존하지 않는다.
- JBIG2 디코더 행 이슈는 이번 범위에서도 다루지 않았다 — 여전히 별도 후속 과제로 남아있다.
- 실제 Vercel 다중 인스턴스 환경 자체는 로컬 dev 서버로 재현할 수 없으므로, 이번 검증도 "코드가 요청 간 서버 로컬 상태에 의존하지 않는다"는 것을 코드 리뷰 + 로컬 E2E로 확인한 것이다.
