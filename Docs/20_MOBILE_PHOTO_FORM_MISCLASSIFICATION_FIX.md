# 20. 휴대폰 촬영 사진 양식 오판정 수정

## 배경

사용자가 실제 모바일 기기에서 "개별/순차 촬영" 모드로 실제 종이 서류를 직접 촬영해 테스트했다. 만족도조사 칸에 만족도조사 사진을 올렸는데도 다음과 같은 오류가 발생했다:

> `satisfaction_....jpg` 파일은 만족도조사 칸에 업로드됐지만, 이미지 내용은 선별검사지 양식으로 보입니다. 올바른 칸에 다시 업로드해주세요.

## 원인

`src/lib/recognition/classifyForm.ts`의 `classifyByImageContent`는 파일명 힌트(업로드 칸)와 별개로, 이미지 내용을 분석해 CAGI/만족도 각각의 정규화된 ROI 좌표에서 어두운 픽셀 밀도를 측정하고 점수가 더 높은 쪽으로 판정을 덮어쓴다. 이 정규화 좌표는 `src/lib/recognition/markDensity.ts`의 `detectFrameBounds`가 종이 테두리(표 경계선)를 직선(가로/세로로 길게 이어지는 어두운 픽셀 행/열)으로 정확히 찾아낸다는 전제 위에서만 신뢰할 수 있다 — 스캐너나 PDF처럼 원근 왜곡이 없는 이미지에서는 잘 동작한다.

하지만 휴대폰 카메라로 책상 위 종이를 촬영하면 원근 왜곡·기울기·불균일한 조명 때문에 `detectFrameBounds`가 깨끗한 직선 테두리를 찾지 못하는 경우가 흔하다. 이 경우 더 거친 대체 로직(`detectContentBounds`의 "어두운 픽셀이 있는 영역의 바운딩 박스")으로 넘어가는데, 이 대체 경계는 실제 종이 위치와 어긋나기 쉬워 ROI 좌표가 엉뚱한 부분을 샘플링하게 된다. 그 결과 내용 기반 점수가 노이즈에 가까워지고, 실제로는 만족도조사인 사진이 CAGI로 오판정되는 사례가 발생했다.

## 수정 내용

- `src/lib/recognition/markDensity.ts`: `ImageAnalysisData`에 `contentBoundsConfident: boolean` 필드를 추가. `loadImageAnalysisData`가 `detectFrameBounds`를 한 번만 호출해 결과를 재사용하고, 테두리 검출에 성공했는지 여부를 `contentBoundsConfident`에 기록한다. 기존 `detectContentBounds`(export 유지)의 동작·시그니처는 그대로 보존.
- `src/lib/recognition/classifyForm.ts`: `classifyByImageContent`가 `image.contentBoundsConfident`가 `false`이면 즉시 `'unknown'`을 반환해 파일명 힌트(업로드 칸 선택)를 그대로 신뢰하도록 함. 즉, 테두리를 신뢰성 있게 검출한 경우(스캐너/PDF 품질)에만 내용 기반 판정이 파일명 힌트를 뒤집을 수 있고, 휴대폰 촬영처럼 테두리 검출이 실패한 경우엔 사용자가 선택한 업로드 칸을 그대로 존중한다.

기존 "양식 오인식 감지" 안전장치(Docs/00_PRD.md에 명시된 의도된 기능)는 테두리가 잘 검출되는 스캐너/PDF 경로에서는 그대로 유지된다.

구현은 Codex CLI(GPT-5.5, `--dangerously-bypass-approvals-and-sandbox`)에 위임했고, 결과 diff를 리뷰해 스펙과 정확히 일치함을 확인했다. Codex가 짠 코드에는 회귀 테스트가 없어서, 테두리가 없는 합성 이미지(체크 표시는 CAGI 레이아웃을 강하게 흉내내지만 테두리 사각형은 그리지 않음)를 만족도 칸에 업로드했을 때 파일명 힌트(`satisfaction`)를 그대로 따르는지 검증하는 테스트를 `tests/form-classifier.test.ts`에 직접 추가했다.

## 검증

```
npm test
```

9개 파일 34개 테스트 전부 통과 (신규 회귀 테스트 1건 포함). 기존 `form-classifier.test.ts`의 테두리 있는 합성 이미지 테스트들은 변경 없이 그대로 통과 — 테두리 검출이 성공하는 경로(스캐너/PDF 품질)는 이번 수정으로 영향받지 않음을 확인.

```
npm run build
```

타입 체크 및 프로덕션 빌드 성공.

## 한계

실제 문제를 일으킨 사용자의 원본 휴대폰 사진 파일 자체는 서버에 보존되지 않아(임시 파일) 직접 재현·회귀 테스트에 사용할 수 없었다. 이번 수정은 코드 분석을 통한 원인 진단과 그 진단을 정확히 반영하는 합성 테스트로 검증했다. 배포 후 사용자가 동일한 사진으로 재테스트해 실제로 통과하는지 최종 확인이 필요하다.
