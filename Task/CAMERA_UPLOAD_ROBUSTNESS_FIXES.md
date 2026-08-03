# 카메라/업로드 경로 안정성 수정 (검은 화면, 용량 초과 방어)

> 이 문서는 기존 `Docs/23_CAMERA_PREVIEW_BLACK_SCREEN_AND_CAPTURE_FREEZE.md`,
> `Docs/24_UPLOAD_SIZE_LIMIT_MISSING_ON_CAMERA_AND_FILE_PATHS.md`를 통합한 문서입니다.
> 두 사이클 모두 [[MOBILE_CAPTURE_PERSPECTIVE_CORRECTION]] 작업과 무관하게 이전부터 있던
> 별개의 잠재 버그로, 같은 실기기 테스트 라운드에서 함께 발견되었습니다.

## 사이클 1 — 카메라 미리보기 검은 화면 및 촬영 버튼 무반응

### 작업 내용

**증상**: 모바일과 데스크톱 웹 양쪽에서 재현(기기 문제가 아니라 코드 문제). "개별/순차 촬영" 모드에서 카메라 권한 요청은 통과하고 "1/2 선별검사지 촬영" 화면까지 뜨지만, 라이브 카메라 미리보기 영역이 완전히 검은 화면이고 "촬영하기" 버튼을 눌러도 아무 반응이 없다.

**원인**: `src/components/ImageUploadPanel.tsx`가 `<video>`의 `srcObject`를 명령형으로 대입만 하고(`autoPlay` 속성은 있지만) 명시적으로 `video.play()`를 호출하지 않는다. 여러 브라우저(특히 스트림을 나중에 명령형으로 붙이는 경우)에서는 `autoplay` 속성만으로 재생이 보장되지 않아, 영상이 첫 프레임도 그리지 않고 정지된 채로 남을 수 있다. `.camera-live-frame`의 검은 배경(`#111111`)이 그대로 보이는 것 — CSS 버그가 아니라 "영상이 재생을 시작한 적이 없다"는 증거.

영상이 재생되지 않으면 `video.videoWidth/Height`가 0이거나 `readyState`가 낮게 남는데, 이 상태에서 `captureCurrentFrame`이 `context.drawImage(video, ...)`를 호출하면 `InvalidStateError`가 발생할 수 있다. 이 예외는 어디서도 잡히지 않아(`try { ... } finally { setIsCapturing(false) }`만 있고 `catch` 없음) 콘솔에만 남고 사용자에게는 아무 메시지도 뜨지 않는다 — 이것이 "버튼을 눌러도 아무 반응이 없다"의 정체.

지금까지의 테스트가 전부 파일 선택/`DataTransfer` 주입 방식으로만 진행되어 실제 `getUserMedia` + 라이브 비디오 렌더링 경로를 한 번도 통과하지 않았기 때문에(샌드박스 브라우저는 카메라 접근 차단) 이전부터 있었을 이 버그가 지금까지 발견되지 않았던 것으로 보인다.

**수정 (코덱스 위임)**:
1. `srcObject` 대입 직후 명시적으로 `video.play()` 호출, 반환 프로미스의 reject 처리(콘솔 경고 + `setCameraError`).
2. `captureCurrentFrame`에서 `drawImage` 전에 `video.readyState >= 2`, `video.videoWidth > 0` 확인. 준비 안 됐으면 캡처 중단 + "카메라 화면이 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요." 안내.
3. `captureCurrentFrame` 전체를 감싸는 `try/finally`에 **`catch` 절 추가** — 어떤 이유로든 예외가 발생하면 `setCameraError`로 사용자에게 알림. 이번 버그뿐 아니라 앞으로 비슷한 "버튼 무반응" 사고를 막는 일반 안전장치.

### 테스트 결과

**2026-08-02 실기기 재테스트로 확인** — 카메라 미리보기 정상 표시, 촬영 버튼 정상 반응. 원인 진단과 수정이 유효했음이 실증됨.

### 다음 작업을 위한 피드백

해결된 사례 — 후속 조치 없음.

## 사이클 2 — 카메라/파일 업로드 경로에 용량 초과(413) 방어 누락

### 작업 내용

**증상**: 컴퓨터 웹 환경에서 실제 촬영된 사진(약 5MB, JPG)을 "파일 선택"으로 직접 업로드하면 "업로드 파일 용량이 너무 큽니다. PDF를 더 낮은 해상도로 변환한 뒤 다시 시도해주세요." 에러 발생. 업로드한 건 PDF가 아니라 일반 이미지 파일인데 메시지가 PDF를 가정하고 있어 혼란.

**원인**:
- 413의 실제 원인: `src/app/api/upload/route.ts`에 자체 용량 체크가 없고, Vercel 서버리스 함수(Node.js 런타임)의 **요청 본문 크기 제한(기본 4.5MB)**에 걸려 라우트 코드 실행 전에 플랫폼이 반환하는 응답이다.
- 방어 로직이 PDF 변환 경로(`convertPdfToImages` → `renderPdfPageToFile`)에만 있다 — `MAX_UPLOAD_IMAGE_BYTES`(3.8MB) 초과 시 `PDF_RENDER_OPTIONS`(스케일·품질 3단계)로 순차 재시도. 반면 "파일 선택" 직접 업로드(`handleSequentialFileChange`, `handleBatchFileChange`)와 카메라 직접 촬영(`captureCurrentFrame` → `uploadCapturedCanvas`, `canvas.toBlob(..., 0.92)` 품질 고정)에는 이 안전장치가 전혀 없다. 즉 PDF 경로만 용량을 관리하고 나머지 두 경로는 관리하지 않는 설계 공백.

**수정 방향 (코덱스 위임)**:
1. 재사용 가능한 헬퍼: `File`이 `MAX_UPLOAD_IMAGE_BYTES`보다 크면 캔버스에 다시 그려 품질/해상도를 낮춰 재인코딩(원본이 이미 그 이하면 그대로 반환), `PDF_RENDER_OPTIONS` 재시도 패턴 재사용.
2. 이 헬퍼를 **모든 업로드 경로의 공통 지점인 `uploadSingleFile`** 맨 앞에 적용해 PDF·카메라·파일선택 세 경로가 같은 안전장치를 거치도록 함.
3. `uploadSingleFile`의 413 에러 메시지를 PDF를 가정하지 않는 일반 문구로 변경.

### 테스트 결과

별도 "검증"/"테스트 결과" 기록이 남아있지 않다 — 구현 위임 내용만 기록되어 있고, 검증 완료 여부가 문서상 불명확.

### 다음 작업을 위한 피드백

- **용량 초과 방어 로직이 실제로 구현·검증이 끝났는지 재확인이 필요하다.** 카메라 촬영 또는 대용량 이미지 파일 선택 업로드로 413이 실제로 발생하지 않는지, 재인코딩 후 화질이 인식에 지장을 주지 않는지 다시 테스트할 것.
- "촬영 영역이 한쪽으로 쏠리는 현상"이 사이클 1의 재테스트 중 1회 관찰되었으나 재현되지 않아 코드 수정은 보류됨(`getUserMedia`의 `width:{ideal:1600}, height:{ideal:1200}` 가로 고정 제약이 유력 후보). 재현되면 정확한 재현 절차와 함께 새 사이클로 기록하고 그때 수정.
