# 30. 원근보정 행(hang) 원인 조사 결과

[[29_PERSPECTIVE_CORRECTION_HANG_EMERGENCY_DISABLE]]에서 기능을 비활성화한 뒤, 정확한 원인을 찾기 위해 진행한 격리 조사 결과를 기록한다.

## 조사 방법

1. **OpenCV 파이프라인 각 단계를 개별 격리 테스트**: 새 브라우저 탭에서 opencv.js를 직접 로드하고, `cv.imread` → `cv.cvtColor` → `cv.GaussianBlur` → `cv.Canny` → `cv.findContours` → 컨투어 순회(`arcLength`/`approxPolyDP`/`isContourConvex`/`contourArea`) → `orderQuadPoints` → `cv.matFromArray` → `cv.getPerspectiveTransform` → `cv.warpPerspective` → `cv.imshow`까지, `detectDocumentQuad`/`warpToRectangle`가 실제로 하는 모든 연산을 하나씩 직접 호출하며 각 단계의 소요 시간을 측정했다.
   - **결과: 전 단계가 전부 정상 동작했고, 가장 오래 걸린 단계(`warpPerspective`)도 86ms였다.** 합쳐도 200ms 미만. OpenCV 연산 자체는 결함이 없다.
2. **opencv.js 로딩 자체를 격리 테스트**: 빈 탭에 `<script src="https://docs.opencv.org/4.9.0/opencv.js">`를 직접 주입해 로딩·초기화 시간을 측정했다.
   - **결과: 327ms 만에 로드·초기화 완료.** 스크립트 로딩 자체도 병목이 아니다.
3. **실제 앱 코드에 단계별 진단 로그 삽입 후 로컬 재현**: `processSelectedFile` 내부에 각 단계마다 `document.title`을 갱신하는 마커를 추가해(페이지가 멈춰도 탭 제목은 CDP로 읽을 수 있으므로), 로컬 개발 서버에서 실제로 파일을 업로드해 어느 단계에서 멈추는지 확인했다.
   - **결과: `await withTimeout(loadOpenCv(), 5000, ...)` 호출 직전(`'before loadOpenCv'`)에서 멈추고, 5초 타임아웃이 지나도(17초 이상 대기) 다음 단계로 전혀 진행하지 못했다.** 이 시점부터 탭 자체가 완전히 무응답 상태가 됐다(간단한 `1+1` 평가도 응답 없음).

## 결론

- **OpenCV 연산 로직 자체와 opencv.js 스크립트 로딩 메커니즘 둘 다 격리 상태에서는 완전히 정상 동작한다.**
- **하지만 실제 앱(React 컴포넌트의 이벤트 핸들러 안)에서 `loadOpenCv()`를 호출하면, 동일한 스크립트 로딩 절차가 멈춘다.** 격리 테스트와 실제 앱 사이에 재현되지 않는 차이가 있다는 뜻이다.
- `withTimeout`은 `Promise.race` + `setTimeout` 기반이라 **프로미스가 "느리게" 해결되는 경우만 방어**할 수 있다. 만약 멈추는 지점이 진짜 메인 스레드 동기 블로킹이라면(타임아웃 콜백조차 큐에서 실행될 기회를 못 얻음), `withTimeout`은 전혀 보호막이 되지 못한다 — 실제로 5초가 훨씬 지나도 다음 단계로 못 넘어간 것이 이를 뒷받침한다.
- 정확히 어떤 상호작용이 이 차이를 만드는지(Next.js 개발 서버의 HMR/웹소켓 오버헤드, 리액트 이벤트 핸들러 컨텍스트, 동시 네트워크 요청과의 경합 등)는 원격 디버깅만으로 완전히 특정하지 못했다.

## 권장 후속 조치

- **Web Worker로 OpenCV 작업을 격리한다.** 메인 스레드에서 `loadOpenCv`/`detectDocumentQuad`/`warpToRectangle`를 직접 실행하는 대신, 별도 Worker 스레드에서 실행하고 결과만 `postMessage`로 받는 구조로 바꾼다. 이렇게 하면:
  - Worker 안에서 멈추더라도 메인 스레드(UI)는 계속 응답한다 — 최소한 "완전 먹통"은 방지된다.
  - `worker.terminate()`로 강제 종료가 가능해, 진짜 타임아웃 방어가 가능해진다(지금의 `withTimeout`과 달리).
- Worker 전환 전에는 원근보정 기능을 비활성화 상태로 유지한다. 이번 사고가 두 번 재현됐고 완전 먹통이라는 최고 심각도 결함이라, 근본 원인을 100% 특정하지 못한 채 재활성화하는 것은 위험하다.
