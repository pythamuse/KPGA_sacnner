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
| **사진 인식 정확도** | **측정된 적이 없다.** 저장소의 모든 정확도 수치(정답표 19명, `CORRECT 354/432`, 브라우저 135·302·10)는 스캔 PDF에서 나왔다. 원근 보정은 있으나 `confidence`가 사각형의 그럴듯함을 잴 뿐 왜곡 잔차를 재지 않고, 실패하면 카메라·단일 경로는 경고 없이 원본을 올린다 → [Task/PHOTO_PATH_PLAN_2026-08-25.md](../Task/PHOTO_PATH_PLAN_2026-08-25.md) |
| 묶음 짝짓기 | 앞뒷면을 i번째끼리 붙이므로 **두 묶음이 같은 순서일 때만** 맞다. 연속 급지 스캔은 뒷면이 역순(19→1)으로 나오고, 지금은 사용자가 손으로 되돌려 올린다. 그 수동 단계에서 두 장이 함께 넘어가 생기는 뒤바뀜은 장수도 양식도 맞아 **어떤 검사에도 걸리지 않는다** → [Task/REVERSED_STACK_PAIRING_2026-08-24.md](../Task/REVERSED_STACK_PAIRING_2026-08-24.md) |

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
6. 역순 묶음 짝짓기 — 뒷면 묶음 순서 지정과 짝 확인 표시 ([계획](../Task/REVERSED_STACK_PAIRING_2026-08-24.md))
7. **사진 경로 측정과 단계별 개선** — 0단계 측정 → 워프 검증 → 호모그래피 정합 → 다중 프레임 합의 → 크롭 분류 ([계획](../Task/PHOTO_PATH_PLAN_2026-08-25.md))
8. **촬영 유도와 원본 평가** — 가이드 테두리, 기울어짐 경고, 어두움 감지, 촬영 직후 인식 가능성 판정 ([설계](../Task/CAPTURE_GUIDANCE_2026-08-27.md))
9. **외부 기술 도입 계획** — ORB 호모그래피 정합 스파이크(38/38 정합 실측), 두-스트림 기하, 외부 프로젝트 조사와 채택/기각 ([계획](../Task/EXTERNAL_ADOPTION_PLAN_2026-08-27.md))

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

---

## 2026-07-30 추가 구현 기록

### Vercel 업로드 세션 안정화

관련 파일:

- `src/lib/storage/jobStore.ts`
- `src/app/api/jobs/route.ts`
- `src/app/api/upload/route.ts`
- `src/app/api/recognize/route.ts`
- `src/app/api/students/route.ts`
- `src/app/api/download/route.ts`

문제 원인:

- Vercel Serverless 환경에서는 `/api/jobs`, `/api/upload`, `/api/recognize` 요청이 항상 같은 함수 인스턴스에서 처리된다고 보장할 수 없다.
- 기존 구현은 작업 세션을 `activeJobs` 인메모리 `Map`에만 저장했다.
- 따라서 새 작업을 만든 직후라도 업로드 요청이 다른 인스턴스에서 처리되면 `hasJobSession(jobId)`가 false가 되어 선별검사지 업로드 중 세션 없음/서버 오류가 발생할 수 있었다.
- 이 문제는 로컬 서버에서는 잘 재현되지 않고, Vercel 배포본에서 간헐적으로 발생할 수 있다.

수정 내용:

- 작업 생성 시 `session.json`을 작업 폴더에 저장한다.
- `getJobSession(jobId)`는 메모리 세션이 없으면 `session.json`에서 세션을 복구한다.
- `hasJobSession(jobId)`는 파일 기반 세션 복구 결과를 기준으로 판단한다.
- `/api/upload`는 유효한 `job_숫자` 형식의 jobId에 대해 메모리/세션 파일이 없어도 작업 폴더와 세션을 즉시 복구한 뒤 업로드를 받는다.
- 학생 저장/삭제 시 세션 파일도 함께 갱신한다.

운영 주의:

- 현재 저장 위치는 Vercel 함수의 임시 파일 영역이다.
- 같은 작업 흐름 내 단기 세션 복구에는 도움이 되지만, 장시간 보관 또는 인스턴스 간 영구 공유가 필요한 구조는 아니다.
- 학생 데이터와 업로드 파일을 운영 환경에서 안정적으로 오래 유지하려면 Vercel Blob, 외부 DB, Supabase Storage 같은 영구 저장소로 전환해야 한다.

재발 방지 규칙:

- 새 API가 `jobId`를 검증할 때 인메모리 `Map`만 직접 참조하지 않는다.
- 반드시 `getJobSession()` 또는 `hasJobSession()`을 사용해 파일 기반 복구 경로를 거친다.
- 업로드 API처럼 사용자 파일을 처음 받는 경로는 `ensureJobSession()`을 사용해 Vercel의 콜드 스타트/인스턴스 분리 상황에서도 작업공간을 복구해야 한다.
- 새로 추가하는 세션 상태는 `addStudentToSession()`처럼 메모리와 `session.json`을 함께 갱신해야 한다.

로컬/배포 테스트 포인트:

- 새 작업 생성 직후 선별검사지 PDF 또는 이미지를 업로드했을 때 404/500 세션 오류가 나지 않아야 한다.
- 선별검사지 업로드 후 만족도조사 업로드가 같은 jobId에 누적되어야 한다.
- 인식, 검수 저장, 다운로드까지 같은 jobId로 이어져야 한다.

### PDF 업로드 용량 안정화

관련 파일:

- `src/components/ImageUploadPanel.tsx`

문제 원인:

- PDF 페이지를 `scale=2.0` PNG로 변환하면 페이지당 이미지 용량이 커져 Vercel 요청 제한 또는 브라우저 메모리 문제를 유발할 수 있다.
- 특히 선별검사지처럼 페이지 수가 많은 PDF는 중간 페이지에서 업로드 실패가 발생할 수 있다.

수정 내용:

- PDF 페이지를 PNG 대신 JPEG로 변환한다.
- 페이지 이미지가 큰 경우 `scale`과 JPEG 품질을 단계적으로 낮춰 업로드 크기를 줄인다.
- Vercel이 JSON이 아닌 오류 응답을 반환해도 사용자에게 읽을 수 있는 업로드 실패 메시지를 표시한다.

테스트 포인트:

- 선별검사지 PDF 1개 업로드 시 모든 페이지가 끝까지 업로드되는지 확인한다.
- 만족도조사 PDF 1개 업로드 시 모든 페이지가 끝까지 업로드되는지 확인한다.
- 업로드 중 실패하면 alert 문구와 Network의 `/api/upload` 상태 코드를 함께 기록한다.

### CAGI 조기개입 서비스 표기 처리

관련 파일:

- `src/lib/recognition/cagiEarlyIntervention.ts`
- `src/lib/recognition/classifyForm.ts`
- `src/app/api/recognize/route.ts`
- `src/app/page.tsx`

정책:

- 선별검사지 하단의 조기개입 서비스 영역은 엑셀 추출 대상이 아니다.
- 수기 작성 과정에서 조기개입 서비스에 표기했다가 삭제한 흔적이 있어도 CAGI 문항 인식은 계속 진행한다.
- 조기개입 서비스 표기 흔적은 오류가 아니라 안내 노티스로만 표시한다.

수정 내용:

- 선별검사지 조기개입 서비스 영역의 표기 흔적을 별도 ROI로 감지한다.
- 해당 흔적 때문에 선별검사지가 만족도조사로 오판되는 경우 `FORM_TYPE_MISMATCH`로 막지 않고 선별검사지로 유지한다.
- 화면에는 `선별검사지 N페이지에서 조기개입 서비스 표기 흔적이 감지되었습니다...` 형태의 노티스를 표시한다.
- 만족도조사 양식 판별 점수에서는 선별검사지 하단 조기개입 영역과 겹칠 수 있는 하단 문항 영역을 제외해 오판 가능성을 낮춘다.

테스트 포인트:

- 조기개입 서비스 표기/삭제 흔적이 있는 선별검사지는 오류 없이 검수 화면으로 넘어가야 한다.
- 노티스에는 해당 선별검사지 페이지 번호가 표시되어야 한다.
- CAGI 문항 1~9만 추출되어야 하며 조기개입 서비스 값은 저장되지 않아야 한다.
- 실제로 만족도조사를 선별검사지 칸에 올린 경우에는 여전히 `FORM_TYPE_MISMATCH`가 발생해야 한다.

---

### 2026-08-05 이미지 인식 안전장치 및 지연 완화

관련 파일:

- `src/lib/recognition/markDensity.ts`
- `src/lib/recognition/tableRowDetection.ts`
- `src/lib/recognition/ocrTextLines.ts`
- `src/lib/recognition/detectCheckmarks.ts`
- `src/components/RecognitionReview.tsx`

변경 내용:

- `detectFrameBounds`에 양식 전체 프레임인지 확인하는 크기·여백·종횡비 검사를 추가했다.
- 프레임을 신뢰할 수 없는 사진은 ROI 후보 점수만 전달하고 자동값을 확정하지 않는다.
- 이런 경우 검수 화면에 원본 대조 안내를 표시한다.
- 문항 행 검출은 픽셀 가로선 매칭을 먼저 실행하고, 실패할 때만 OCR 앵커를 보조적으로 사용한다.
- OCR 전체 제한 시간을 2.5초로 줄이고 같은 이미지·크롭 결과를 캐시한다.
- 경계가 불확실하면 조기개입 서비스 ROI 감지도 건너뛰어 잘못된 노티스를 방지한다.

검증:

- 경계 불확실 합성 이미지에서 CAGI·만족도 자동값 생략과 경고 2건을 확인했다.
- 기존 OCR 텍스트 위치, 동적 행 검출, 만족도 인식 테스트를 유지했다.
- 실제 사용자의 원본 이미지에서 ROI 위치가 올바른지와 Vercel 처리 시간이 개선되는지는 배포 후 재검증이 필요하다.

---

## 관련 Task 문서

이 문서에 기록된 시점(2026-07-30) 이후 각 기능 영역에서 실제로 발생한 문제와 후속 작업은 아래 Task 문서에 이어져 있다. 이 문서는 "지금 무엇이 구현되어 있는가"만 유지하고, 그 이후의 조사·수정 히스토리는 옮기지 않는다:

| 기능 영역 | 관련 Task |
|---|---|
| PDF 업로드/렌더링 | [Task/PDF_BATCH_RENDER_HANG.md](../Task/PDF_BATCH_RENDER_HANG.md) |
| 작업 세션/저장/다운로드(Vercel 배포) | [Task/STATELESS_ARCHITECTURE_MIGRATION.md](../Task/STATELESS_ARCHITECTURE_MIGRATION.md) |
| 이미지 내용 기반 양식 판별 | [Task/MOBILE_PHOTO_MISCLASSIFICATION_FIX.md](../Task/MOBILE_PHOTO_MISCLASSIFICATION_FIX.md) |
| 카메라 촬영 흐름 / 원근 보정 | [Task/MOBILE_CAPTURE_PERSPECTIVE_CORRECTION.md](../Task/MOBILE_CAPTURE_PERSPECTIVE_CORRECTION.md), [Task/CAMERA_UPLOAD_ROBUSTNESS_FIXES.md](../Task/CAMERA_UPLOAD_ROBUSTNESS_FIXES.md) |
| ROI 마킹 밀도 계산 / CAGI·만족도 인식 정확도 | [Task/RECOGNITION_ACCURACY_DYNAMIC_ROW_DETECTION.md](../Task/RECOGNITION_ACCURACY_DYNAMIC_ROW_DETECTION.md), [Task/OCR_ANCHORED_ROW_DETECTION.md](../Task/OCR_ANCHORED_ROW_DETECTION.md) |
| 앞뒷면 묶음 짝짓기 | [Task/REVERSED_STACK_PAIRING_2026-08-24.md](../Task/REVERSED_STACK_PAIRING_2026-08-24.md) |
| 사진(카메라) 경로 측정·개선 | [Task/PHOTO_PATH_PLAN_2026-08-25.md](../Task/PHOTO_PATH_PLAN_2026-08-25.md) |

버그로 확정된 항목은 [Docs/BUG_REPORTS.md](BUG_REPORTS.md)에도 원인·대응이 요약되어 있다.
