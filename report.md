# 종이 경계 검출 밝기 문턱 변경 보고

## 바꾼 파일

- `src/lib/recognition/markDensity.ts:25` — `ImageAnalysisData.paperBoundsThreshold`를 추가했다.
- `src/lib/recognition/markDensity.ts:442-475` — 이미지 로드 시 유도 문턱과 그 결과를 분석 데이터에 보존한다.
- `src/lib/recognition/markDensity.ts:642-823` — 히스토그램, Otsu 분할, 두 군집 평균의 중간값으로 문턱을 유도한다.
- `src/lib/recognition/markDensity.ts:1190-1198,1300-1307,1727-1731` — 선택 문턱을 `bounds=` 결정 trace에 기록한다.
- `tests/recognition-mark-density.test.ts:39-54,339-391` — 합성 회귀와 trace 전달 시험을 추가했다.
- `report.md` — 이 보고서.

`order.md`는 작업 시작 전부터 있던 사용자 주문서이며 내용은 바꾸지 않았다. 완료 명령의 `git add -A` 대상에 포함한다.

## 유도 방식과 근거

기존 종횡비·55%/62% 조건과 연결 성분 검출은 유지하고, 기존 컴포넌트 검출과 같은 8배 샘플 격자에서 0~255 히스토그램을 만든다.

1. Otsu의 between-class variance가 가장 큰 분할로 히스토그램을 어두운 군과 밝은 군으로 나눈다.
2. Otsu 분할값 자체를 마스크 문턱으로 쓰지 않고, 양쪽 군의 관측 평균의 중간값을 문턱으로 쓴다. 예를 들어 `40/230`은 `135`, `40/165`는 `103`이 되어 종이가 기존 `170` 아래여도 책상과 분리된다.
3. 양쪽 군이 없거나 분리가 8 미만이면 안전한 기존값 `195`를 쓴다.
4. 결과는 `1..195`로 제한한다. 따라서 유도값이 스캔 경로에서 195를 넘을 수 없다.

0/255에 가까운 흰색 입력(`255`가 존재하고 중간 명도 비율이 1% 이하)은 스캔 경로로 보고 문턱을 `195`에 고정한다. 이 입력에서는 기존 `[195,170]` 두 후보의 밝은 마스크가 같으므로, 컴포넌트 검출 결과가 기존과 바이트 단위로 같다. 이미지 화소 자체에는 어떤 보정도 하지 않았다.

## 계측

`loadImageAnalysisData`가 실제로 사용한 문턱을 `paperBoundsThreshold`에 저장하고, `analyzeChoiceGroup`의 결정 문자열에 다음처럼 남긴다.

```text
bounds=paper/0.8000/paper-threshold=103
```

따라서 성공한 paper 경로와 `contentBoundsRejection`이 붙은 경로 모두 같은 결정 trace에서 문턱을 확인할 수 있다.

## 합성 시험 결과 전문

명령:

```text
npx.cmd vitest run tests/recognition-mark-density.test.ts --reporter=verbose
```

결과:

```text
✓ marks only a high-confidence runner-up at or above the measured boundary
✓ keeps a single-candidate high-confidence result uncontested
✓ ROI 안의 어두운 픽셀 비율을 계산한다
✓ 가장 진하게 마킹된 선택지를 high confidence로 고른다
✓ 마킹 차이가 작으면 값을 확정하지 않고 low confidence로 둔다
✓ cell-grid pixel overrides score the actual selected cell instead of stale template coordinates
✓ subtracts the blank form print so a hand-drawn ring wins over identical printed circles
✓ 종이 경계가 불확실하면 후보 점수만 남기고 자동값을 확정하지 않는다
✓ 긴 내부 표 선만 있는 이미지를 문서 프레임으로 신뢰하지 않는다
✓ 얇지만 네 변이 이어진 외곽선은 문서 프레임으로 인정한다
✓ 페이지 중앙의 큰 내부 표도 문서 프레임으로 승격하지 않는다
✓ uses the post-EXIF-rotation dimensions when indexing image pixels
✓ registers a bright paper sheet instead of the dark photo background
✓ derives a threshold between bright paper and a dark desk
✓ finds paper whose observed brightness is below the old absolute cutoff
✓ pins a full-white scan-like image to the old threshold and bounds
✓ does not invent paper bounds for a uniformly dark image
✓ includes the selected paper threshold in the bounds decision trace

Test Files  1 passed (1)
Tests       18 passed (18)
```

핵심 기대값은 다음과 같다.

```text
paper=230, desk=40 -> threshold=135, bounds=[32,32,288,448]
paper=165, desk=40 -> threshold=103, bounds=[32,32,288,448]
all white 255       -> threshold=195, bounds=[0,0,320,480]
uniform dark 40     -> threshold=195, bounds=null
```

## 검증 결과

- `npx.cmd tsc --noEmit` — 통과.
- `npx.cmd vitest run` — 42개 파일 통과, 11개 의도적 skip; 421개 시험 통과, 11개 skip.
- `MARK_AFFINE_TONE=1 npx vitest run`에 해당하는 `cmd /c "set MARK_AFFINE_TONE=1&& npx.cmd vitest run"` — 같은 결과로 통과.
- `tests/blank-form-calibration.test.ts`, `tests/blank-form-detection.test.ts`, 새 합성 시험 — 23개 통과.
- `npm run build` — 주문대로 실행하지 않았다.

이 환경은 PowerShell 실행 정책 때문에 `npx.ps1` 대신 `npx.cmd`를 사용했다. 의존성 설치 경고상 실행 Node는 24.18.0이고 package 요구 버전은 20.x다.

## 명세와 다르게 한 것과 이유

- 기존의 `[195,170]` 두 후보를 그대로 유지하지 않고, 유도 문턱 하나만 컴포넌트 검출에 전달했다. 낮은 고정 후보를 함께 비교하면 어두운 책상까지 밝은 성분으로 합쳐져 더 큰 잘못된 후보가 이길 수 있으므로 제거했다. 스캔형 입력은 별도 보정이 아니라 문턱을 `195`로 고정해 기존 경로를 유지한다.
- 진단 요구를 충족하기 위해 공개 유틸리티 `derivePaperBoundsThreshold`와 분석 메타데이터 필드를 추가했다. 검출 기하, 프레임 검출, 격자, 채점, 게이트는 변경하지 않았다.

## 확신 없는 부분

이 체크아웃에는 정답표와 실제 스캔·사진 세트가 없으므로 `OLD`, `Set1`, `Set2`, `Set3`의 오답 수나 `cagi.q01 → "3"` 7건을 중앙 측정한 결과라고 주장할 수 없다. 이 변경이 실제 세트에서 오답 비증가·정답 비감소인지, 세 스캔 세트가 바이트 동일한지는 위임자의 중앙 재측정이 최종 판단한다. 비이진·다봉 히스토그램의 특이한 사진은 합성 시험만으로 보증하지 않는다.
