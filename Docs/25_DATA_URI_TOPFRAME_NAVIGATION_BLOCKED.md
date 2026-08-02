# 25. data: URI 새 탭 열기가 브라우저에 의해 차단됨

## 증상

검수 화면에서 크롭 썸네일, "ROI 확인" 링크, "원본 이미지" 링크를 클릭하면 이미지가 뜨지 않고 콘솔에 다음 에러가 뜬다:

> Not allowed to navigate top frame to data URL

## 원인

[[19_STATELESS_PREVIEW_IMAGE_FIX_RESULTS]]에서 `/api/uploads/crop`, `/api/uploads/image`의 Vercel 인스턴스 간 상태 공유 문제를 고치기 위해, 검수 화면의 원본/크롭 이미지를 서버 URL(`/api/uploads/...`) 대신 `data:image/...;base64,...` 형태의 data URI로 직접 응답에 실어 렌더링하도록 바꿨다. 이때 `src/components/RecognitionReview.tsx`의 세 곳(크롭 썸네일, ROI 확인 링크, 원본 이미지 링크)이 전부 `<a href={dataUri} target="_blank">`로 새 탭을 여는 방식을 그대로 두었다.

`<img src={dataUri}>`로 이미지를 화면에 표시하는 것은 아무 문제가 없다(이미 확인됨). 문제는 **`data:` URI를 새 탭/새 창의 최상위 프레임(top frame) 탐색 대상으로 사용하는 것**이다 — 크롬을 비롯한 최신 브라우저는 피싱 공격 방지를 위해 이를 명시적으로 차단한다(스펙/보안 정책상 의도된 동작이며 버그 리포트로 고쳐질 사안이 아니다). `target="_blank"`로 여는 새 탭의 `href`가 `data:` URI이면 항상 이 에러가 난다.

즉 [[19_STATELESS_PREVIEW_IMAGE_FIX_RESULTS]]의 무상태화 수정 자체는 유효하지만, 그 수정이 "이미지를 새 탭에서 크게 보기" 기능과 충돌하는 부작용을 놓쳤다. 이번에 사용자가 실제 이미지 인식 정확도 문제를 진단하려고 "ROI 확인"을 눌러보다가 발견됨.

## 수정 방향

`data:` URI는 최상위 탐색 대상으로 못 쓰지만, **Blob URL(`blob:...`, `URL.createObjectURL()`로 생성)은 최상위 탐색이 허용된다.** 클릭 시점에 data URI를 Blob으로 변환해 Blob URL을 만들고 그 URL로 새 탭을 열도록 세 곳 전부 수정한다:

1. `src/components/RecognitionReview.tsx`의 세 `<a href={dataUri} target="_blank">`(크롭 썸네일, ROI 확인, 원본 이미지)를 각각: `href`는 그대로 두거나 `#`으로 바꾸고, `onClick`에서 `event.preventDefault()` 후 data URI를 fetch→blob으로 변환해 `URL.createObjectURL(blob)`로 새 Blob URL을 만들어 `window.open(blobUrl, '_blank')`으로 열도록 바꾼다.
2. 메모리 누수 방지를 위해 새 탭이 열린 뒤 적절한 시점에 `URL.revokeObjectURL`을 호출한다(즉시 호출하면 새 탭이 아직 로드 전일 수 있으니, 예를 들어 짧은 지연 후 해제하거나 새 탭의 `load` 이벤트를 기다리는 방식 중 구현하기 쉬운 쪽을 택한다).
3. `<img src={dataUri}>`로 화면에 표시하는 부분은 전혀 문제가 없으므로 건드리지 않는다 — 오직 "새 탭에서 열기" 동작만 고친다.
