# 22. 모바일 촬영 원근 보정 - 구현 결과

관련 문서: [[21_MOBILE_CAPTURE_PERSPECTIVE_CORRECTION_DESIGN]]에서 설계한 방식(B안: 촬영 직후 클라이언트에서 OpenCV.js로 문서 경계 검출 + 투영변환 보정 + 확인/재촬영 UI)의 구현 결과.

## 구현 내용

- `src/lib/documentScanner/loadOpenCv.ts` (신규): opencv.js(`https://docs.opencv.org/4.9.0/opencv.js`)를 카메라 촬영 흐름이 시작될 때만 동적 `<script>` 삽입으로 지연 로드. 로딩 프로미스를 캐싱해 중복 로드 방지.
- `src/lib/documentScanner/perspectiveCorrect.ts` (신규): `detectDocumentQuad`(그레이스케일→블러→Canny→윤곽선 검출→최대 사각형 컨투어 근사, 전체 면적의 20% 미만은 노이즈로 제외), `orderQuadPoints`(4점을 좌상/우상/우하/좌하로 정렬하는 순수 함수, opencv 비의존), `warpToRectangle`(투영변환 계산 및 워프). 모든 `cv.Mat`/`cv.MatVector`를 `try/finally`로 명시적으로 `.delete()`해 WASM 메모리 누수를 방지.
- `src/components/ImageUploadPanel.tsx`: `captureCurrentFrame`이 원본 프레임을 캔버스에 그린 뒤, `withTimeout`으로 5초 제한을 두고 OpenCV 보정을 시도. 사각형 검출에 성공하면 즉시 업로드하지 않고 보정된 이미지를 미리보기로 보여주며 "이대로 사용"/"다시 촬영" 확인을 받는다. 검출 실패·타임아웃·로드 실패 시엔 기존과 동일하게 원본 프레임을 그대로 업로드(무조건 폴백, 기능 저하 없음). 파일 선택 업로드 경로와 서버 인식 코드는 건드리지 않음(설계 문서의 1차 범위와 일치).
- `tests/perspective-correct.test.ts` (신규): `orderQuadPoints`에 대한 순수 로직 단위 테스트 3건 (정렬된 사각형, 뒤섞인 사각형, 회전된 사각형 순서).

구현은 Codex CLI(GPT-5.5, `--dangerously-bypass-approvals-and-sandbox`)에 위임했다. 결과 리뷰 중 사소한 코드 중복(업로드 성공 후 카메라 단계 전환 로직이 신규 헬퍼 `advanceCameraFlowAfterUpload`와 폴백 경로에 각각 따로 존재)을 발견해 직접 정리했다. 그 외 핵심 알고리즘(OpenCV 파이프라인, 좌표 정렬, 투영변환, 메모리 정리)은 표준적인 문서 스캐너 구현 패턴을 정확히 따르고 있어 수정 없이 그대로 채택했다.

## 검증

### 자동 테스트

```
npm test
```
10개 파일 37개 테스트 전부 통과 (신규 `orderQuadPoints` 테스트 3건 포함).

```
npm run build
```
타입 체크 및 프로덕션 빌드 성공. 메인 페이지 First Load JS는 13.3 kB로, opencv.js가 정적 번들에 포함되지 않고 실제로 지연 로드되도록 구성되었음을 확인.

### 브라우저 검증 (제한적)

로컬 dev 서버에서 "개별/순차 촬영" → "촬영하기" 클릭까지는 콘솔 에러 없이 정상 진행됨을 확인했다. 다만 샌드박스 브라우저 환경은 실제 카메라 장치가 없어 `getUserMedia` 요청이 차단되고, 그 이후(실제 프레임 캡처, OpenCV 사각형 검출, 투영변환, 보정 미리보기 UI)는 브라우저 자동화로 검증할 수 없었다.

## 한계 및 후속 확인 필요 사항

- **실기기 검증 필수**: 이번 검증은 코드 리뷰 + 정적 테스트 + "카메라 권한 요청까지는 정상 동작"만 확인한 것이다. 실제 조명·손떨림·각도 조건에서 사각형 검출이 제대로 되는지, 보정 후 이미지가 서버 인식 파이프라인에서 올바르게 판정되는지는 사용자가 실제 모바일 기기로 재테스트해야 확인 가능하다.
- opencv.js 최초 로드는 네트워크 상황에 따라 5초 타임아웃에 걸려 보정 없이 원본이 업로드될 수 있다. 두 번째 촬영(만족도조사) 시점에는 보통 이미 로드가 끝나 있을 가능성이 높다.
- 파일 선택 업로드 경로, 서버사이드 보정(설계 문서의 C안)은 이번 범위에 포함하지 않았다.
