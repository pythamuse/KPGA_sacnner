# 31. 원근보정 Web Worker 전환 설계

[[30_PERSPECTIVE_CORRECTION_HANG_INVESTIGATION]]의 권장 후속 조치를 구체화한 설계.

## 목표

`loadOpenCv`/`detectDocumentQuad`/`warpToRectangle`를 메인 스레드가 아닌 **별도 Web Worker**에서 실행해서, 설령 그 안에서 (원인 불명의) 행이 다시 발생하더라도:
1. 메인 스레드(화면·입력 처리)는 계속 응답한다.
2. 일정 시간 내에 끝나지 않으면 `worker.terminate()`로 강제 종료할 수 있다 — 지금까지 쓰던 `withTimeout`은 프로미스가 "느리게" 끝나는 경우만 방어할 뿐, 메인 스레드 자체가 멈추는 경우는 전혀 못 막았다. Worker 종료는 진짜 강제성이 있다.

## 아키텍처

### 파일 구성

1. **`src/lib/documentScanner/perspectiveCorrect.worker.ts`** (신규, Worker 컨텍스트에서 실행)
   - `importScripts('https://docs.opencv.org/4.9.0/opencv.js')`로 opencv.js를 로드한다(Worker의 동기 스크립트 로딩 — 워커 스레드를 블로킹해도 메인 스레드는 영향 없음, 오히려 원하는 동작).
   - `cv['onRuntimeInitialized']`를 기다렸다가 준비 완료 메시지를 메인 스레드로 보낸다(선택 사항, 워커 생성 시 1회).
   - `self.onmessage`로 다음 형태의 요청을 받는다: `{ type: 'correct', requestId, bitmap: ImageBitmap, outputWidth, outputHeight }` (`bitmap`은 메인 스레드에서 `postMessage(msg, [bitmap])`로 **전송(transfer)** 받는다 — 복사 없이 소유권만 넘어옴).
   - 처리: `OffscreenCanvas`에 `bitmap`을 그려 `ImageData`를 얻고 → `cv.matFromImageData(imageData)`로 Mat 생성(기존 `cv.imread(canvas)` 대신, DOM `<canvas>`가 없는 Worker 환경에서도 동작) → 기존 `detectDocumentQuad`/`warpToRectangle`와 동일한 로직(그레이스케일 → 블러 → Canny → findContours → 컨투어 순회 → 사각형 판정 → 투영변환 → 워프)을 그대로 수행 → 결과를 `OffscreenCanvas.convertToBlob({type:'image/jpeg', quality:0.88})`로 Blob 생성.
   - 결과를 `{ type: 'result', requestId, ok: true, blob }` 또는 실패 시 `{ type: 'result', requestId, ok: false }`로 `postMessage`한다(Blob은 구조화 복제 가능, transfer 불필요).
   - 기존 `src/lib/documentScanner/perspectiveCorrect.ts`의 `detectDocumentQuad`/`orderQuadPoints`/`warpToRectangle` 로직을 그대로 재사용하되, `cv.imread(canvas)`/`cv.imshow(canvas, mat)`처럼 DOM `<canvas>`를 직접 받는 부분만 `ImageData`/`OffscreenCanvas` 기반으로 바꾼 버전을 워커 전용으로 둔다(기존 파일의 순수 로직은 그대로 두고, Worker에서 쓸 얇은 어댑터만 새로 작성 — `orderQuadPoints`는 opencv 비의존 순수 함수라 그대로 import해서 재사용 가능).

2. **`src/lib/documentScanner/perspectiveCorrectClient.ts`** (신규, 메인 스레드에서 실행)
   - Worker 인스턴스를 지연 생성·캐싱한다: `new Worker(new URL('./perspectiveCorrect.worker.ts', import.meta.url))` (Next.js 14/webpack5가 네이티브로 지원하는 패턴, 별도 워커 로더 설정 불필요).
   - `correctImage(bitmap: ImageBitmap, outputWidth: number, outputHeight: number, timeoutMs: number): Promise<Blob | null>` 함수를 export한다:
     - 요청 ID를 발급하고 워커에 메시지를 보낸다(`bitmap`은 transfer).
     - `Promise.race`로 (a) 워커의 응답 메시지, (b) `setTimeout(timeoutMs)` 둘 중 먼저 오는 것을 기다린다.
     - **타임아웃이 먼저 발생하면 `worker.terminate()`를 호출해 워커를 강제 종료하고, 다음 호출을 위해 워커 참조를 초기화(null)해서 다음 호출 시 새 워커를 만들도록 한다** — 이게 지금까지 없던 진짜 안전장치다.
     - 정상 응답이면 `blob`을 반환, 실패/사각형 미검출이면 `null`을 반환(호출부는 지금처럼 원본 업로드로 폴백).

3. **`src/components/ImageUploadPanel.tsx`** 수정
   - `captureCurrentFrame`(카메라)과 `processSelectedFile`(파일 선택) 양쪽에서, 지금 메인 스레드에서 직접 하던 `loadOpenCv()` → `detectDocumentQuad()` → `warpToRectangle()` 호출을 `perspectiveCorrectClient.correctImage(...)` 호출 하나로 교체한다.
   - 캔버스를 그대로 넘기던 부분은 `createImageBitmap(canvas)` 또는 이미 갖고 있는 `ImageBitmap`을 활용해 워커로 넘길 `ImageBitmap`을 준비하는 방식으로 바꾼다.
   - 응답으로 받은 `Blob`을 `URL.createObjectURL`로 미리보기 `previewSrc`를 만들거나(또는 `FileReader`로 data URL 변환), `correctionPreview` 상태에 저장하는 흐름은 최대한 지금과 동일하게 유지한다.
   - **`PERSPECTIVE_CORRECTION_ENABLED` 플래그는 이번 전환이 실기기에서 충분히 검증되기 전까지 `false`로 유지한다.** 구현은 플래그 뒤에서 이루어지고, 검증 후 별도로 `true`로 전환하는 커밋을 만든다.
   - 타임아웃 값은 기존 5초보다 넉넉하게(예: 8~10초) 잡는다 — 워커는 메인 스레드를 막지 않으므로 조금 더 기다려도 사용자 경험에 지장이 없다.

### 기존 `src/lib/documentScanner/perspectiveCorrect.ts`, `loadOpenCv.ts`

메인 스레드용 코드는 그대로 둔다(당장 다른 곳에서 참조하지 않는다면 사용되지 않는 채로 남아도 무방 — 추후 완전히 Worker로만 처리하기로 확정되면 정리). `orderQuadPoints`처럼 순수 로직인 부분만 워커 어댑터에서 재사용한다.

## 검증 계획

1. `npm test`/`npm run build` — 기존과 동일하게 통과 확인.
2. **로컬 개발 서버에서 이번에 행을 재현했던 정확한 시나리오(1200×900 합성 이미지, 파일 선택 업로드)로 재현 시도** — 이번엔 워커가 멈추더라도 메인 스레드(탭 제목 갱신, `1+1` 즉시 응답 등)가 계속 살아있는지 확인한다. 워커가 실제로 멈추면 그것 자체는 별개 문제로 남지만, **적어도 화면 자체는 안 죽어야 한다**는 게 이번 전환의 핵심 성공 기준이다.
3. 워커가 실제로 사각형을 정상 검출·보정하는지도 확인(이전에 격리 테스트에서 이미 로직 자체는 정상 동작을 확인했으므로, Worker 컨텍스트로 옮겨도 같은 결과가 나오는지 재확인).
4. 위 검증이 다 통과하면 `PERSPECTIVE_CORRECTION_ENABLED`를 `true`로 바꾸는 별도 커밋을 만들고, 배포 후 실기기 재테스트를 요청한다.
