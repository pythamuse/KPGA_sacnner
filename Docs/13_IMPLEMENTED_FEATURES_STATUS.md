# IMPLEMENTED_FEATURES_STATUS — 구현 기능 현황

작성일: 2026-07-13

## 1. 목적

이 문서는 현재 코드에 실제 구현되어 검증까지 완료된 기능과, 구현은 되었지만 추가 QA가 필요한 기능을 한곳에 정리한다.

상세 로드맵은 `Docs/12_REAL_FEATURE_IMPLEMENTATION_ROADMAP.md`, 최종 인수 기준은 `Docs/09_ACCEPTANCE_CHECKLIST.md`를 따른다.

---

## 2. 구현 완료 기능

### 2.1 작업 생성

관련 파일:

- `src/app/api/jobs/route.ts`
- `src/lib/excel/templateManager.ts`
- `src/lib/storage/jobStore.ts`

동작:

- 새 작업 요청 시 `job_{timestamp}` 형식의 jobId를 생성한다.
- CAGI/만족도 원본 엑셀 템플릿을 `tmp/jobs/{jobId}`로 복사한다.
- 메모리 job session을 생성하고 생성 시각을 기록한다.

검증:

- `tests/integration.test.ts`

### 2.2 이미지 업로드

관련 파일:

- `src/app/api/upload/route.ts`
- `src/components/ImageUploadPanel.tsx`

동작:

- 선별검사지 이미지는 `cagi_...` prefix로 저장한다.
- 만족도조사 이미지는 `satisfaction_...` prefix로 저장한다.
- 존재하지 않는 jobId로 업로드하면 404를 반환한다.
- 순차 업로드에서 `replaceExisting=true`이면 같은 type의 이전 파일을 삭제한다.

검증:

- `tests/integration.test.ts`
- `tests/job-cleanup.test.ts`

### 2.3 카메라 촬영 흐름

관련 파일:

- `src/components/ImageUploadPanel.tsx`

동작:

- `navigator.mediaDevices.getUserMedia()`로 카메라 미리보기를 시작한다.
- 선별검사지 촬영 후 같은 세션에서 만족도조사 촬영 단계로 넘어간다.
- 두 번째 촬영 후 카메라 track을 종료한다.
- 권한 거부, 미지원 브라우저, 비보안 컨텍스트 오류 메시지를 표시한다.

검증 상태:

- 빌드 통과
- 모바일 HTTPS 실기기 수동 QA 필요

### 2.4 업로드 세션 안정화와 파일 정리

관련 파일:

- `src/app/api/jobs/cleanup/route.ts`
- `src/lib/storage/jobStore.ts`
- `src/components/ImageUploadPanel.tsx`

동작:

- 업로드 초기화 시 서버의 `uploads` 폴더를 삭제한다.
- 작업 전체 삭제(`scope=job`)와 만료 작업 삭제(`scope=expired`) API를 제공한다.
- 기본 만료 기준은 24시간이다.

검증:

- `tests/job-cleanup.test.ts`

### 2.5 ROI 마킹 밀도 계산

관련 파일:

- `src/lib/recognition/markDensity.ts`
- `src/lib/recognition/roiTemplates.ts`

동작:

- `sharp`로 이미지를 회전 보정, 흰 배경 flatten, grayscale 처리한다.
- 문서 content bounds를 추정한다.
- 정규화된 ROI 안의 어두운 픽셀 밀도를 계산한다.
- 후보값 간 점수 차이로 `high`, `medium`, `low` confidence를 산출한다.

검증:

- `tests/recognition-mark-density.test.ts`

### 2.6 CAGI 인식 MVP

관련 파일:

- `src/lib/recognition/detectCheckmarks.ts`
- `src/lib/recognition/roiTemplates.ts`

동작:

- CAGI 성별과 문항 1~9의 ROI 후보를 분석한다.
- 인식 실패 항목은 임의값을 넣지 않고 비워둔다.
- 예시 fixture는 기존 통합 테스트 기대값을 유지한다.

제한:

- 연령대, 학교유형, 학년 자동 추출은 아직 완성되지 않았다.
- 실제 촬영 이미지의 다양한 기울기, 그림자, 흐림에 대한 튜닝이 필요하다.

검증:

- `tests/integration.test.ts`
- `tests/recognition-mark-density.test.ts`

### 2.7 만족도 인식 MVP

관련 파일:

- `src/lib/recognition/detectCheckmarks.ts`
- `src/lib/recognition/roiTemplates.ts`

동작:

- 만족도 문항 1~10의 ROI 후보를 분석한다.
- 문항1은 1~4 값으로 인식한다.
- 문항2~6은 아니오/예를 0/1 값으로 인식한다.
- 문항7~10은 0~4 척도 값으로 인식한다.
- 인식 실패 항목은 임의값을 넣지 않고 비워둔다.
- 후보 점수는 `draft.candidates`에 포함되어 검수 화면 고도화에 사용할 수 있다.

제한:

- 실제 촬영 이미지의 기울기, 그림자, 흐림에 대한 좌표/임계값 튜닝이 필요하다.
- 문항 텍스트 OCR은 수행하지 않는다.

검증:

- `tests/satisfaction-recognition.test.ts`

### 2.8 이미지 내용 기반 양식 판별 MVP

관련 파일:

- `src/lib/recognition/classifyForm.ts`

동작:

- 일반 이미지에서는 파일명보다 내용 기반 판별을 먼저 수행한다.
- CAGI 선택지 배치와 만족도 선택지 배치를 각각 점수화한다.
- 점수 차이가 충분하면 `cagi` 또는 `satisfaction`으로 분류한다.
- 애매하면 `unknown`으로 두고 파일명 힌트를 fallback으로 사용한다.
- 기존 `example` fixture는 파일명 힌트를 유지한다.

검증:

- `tests/form-classifier.test.ts`

### 2.9 업로드 칸/양식 불일치 감지

관련 파일:

- `src/app/api/recognize/route.ts`
- `src/lib/recognition/classifyForm.ts`

동작:

- 업로드 파일 prefix(`cagi_`, `satisfaction_`)로 사용자가 넣은 칸을 확인한다.
- 이미지 내용 판별 결과와 업로드 칸이 다르면 `FORM_TYPE_MISMATCH`를 반환한다.
- 이 오류는 장수 불일치(`COUNT_MISMATCH`)보다 먼저 반환된다.
- 응답에는 `mismatches` 배열을 포함한다.

응답 예:

```json
{
  "code": "FORM_TYPE_MISMATCH",
  "mismatches": [
    {
      "filename": "cagi_wrong_bucket.png",
      "uploadedAs": "cagi",
      "detectedAs": "satisfaction"
    }
  ]
}
```

검증:

- `tests/recognize-form-mismatch.test.ts`

### 2.10 검수, 저장, 엑셀 반영

관련 파일:

- `src/components/RecognitionReview.tsx`
- `src/app/api/students/route.ts`
- `src/lib/validation/*`
- `src/lib/excel/*`

동작:

- 인식 draft를 검수 화면에서 수정할 수 있다.
- low/medium confidence 항목은 카드 배경과 테두리로 강조한다.
- 검수 화면 상단에 확인 필요 항목 수, 낮은 신뢰도 수, 확인 권장 수를 요약한다.
- ROI 후보 점수 상위 3개를 칩 형태로 표시한다.
- 선별검사지와 만족도조사 원본 이미지를 검수 화면에서 확인할 수 있다.
- 원본 이미지를 클릭하면 새 탭에서 크게 확인할 수 있다.
- low/medium confidence 항목은 선택지 영역 crop preview를 표시한다.
- crop 이미지를 클릭하면 새 탭에서 크게 확인할 수 있다.
- 저장 전 validation을 수행한다.
- 검증 실패 시 엑셀에 저장하지 않는다.
- 검증 통과 시 CAGI와 만족도 파일에 같은 행 번호로 반영한다.
- 엑셀 저장 시 템플릿 보존을 위해 `extLst` 복원 처리를 수행한다.

검증:

- `tests/validation.test.ts`
- `tests/excel.test.ts`
- `tests/integration.test.ts`

### 2.11 다운로드

관련 파일:

- `src/app/api/download/route.ts`

동작:

- CAGI 작업 파일과 만족도 작업 파일을 각각 다운로드한다.
- 저장된 학생 데이터가 없으면 화면에서 다운로드를 차단한다.

검증:

- `tests/integration.test.ts`

---

## 3. 현재 제한 사항

| 영역 | 제한 |
|---|---|
| 만족도 인식 | 문항 1~10 ROI MVP는 구현됐다. 실제 촬영 샘플 기반 좌표/임계값 튜닝이 필요하다. |
| 기본정보 인식 | 연령대, 학교유형, 학년 추출은 실제 OCR/ROI 구현이 추가로 필요하다. |
| 양식 판별 | 제목 OCR이 아니라 선택지 배치 기반 MVP이다. 실제 샘플 기반 임계값 튜닝이 필요하다. |
| 검수 화면 | low confidence 강조, 후보값 표시, 원본 이미지 미리보기, 필드별 crop preview가 구현됐다. 실제 샘플 기반 표시 품질 QA가 필요하다. |
| PDF 처리 | 클라이언트 `pdf.js` 전역 객체 의존 방식이라 운영 안정화가 필요하다. |
| 임시파일 운영 | cleanup API는 있으나 자동 호출 시점과 다운로드 만료 정책이 남아 있다. |
| 카메라 | 모바일 HTTPS 실기기 QA가 필요하다. |

---

## 4. 자동 검증 현황

2026-07-13 기준:

```text
npm.cmd test
→ 8 files, 30 tests passed

npm.cmd run build
→ Next.js production build passed
```

테스트 파일:

- `tests/validation.test.ts`
- `tests/excel.test.ts`
- `tests/integration.test.ts`
- `tests/recognition-mark-density.test.ts`
- `tests/satisfaction-recognition.test.ts`
- `tests/form-classifier.test.ts`
- `tests/recognize-form-mismatch.test.ts`
- `tests/job-cleanup.test.ts`

---

## 5. 다음 작업 후보

1. 실제 촬영 이미지 기반 CAGI/만족도 ROI 임계값 튜닝
2. 기본정보 연령대, 학교유형, 학년 인식 구현
3. 실제 촬영 이미지 기반 crop preview/ROI 좌표 품질 튜닝
4. PDF 처리 안정화
5. cleanup API 자동 호출 정책 정리

---

## 2026-07-29 추가 구현 기록

### 기본정보 ROI 인식 일부 구현

관련 파일:

- `src/lib/recognition/roiTemplates.ts`
- `src/lib/recognition/detectCheckmarks.ts`

구현 내용:

- CAGI 양식의 학교유형 체크박스 ROI를 `basic.schoolType` 후보군으로 추가했다.
- CAGI 양식의 학년 체크박스 ROI를 `basic.grade` 후보군으로 추가했다.
- ROI 내부 후보값은 `elementary`, `middle`, `high`, `outside`, `grade1`~`grade6`처럼 ASCII 코드로 유지하고, 인식 결과 반영 단계에서 `초등학교`, `중학교`, `고등학교`, `학교외기관`, `1학년`~`6학년`으로 매핑한다.
- 나이는 숫자 OCR 자동 인식 전 단계로 `basic.age` field region을 정의했다.

현재 제한:

- `basic.age`는 아직 숫자 OCR을 수행하지 않는다.
- 실제 촬영 샘플 기반으로 학교유형/학년 ROI 좌표와 confidence 임계값 보정이 필요하다.

### 기본정보 crop preview 확장

관련 파일:

- `src/app/api/uploads/crop/route.ts`
- `src/components/RecognitionReview.tsx`

구현 내용:

- crop API가 기존 선택지 묶음(`choiceGroups`)뿐 아니라 일반 입력 영역(`fieldRegions`)도 잘라낼 수 있게 확장했다.
- 검수 화면에서 `basic.age`가 high confidence가 아닐 때 CAGI 원본 이미지의 나이 영역 crop preview를 표시한다.
- 학교유형/학년은 ROI 후보 점수와 crop preview를 함께 확인할 수 있다.

로컬 서버에서 확인할 내용:

- CAGI 이미지를 업로드한 뒤 검수 화면에서 학교유형과 학년이 자동 입력되는지 확인한다.
- 학교유형/학년 후보 점수 chip이 표시되는지 확인한다.
- 나이 입력칸에서 원본 crop preview가 표시되고, 클릭 시 새 탭에서 크게 열리는지 확인한다.
- 실제 샘플에서 ROI가 한 칸씩 밀리거나 너무 좁게 잘리지 않는지 확인한다.

### ROI 보정용 debug crop 추가

관련 파일:

- `src/app/api/uploads/crop/route.ts`
- `src/components/RecognitionReview.tsx`

구현 내용:

- crop API에 `debug=1` 옵션을 추가했다.
- debug crop은 일반 preview보다 넓은 주변 영역을 포함하고, 실제 ROI 위치를 빨간 박스와 중심선으로 표시한다.
- 검수 화면의 각 crop preview 아래에 `ROI 확인` 링크를 추가해 새 탭에서 debug crop을 열 수 있게 했다.
- debug crop 이미지 상단에 field명과 정규화 ROI 좌표(`x`, `y`, `width`, `height`)를 표시한다.
- crop 응답 헤더에 `X-ROI-Field`, `X-ROI-Rect`, `X-ROI-Crop-Box`를 포함해 좌표 보정 시 참고할 수 있게 했다.

로컬 서버에서 확인할 내용:

- low/medium 항목의 `ROI 확인` 링크가 새 탭에서 열리는지 확인한다.
- 빨간 ROI 박스가 실제 체크박스 또는 입력칸을 정확히 감싸는지 확인한다.
- debug crop 상단 라벨의 field명과 좌표를 보고 `roiTemplates.ts`에서 수정할 항목을 식별한다.
- 박스가 밀려 있으면 `src/lib/recognition/roiTemplates.ts`의 해당 field 좌표를 보정한다.
