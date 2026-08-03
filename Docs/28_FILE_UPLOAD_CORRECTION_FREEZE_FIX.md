# 28. 파일 선택 업로드 시 화면 완전 정지 - 원근보정 다운스케일 누락

## 증상

[[27_ROI_MISALIGNMENT_CONFIRMED_ROOT_CAUSE_AND_FIX]] 배포 직후, "파일 선택"으로 선별검사지 이미지를 업로드하자 웹페이지 전체가 완전히 멈췄다. 개발자도구도 안 열릴 정도로 브라우저 렌더링 프로세스 자체가 응답하지 않았다.

## 원인

`processSelectedFile`(파일 선택 업로드용 원근보정 함수)이 선택한 이미지를 **원본 해상도 그대로** 캔버스에 그린 뒤 OpenCV의 `detectDocumentQuad`(Canny 엣지 검출 + 윤곽선 검출, 전부 동기적으로 메인 스레드에서 실행)를 돌렸다. 실제 스마트폰 사진은 보통 8~12메가픽셀(4000×3000 이상)인데, 이 정도 크기 이미지에 대해 WASM 기반 OpenCV 연산을 메인 스레드에서 동기 실행하면 수십 초까지도 UI 전체가 블로킹될 수 있다 — 이게 "화면이 완전히 멈추고 개발자도구도 안 켜지는" 증상의 정체다.

카메라 촬영 경로(`captureCurrentFrame`)는 이 문제를 겪지 않았는데, `getUserMedia`가 애초에 최대 1600×1200(약 2메가픽셀)로 스트림 해상도를 제한하기 때문이다. 파일 선택 경로에는 이런 자연스러운 상한이 없었다.

## 수정

`src/components/ImageUploadPanel.tsx`에 `MAX_DETECTION_DIMENSION = 1600` 상수를 추가하고, `processSelectedFile`에서 캔버스에 그리기 전에 긴 변 기준으로 1600px를 넘지 않도록 축소 비율을 계산해 적용했다. OpenCV 사각형 검출과 투영변환 모두 이 축소된 캔버스를 사용하므로 좌표계는 그대로 일관되게 유지된다. 보정 결과물의 최종 출력 해상도는 원래도 `template.baseSize * PERSPECTIVE_CORRECTION_SCALE`로 고정되어 있어(카메라 경로와 동일), 입력을 1600px로 낮춰도 최종 품질에는 영향이 없다. 사각형 검출에 실패했을 때의 폴백 경로는 지금처럼 원본 파일을 그대로 업로드한다(축소되지 않은 원본 화질 유지, 이후 `uploadSingleFile`의 `shrinkImageFileIfNeeded`가 필요시 용량만 줄임).

이번 수정은 원인이 명확하고 범위가 작아 코덱스를 거치지 않고 직접 수정했다 — 사용자가 화면이 멈춰 즉시 조치가 필요한 상황이었다.

`npm test`(37/37), `npm run build` 통과 확인.
