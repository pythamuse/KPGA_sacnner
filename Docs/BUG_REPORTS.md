# BUG_REPORTS — 버그 색인

각 항목은 원인과 대응만 짧게 기록한다. 조사 과정·테스트 결과·후속 피드백 등 전체 맥락은 연결된 Task 문서를 참고할 것. 새 버그는 이 표에 한 줄 추가 + 아래 상세(3~6줄 이내)로 기록한다. 문서 작성 규칙은 [README.md](../README.md) 참고.

| # | 제목 | 상태 | 관련 Task |
|---|---|---|---|
| 1 | PDF 일괄 스캔 중 특정 페이지에서 영구 멈춤(JBIG2) | 부분 해결 | [PDF_BATCH_RENDER_HANG](../Task/PDF_BATCH_RENDER_HANG.md) |
| 2 | Vercel 인스턴스 간 `/tmp` 미공유로 저장/다운로드/이미지 미리보기 404 | 해결 | [STATELESS_ARCHITECTURE_MIGRATION](../Task/STATELESS_ARCHITECTURE_MIGRATION.md) |
| 3 | `data:` URI를 새 탭(top frame)으로 열 때 브라우저 차단 | 해결(재확인 필요) | [STATELESS_ARCHITECTURE_MIGRATION](../Task/STATELESS_ARCHITECTURE_MIGRATION.md) |
| 4 | 성인 트랙 "연령대" crop 미리보기가 청소년 ROI 좌표 사용 | 미해결 | [STATELESS_ARCHITECTURE_MIGRATION](../Task/STATELESS_ARCHITECTURE_MIGRATION.md) |
| 5 | 휴대폰 촬영 사진이 실제와 다른 양식으로 오판정 | 해결(실사용자 재현 파일로는 미검증) | [MOBILE_PHOTO_MISCLASSIFICATION_FIX](../Task/MOBILE_PHOTO_MISCLASSIFICATION_FIX.md) |
| 6 | 카메라 미리보기 검은 화면 및 촬영 버튼 무반응 | 해결(실기기 확인) | [CAMERA_UPLOAD_ROBUSTNESS_FIXES](../Task/CAMERA_UPLOAD_ROBUSTNESS_FIXES.md) |
| 7 | 카메라/파일 업로드 경로에 용량 초과(413) 방어 누락 | 구현됨(검증 기록 없음) | [CAMERA_UPLOAD_ROBUSTNESS_FIXES](../Task/CAMERA_UPLOAD_ROBUSTNESS_FIXES.md) |
| 8 | ROI 좌표 기반 문항 인식이 실제 사진에서 엉뚱한 행을 읽음 | 부분 해결(재검증 필요) | [MOBILE_CAPTURE_PERSPECTIVE_CORRECTION](../Task/MOBILE_CAPTURE_PERSPECTIVE_CORRECTION.md), [RECOGNITION_ACCURACY_DYNAMIC_ROW_DETECTION](../Task/RECOGNITION_ACCURACY_DYNAMIC_ROW_DETECTION.md) |
| 9 | 파일 업로드 원근보정 도입 후 웹페이지 전체 프리징 | 해결(근본 메커니즘은 미규명) | [MOBILE_CAPTURE_PERSPECTIVE_CORRECTION](../Task/MOBILE_CAPTURE_PERSPECTIVE_CORRECTION.md) |
| 10 | OCR 앵커 도입 후 `/api/recognize`가 184초까지 걸림 | 완화(후속 조정 완료, 실배포 재측정 필요) | [OCR_ANCHORED_ROW_DETECTION](../Task/OCR_ANCHORED_ROW_DETECTION.md) |
| 11 | 종이 경계 검출 실패 상태에서도 ROI 후보가 자동값으로 확정될 수 있음 | 해결(경계 불확실 시 자동 확정 차단) | [OCR_ANCHORED_ROW_DETECTION](../Task/OCR_ANCHORED_ROW_DETECTION.md) |
| 12 | 실사용 촬영 이미지에서 원근 보정 후에도 문서 좌표가 어긋남 | 분석 완료, 후속 구현 필요 | [DOCUMENT_SCAN_STRATEGY_REVIEW](../Docs/14_DOCUMENT_SCAN_STRATEGY_REVIEW.md) |

---

## 1. PDF 일괄 스캔 중 특정 페이지에서 영구 멈춤(JBIG2)

**원인**: pdf.js의 순수 JS JBIG2 디코더가 특정 스캐너 인코딩 방식의 이미지에서 `page.render()`를 무한 대기시킴.
**대응**: pdf.js를 3.4.120 → 6.1.200(ESM)으로 업그레이드해 대부분의 페이지는 해결됐으나, JBIG2 인코딩 페이지는 여전히 재현됨. 페이지별 타임아웃(`withTimeout.ts`)으로 증상만 완화 중.
**상태**: 부분 해결 — 근본 해결은 서버 사이드 렌더링(poppler/mupdf/pdfium) 전환 후속 과제로 남음.

## 2. Vercel 인스턴스 간 `/tmp` 미공유로 저장/다운로드/이미지 미리보기 404

**원인**: 작업 세션·업로드 이미지·엑셀 사본을 인스턴스 로컬 `/tmp`에만 저장 — 요청이 다른 서버리스 인스턴스로 라우팅되면 파일이 없어 404.
**대응**: 클라이언트가 매 저장/다운로드 요청마다 확정 학생 전체 목록을 함께 전송하고, 서버는 매번 번들 템플릿에서 새로 생성하는 무상태 설계로 전환. 이미지 미리보기도 `/api/recognize` 응답에 data URI로 직접 포함.
**상태**: 해결.

## 3. `data:` URI를 새 탭(top frame)으로 열 때 브라우저 차단

**원인**: 무상태 전환으로 검수 화면 이미지가 `data:` URI가 되었는데, "새 탭에서 크게 보기" 링크가 여전히 `<a href={dataUri} target="_blank">` 형태 — 브라우저가 피싱 방지를 위해 data URI의 top-frame 탐색을 스펙상 차단.
**대응**: 클릭 시 data URI를 Blob으로 변환해 `URL.createObjectURL()`로 만든 Blob URL로 새 탭을 염.
**상태**: 해결로 기록되어 있으나 별도 검증 기록이 없음 — 재확인 권장.

## 4. 성인 트랙 "연령대" crop 미리보기가 청소년 ROI 좌표 사용

**원인**: crop API가 트랙 구분 없이 청소년 전용 좌표(`cagiTemplate`)에서만 영역을 찾음. 성인 트랙엔 별도 ROI가 없어 엉뚱한 영역을 200 OK로 잘라 보여줌.
**대응**: 미착수.
**상태**: 미해결 — 성인 ROI 좌표가 정의되기 전까지는 `track === 'adult'`일 때 `basic.age` crop 미리보기 자체를 숨기는 처리 필요.

## 5. 휴대폰 촬영 사진이 실제와 다른 양식으로 오판정

**원인**: 카메라 사진의 원근왜곡으로 종이 테두리 검출(`detectFrameBounds`)이 실패하면, 내용 기반 양식판정이 신뢰할 수 없는 좌표로 점수를 매겨 파일명 힌트(사용자가 선택한 업로드 칸)를 잘못 뒤집음.
**대응**: 테두리 검출 실패(`contentBoundsConfident === false`) 시 내용 기반 판정을 건너뛰고 파일명 힌트를 그대로 신뢰하도록 변경.
**상태**: 해결(코드 검증 완료). 실제 문제를 일으켰던 원본 사진 파일이 보존되지 않아 그 파일로는 재검증 못함.

## 6. 카메라 미리보기 검은 화면 및 촬영 버튼 무반응

**원인**: `<video>`의 `srcObject`를 명령형으로 대입 후 `video.play()`를 호출하지 않아 일부 브라우저에서 영상이 재생되지 않음. 이 상태에서 캡처 시 발생하는 예외도 처리되지 않아 버튼이 무반응처럼 보임.
**대응**: `play()` 명시적 호출 + reject 처리, 캡처 전 `readyState`/`videoWidth` 체크, `captureCurrentFrame`에 `catch` 절 추가.
**상태**: 해결(2026-08-02 실기기 재테스트로 확인).

## 7. 카메라/파일 업로드 경로에 용량 초과(413) 방어 누락

**원인**: 업로드 용량 축소 로직이 PDF 변환 경로에만 있고, 카메라 촬영·파일 직접 선택 업로드 경로에는 없어 대용량 사진에서 Vercel 요청 본문 제한(413)에 걸림.
**대응**: 공용 업로드 지점(`uploadSingleFile`)에 공통 용량 축소 헬퍼 적용, 에러 메시지에서 PDF 전제 문구 제거.
**상태**: 구현됨 — 별도 테스트/검증 기록이 없어 재확인 필요.

## 8. ROI 좌표 기반 문항 인식이 실제 사진에서 엉뚱한 행을 읽음

**원인**: 페이지 경계(`detectContentBounds`/`detectFrameBounds`) 추정이 실제 촬영/스캔 사진에서 크게 틀리면, `roiTemplates.ts`의 모든 고정 비율 좌표가 통째로 밀려 완전히 다른 행/섹션을 읽음(실제 ROI 디버그 스크린샷으로 확인 — 예: CAGI 문항 4가 문항 8-9 라벨 위치를 읽음).
**대응**: (1) 원근 보정을 파일 선택 업로드 경로까지 확장, (2) 보완책으로 이미지에서 실제 가로 분리선을 감지해 문항 행 위치를 동적으로 재계산하는 서버 사이드 검출 도입.
**상태**: 부분 해결 — 두 대응 모두 안전성은 확인됐으나 실제 정확도 개선 폭은 실사용 이미지로 재검증 필요.

## 9. 파일 업로드 원근보정 도입 후 웹페이지 전체 프리징

**원인**: 메인 스레드에서 실행된 OpenCV 보정 파이프라인이 실제 앱 이벤트 핸들러 컨텍스트 안에서 설명되지 않은 이유로 완전한 동기적 블로킹을 일으킴(격리된 브라우저 탭에서는 재현 안 됨, `Promise.race` 기반 타임아웃으로도 방어 불가능한 진짜 메인 스레드 블록).
**대응**: 보정 파이프라인 전체를 Web Worker로 격리하고, 타임아웃 시 실제 `worker.terminate()`로 강제 종료 가능하도록 재구현.
**상태**: 해결(메인 스레드 응답성은 heartbeat 테스트로 실증). 격리 탭과 실제 앱 컨텍스트 사이 차이의 정확한 메커니즘 자체는 끝내 규명하지 못함.

## 10. OCR 앵커 도입 후 `/api/recognize`가 184초까지 걸림

**원인**: 새로 추가한 OCR 텍스트 앵커 탐지(`detectOcrTextLines`)가 개별 연산(워커 초기화, 인식)마다 60초 타임아웃을 걸어뒀지만, 요청 전체에 대한 상한이 없었다. Vercel 서버리스 컨테이너는 로컬과 달리 매 요청마다 콜드 스타트를 겪을 수 있고, 한 요청 안에서 이 함수가 최대 3번(CAGI 표 1회 + 만족도 그룹 2회) 호출되어 지연이 배가됐다.
**대응**: (1) 개별 60초 타임아웃 2개를 요청 하나당 6초 예산으로 통합. (2) 같은 컨테이너 안에서 이미 진행 중인 워커 초기화가 안 끝났다면 이후 호출은 재대기 없이 즉시 폴백하도록 변경.
**추가 대응**: 픽셀 행 검출을 OCR보다 먼저 실행하고, OCR 전체 예산을 2.5초로 축소했으며, 동일 이미지·크롭의 OCR 결과를 캐시한다.
**상태**: 완화됨(184초 → 21.7초 → 9.76초 측정 이후 추가 조정). 후속 배포에서 처리 시간과 실제 행 보정 효과를 재측정해야 한다.

## 11. 종이 경계 불확실 상태에서 ROI 값 자동 확정

**원인**: `detectFrameBounds`가 실패해 `detectDarkPixelBounds`로 대체된 경우에도 `recognizeStudentForms`가 정규화 ROI를 계속 채점했다. 후보 점수만 우연히 높아져도 실제 위치와 다른 값이 자동 확정될 가능성이 있었다.
**대응**: 프레임 크기·여백·종횡비 검증을 추가하고, `contentBoundsConfident === false`이면 후보 점수와 low confidence만 전달한다. 자동값은 확정하지 않으며 검수 화면에 원본 대조 안내를 표시한다. 조기개입 ROI 감지도 같은 조건에서 건너뛴다.
**상태**: 코드 및 합성 회귀 테스트 완료. 실제 휴대폰 사진과 배포본에서는 재검증 필요.

## 12. 실사용 촬영 이미지에서 원근 보정 후에도 문서 좌표가 어긋남

**재현 샘플**: 사용자가 제공한 `만족도조사.jpg`, `선별검사지.jpg`와 결과 화면.

**관찰**: 두 사진 모두 문서 전체가 대체로 프레임 안에 있으나 기울기, 그림자, 낮은 외곽선 대비, 종이 휨이 함께 있다. 결과 화면에서 기본정보 일부가 비어 있거나 잘못 선택되고, CAGI 문항 crop이 실제 문항 행과 일치하지 않는다.

**추정 원인**: 현재 보정은 Canny/contour에서 가장 큰 convex 4점 사각형 하나를 선택한다. 문서 내부 표가 페이지 외곽보다 선명하거나 페이지 외곽이 끊기면 내부 사각형을 문서로 선택할 수 있다. 보정 결과가 생성되면 후보 품질 점수와 템플릿 일치 검증 없이 사용되며, homography는 종이 휨과 렌즈 왜곡을 해결하지 못한다.

**대응 방향**: 문서 외곽 후보를 여러 개 생성하고 템플릿 종횡비·각도·면적·변 연속성·여백·내부 표와의 구분으로 점수화한다. 저신뢰 결과는 자동 확정하지 않고 재촬영 또는 네 모서리 수동 조정으로 보낸다. 카메라 경로에는 안정 프레임 기반 자동 촬영을 보조 기능으로 추가한다.

**상태**: 원인 범주와 설계 방향 분석 완료. 후보 점수화, 품질 게이트, 수동 조정, 자동 촬영은 후속 구현 및 실사용 샘플 검증이 필요하다. 세부 내용은 [Docs/14_DOCUMENT_SCAN_STRATEGY_REVIEW.md](14_DOCUMENT_SCAN_STRATEGY_REVIEW.md)를 참고한다.
