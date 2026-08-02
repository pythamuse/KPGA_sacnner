# 23. 카메라 미리보기 검은 화면 및 촬영 버튼 무반응

## 증상

모바일과 데스크톱 웹 양쪽에서 재현됨(기기 문제가 아니라 코드 문제라는 뜻). "개별/순차 촬영" 모드에서 "촬영하기"를 눌러 카메라 흐름을 시작하면:

- 카메라 권한 요청은 정상적으로 통과되고 "1 / 2 선별검사지 촬영" 화면까지는 뜬다.
- 그런데 라이브 카메라 미리보기 영역이 **완전히 검은 화면**이다(점선 가이드와 안내 텍스트만 보이고 실제 영상은 안 뜸).
- "선별검사지 촬영하기" 버튼을 눌러도 아무 반응이 없다.

## 원인 분석

`src/components/ImageUploadPanel.tsx`:

```ts
useEffect(() => {
  if (cameraFlow.active && cameraVideoRef.current && cameraStreamRef.current) {
    cameraVideoRef.current.srcObject = cameraStreamRef.current;
  }
}, [cameraFlow.active]);
```

`<video>` 엘리먼트의 `srcObject`를 **JS로 명령형으로** 대입하고 있다. `autoPlay` 속성이 붙어있지만(`<video ref={cameraVideoRef} autoPlay playsInline muted .../>`), 여러 브라우저(특히 이렇게 나중에 스트림을 명령형으로 붙이는 경우)에서는 `autoplay` 속성만으로 재생이 보장되지 않는다 — `srcObject`를 대입한 뒤 명시적으로 `video.play()`를 호출하지 않으면 브라우저에 따라 영상이 첫 프레임도 그리지 않고 정지된 채로 남을 수 있다. 이 코드에는 `.play()` 호출이 전혀 없다.

`.camera-live-frame`(CSS)은 원래 `background: #111111`로 검은 배경을 깔아두고 그 위를 영상이 덮도록 설계되어 있다(`src/app/globals.css:397`). 영상이 재생되지 않으면 이 검은 배경이 그대로 보인다 — 화면에 보이는 검은 박스는 CSS 버그가 아니라 "영상이 재생을 시작한 적이 없다"는 증거다.

영상이 재생되지 않으면 `video.videoWidth`/`video.videoHeight`가 계속 0이거나, `readyState`가 `HAVE_CURRENT_DATA` 미만으로 남아있을 수 있다. 이 상태에서 `captureCurrentFrame`이 `context.drawImage(video, 0, 0, width, height)`를 호출하면, 스펙상 `InvalidStateError`가 발생할 수 있다. 이 예외는 현재 코드에서 어디서도 잡히지 않는다 — `captureCurrentFrame`은 `try { ... } finally { setIsCapturing(false) }` 구조라 `finally`는 실행되지만(그래서 버튼은 다시 눌러지는 상태로 돌아가긴 함) 예외 자체는 처리되지 않은 채 콘솔에만 남고 사용자에게는 아무 메시지도 뜨지 않는다. **이게 "버튼을 눌러도 아무 반응이 없다"의 정체다.**

이번 세션에서 만든 원근보정 기능(Docs/21, 22)이나 방금 전 버튼 피드백 수정(Docs/22 추가 절)과는 무관한, **더 이전부터 있었던 잠재 버그**로 보인다 — 지금까지의 테스트는 전부 파일 선택/`DataTransfer` 주입 방식으로 진행되어 실제 `getUserMedia` + 라이브 비디오 렌더링 경로를 한 번도 실제로 통과하지 않았기 때문에(샌드박스 브라우저는 카메라 접근 자체가 차단됨) 지금까지 발견되지 않았다.

## 수정 방향 (코덱스에 위임할 작업)

1. `srcObject`를 대입하는 `useEffect`에서 대입 직후 명시적으로 `cameraVideoRef.current.play()`를 호출하고, 반환되는 프로미스의 실패(reject)를 처리한다(예: 콘솔 경고 + 필요하면 `setCameraError`로 사용자에게 안내). `muted` 속성이 있으므로 대부분의 브라우저에서 자동재생 정책상 거부될 일은 거의 없지만, 방어적으로 처리한다.
2. `captureCurrentFrame`에서 `context.drawImage(...)`를 시도하기 전에 비디오가 실제로 재생 가능한 상태인지 확인한다(`video.readyState >= 2`/`HAVE_CURRENT_DATA` 및 `video.videoWidth > 0` 체크). 준비되지 않았다면 캡처를 진행하지 않고 `setCameraError`로 "카메라 화면이 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요." 같은 명확한 메시지를 보여준다.
3. `captureCurrentFrame` 전체를 감싸는 상위 `try/finally`에 **`catch` 절을 추가**해서, 어떤 이유로든(위 두 방어 로직을 뚫고) 예외가 발생하면 조용히 실패하지 않고 `setCameraError`로 사용자에게 알린다. 이건 이번 버그뿐 아니라 앞으로 비슷한 종류의 "버튼이 무반응처럼 보이는" 사고를 막는 안전장치다.

이 세 가지는 서로 다른 계층의 방어책이라 하나만으로는 부족할 수 있다 — 셋 다 구현한다.
