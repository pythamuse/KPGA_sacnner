# 29. 원근보정 기능 완전 행(hang) - 긴급 비활성화

## 증상

[[28_FILE_UPLOAD_CORRECTION_FREEZE_FIX]] 배포 직후에도 파일 선택 업로드 시 웹페이지 전체가 완전히 멈추는 문제가 재현됐다. 사용자가 재현했고, 내가 직접 브라우저 자동화로 격리 테스트해 확인했다.

## Docs/28 진단이 틀렸음을 확인

Docs/28은 "원본 해상도 그대로 OpenCV 검출을 돌려서 느리다"는 가설로 1600px 다운스케일을 적용했다. 하지만 실제로 격리 테스트한 결과:

1. **opencv.js 자체는 327ms 만에 빠르게 로드·초기화됨** — 로딩 자체는 병목이 아니다.
2. **1600px보다 훨씬 작은 이미지(1200×900)로도 똑같이 완전히 멈춘다** — 즉 이미지 크기와 무관하게 `detectDocumentQuad`/`warpToRectangle` 호출 자체에 진짜 버그(무한 행 또는 심각하게 긴 지연)가 있다.

Docs/28의 다운스케일 자체는 방향은 맞았지만(입력을 줄이는 건 여전히 합리적인 방어책), 실제 행의 원인은 아니었다.

## 조치: 즉시 비활성화

정확한 원인을 아직 특정하지 못했고, 이 버그는 **복구 불가능한 완전 정지**(개발자도구도 안 열림)를 일으키는 최고 심각도 문제이므로, 원인을 더 조사하는 동안 기능 자체를 끄는 것이 맞다고 판단했다.

`src/components/ImageUploadPanel.tsx`에 `PERSPECTIVE_CORRECTION_ENABLED = false` 상수를 추가하고, `captureCurrentFrame`(카메라)과 `processSelectedFile`(파일 선택) 양쪽의 `detectDocumentQuad`/`warpToRectangle` 호출을 이 플래그로 감쌌다. 비활성화 상태에서는 두 경로 모두 [[21_MOBILE_CAPTURE_PERSPECTIVE_CORRECTION_DESIGN]] 도입 이전과 동일하게 원본 이미지를 그대로 업로드한다 — 검증된 안전한 상태로 되돌린 것이다.

## 남은 과제

- `detectDocumentQuad`/`warpToRectangle`(`src/lib/documentScanner/perspectiveCorrect.ts`)이 왜 작은 이미지에서도 멈추는지 근본 원인을 아직 모른다. 코드 리뷰상 명백한 무한루프는 안 보였다 — WASM 메모리/컨텍스트 관련 문제이거나, opencv.js의 이 특정 빌드·버전과 이 배포 환경(Vercel + 특정 브라우저 조합)의 상호작용 문제일 가능성이 있다.
- [[26_RECOGNITION_ARCHITECTURE_REDESIGN_OPTIONS]]에서 A안(자체 처리)을 확정했지만, 이번 사고로 클라이언트 OpenCV.js 기반 접근 자체의 안정성에 의문이 생겼다. 재활성화 전에 반드시: (1) 근본 원인을 밝히고, (2) Web Worker로 격리해 최악의 경우에도 메인 스레드는 멈추지 않도록 하는 등 안전장치를 추가하는 방안을 검토해야 한다.
- 이 비활성화로 [[27_ROI_MISALIGNMENT_CONFIRMED_ROOT_CAUSE_AND_FIX]]에서 확인한 원근보정의 정확도 개선 효과도 당분간 받을 수 없다 — 즉 실제 인식 정확도 문제는 여전히 미해결 상태로 남는다.
