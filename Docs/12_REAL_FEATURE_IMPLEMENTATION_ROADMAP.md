# REAL_FEATURE_IMPLEMENTATION_ROADMAP — 실제 기능 구현 순서 및 검증 계획

## 1. 문서 목적

이 문서는 현재 프로토타입에서 실제 구동 기능으로 전환하기 위해 남은 작업을 구현 순서, 구현 단위, 검증 방법으로 정리한다.

현재 앱은 다음 기능의 골격을 갖고 있다.

```text
작업 생성
→ 이미지/PDF 업로드
→ 인식 결과 검수
→ 검증
→ 엑셀 반영
→ 다운로드
```

하지만 일부 기능은 아직 목업 또는 제한 구현 상태이다. 특히 실제 카메라 세션, OCR/Form Recognition, 이미지 내용 기반 양식 판별, 파일 정리 정책은 추가 구현이 필요하다.

---

## 2. 현재 미구현 또는 제한 구현 기능

| 구분 | 현재 상태 | 실제 구현 필요 내용 |
|---|---|---|
| 모바일 카메라 촬영 | `input capture` 기반 호출 | `getUserMedia` 기반 카메라 세션으로 2장 연속 캡처 |
| OCR/Form Recognition | 고정값 또는 예시값 반환 | 이미지 전처리, ROI 분할, 체크마크 판정, OCR 보조 인식 |
| 양식 종류 판별 | 파일명 접두어 기준 | 이미지 내용 기반 CAGI/만족도 판별 |
| PDF 처리 | 프론트 `pdf.js` 전역 객체 의존 | 안정적 로드 또는 백엔드 페이지 분할 처리 |
| 검수 화면 | 값 수정 중심 | 원본 이미지, 낮은 신뢰도, 재촬영 안내 표시 |
| 재업로드/초기화 | 화면 상태만 초기화 가능 | 서버 업로드 파일 정리 및 이전 파일 혼입 방지 |
| 임시 파일 관리 | `tmp/jobs` 누적 | 만료/삭제 정책 구현 |

---

## 3. 구현 우선순위

### 3.1 1순위: 실제 카메라 촬영 세션

목표:

```text
촬영하기 클릭
→ 카메라 권한 요청
→ 웹페이지 안에서 카메라 미리보기 표시
→ 선별검사지 촬영
→ 같은 카메라 세션 유지
→ 만족도조사 촬영
→ 2장 업로드
→ 카메라 종료
→ 원래 화면 또는 인식 절차로 이동
```

이유:

- 사용자 체감이 가장 큰 기능이다.
- OCR과 독립적으로 구현할 수 있다.
- 현재 `input capture` 방식보다 현장 모바일 사용 흐름에 가깝다.

### 3.2 2순위: 업로드 세션 안정화

목표:

- 순차 업로드에서 재촬영 또는 재업로드 시 이전 파일이 인식 대상에 남지 않도록 한다.
- 화면 초기화와 서버 파일 상태가 어긋나지 않도록 한다.
- 업로드 파일 순서를 보존한다.

### 3.3 3순위: OCR/Form Recognition MVP

목표:

- 완전 자동 인식보다 "자동 인식 시도 + 검수 화면 수정"을 우선한다.
- 체크마크 좌표 기반 인식을 먼저 구현한다.
- 낮은 신뢰도 항목은 사용자가 직접 확인하도록 한다.

### 3.4 4순위: 이미지 내용 기반 양식 판별

목표:

- 선별검사지 칸에 만족도 이미지가 들어가는 경우를 감지한다.
- 만족도 칸에 선별검사지 이미지가 들어가는 경우를 감지한다.
- 분류 실패 시 재촬영 또는 재업로드 안내를 표시한다.

### 3.5 5순위: PDF 및 운영 안정화

목표:

- PDF 페이지 분할 처리를 안정화한다.
- 임시 파일 만료/삭제 정책을 추가한다.
- 다운로드 후 작업 파일 보존 기간을 정의한다.

---

## 4. 구현 단위 및 검증 방법

## 4.1 카메라 세션 구현

### 구현 단위

파일:

- `src/components/ImageUploadPanel.tsx`
- `src/app/globals.css`

작업:

1. `navigator.mediaDevices.getUserMedia()`로 카메라 스트림을 시작한다.
2. `<video>`로 실시간 미리보기를 표시한다.
3. `<canvas>`를 사용해 현재 프레임을 이미지 Blob/File로 변환한다.
4. `cameraStep` 상태를 `cagi`에서 `satisfaction`으로 전환한다.
5. 두 번째 캡처 후 스트림의 모든 track을 `stop()`한다.
6. 기존 `uploadSingleFile(file, type)` 함수를 재사용해 두 이미지를 업로드한다.
7. 카메라 권한 거부, 미지원 브라우저, 비보안 컨텍스트 오류 메시지를 표시한다.

### 검증 방법

수동 검증:

- `localhost`에서 촬영하기 버튼 클릭 시 브라우저 카메라 권한 요청이 표시된다.
- 권한 허용 후 카메라 미리보기가 표시된다.
- 선별검사지 촬영 후 화면 텍스트가 `만족도조사 촬영`으로 바뀐다.
- 만족도조사 촬영 후 카메라 표시가 사라진다.
- 두 이미지가 업로드되고 인식 요청 단계로 이어진다.
- 촬영 취소 시 카메라 LED 또는 브라우저 카메라 표시가 꺼진다.

자동 검증:

```text
npm.cmd test
npm.cmd run build
```

추가 테스트 후보:

- `startCameraSession()`이 `getUserMedia` 실패 시 오류 상태를 세팅하는지 테스트한다.
- `stopCameraSession()`이 모든 track의 `stop()`을 호출하는지 테스트한다.
- 캡처 후 `File` 객체의 type이 `image/jpeg` 또는 `image/png`인지 테스트한다.

주의:

- `getUserMedia`는 `https` 또는 `localhost`에서만 정상 작동한다.
- 모바일 실기기에서 PC 개발 서버 IP(`http://192.168.x.x`)로 접속하면 카메라 권한이 차단될 수 있다.
- 모바일 테스트는 HTTPS 터널 또는 HTTPS 배포 환경에서 수행해야 한다.

---

## 4.2 업로드 세션 안정화

### 구현 단위

파일:

- `src/app/api/upload/route.ts`
- `src/app/api/recognize/route.ts`
- `src/lib/storage/jobStore.ts`
- `src/components/ImageUploadPanel.tsx`

작업:

1. 업로드 파일에 순번 또는 세트 ID를 저장한다.
2. 순차 촬영 모드에서는 현재 학생 세트의 파일만 인식 대상으로 사용한다.
3. 재촬영 시 기존 같은 type 파일을 교체하거나 inactive 처리한다.
4. 화면 초기화 시 서버 업로드 파일도 정리하는 API를 추가한다.
5. `recognize` API에서 존재하지 않는 jobId와 비어 있는 업로드 폴더를 명확히 구분한다.

### 검증 방법

수동 검증:

- 선별검사지 촬영 후 다시 촬영해도 이전 선별검사지가 인식 대상에 남지 않는다.
- 만족도조사만 재촬영해도 선별검사지와 새 만족도조사가 한 세트로 인식된다.
- 돌아가기 후 새 작업을 시작하면 이전 작업 파일이 섞이지 않는다.

자동 검증:

- `/api/upload`를 여러 번 호출한 뒤 최신 세트만 `/api/recognize` 대상이 되는지 통합 테스트한다.
- `jobId`가 없거나 잘못된 경우 400/404 응답을 검증한다.
- 장수 불일치 시 `COUNT_MISMATCH`가 반환되는지 검증한다.

---

## 4.3 OCR/Form Recognition MVP 구현

### 구현 단위

파일:

- `src/lib/recognition/detectCheckmarks.ts`
- 신규 후보: `src/lib/recognition/imagePreprocess.ts`
- 신규 후보: `src/lib/recognition/roiTemplates.ts`
- 신규 후보: `src/lib/recognition/markDensity.ts`

작업:

1. `sharp`로 이미지를 grayscale, resize, threshold 처리한다.
2. 양식 기준 좌표를 정의한다.
3. 기본정보 영역 ROI를 정의한다.
4. CAGI 1~9 선택지 ROI를 정의한다.
5. 만족도 1~10 선택지 ROI를 정의한다.
6. 각 ROI의 어두운 픽셀 비율 또는 마킹 밀도를 계산한다.
7. 선택지별 점수 중 최고값을 후보값으로 선택한다.
8. 최고점과 차점 차이가 작으면 confidence를 `low` 또는 `medium`으로 둔다.
9. 값이 불명확하면 필드 값을 비워두고 검수 화면에서 선택하게 한다.

### 검증 방법

수동 검증:

- 실제 촬영 이미지에서 검수 화면 값이 이미지 체크와 대체로 일치하는지 확인한다.
- 낮은 신뢰도 항목이 빨간색 또는 확인 필요 표시로 노출되는지 확인한다.
- 사용자가 값을 수정하면 수정값이 엑셀에 반영되는지 확인한다.

자동 검증:

- 준비된 샘플 이미지로 `recognizeStudentForms()`를 호출한다.
- 예시 기대값:
  - 연령대: `14`
  - 성별: `여`
  - 학교유형: `중학교`
  - 학년: `2학년`
  - CAGI 01~09: `0`
  - 만족도: `4,1,1,1,1,1,4,4,4,4`
- ROI 점수 계산 함수는 작은 테스트 이미지 fixture로 단위 테스트한다.
- confidence 산출 규칙을 별도 테스트한다.

허용 기준:

- MVP에서는 모든 항목이 항상 high일 필요는 없다.
- 인식 실패 항목은 빈 값 또는 low confidence로 검수 화면에 전달되어야 한다.
- 잘못된 고정값을 임의로 채워서는 안 된다.

---

## 4.4 이미지 내용 기반 양식 판별

### 구현 단위

파일:

- `src/lib/recognition/classifyForm.ts`
- 신규 후보: `src/lib/recognition/formClassifier.ts`

작업:

1. 파일명 기반 분류를 보조 수단으로 낮춘다.
2. 이미지 상단 제목 영역을 OCR 또는 ROI 패턴으로 확인한다.
3. CAGI 양식과 만족도 양식의 레이아웃 특징을 비교한다.
4. 업로드 type과 실제 판별 결과가 다르면 오류를 반환한다.
5. 분류 실패 시 `unknown`과 사용자 안내 메시지를 반환한다.

### 검증 방법

수동 검증:

- 선별검사지 업로드 칸에 만족도 이미지를 넣으면 오류가 표시된다.
- 만족도조사 업로드 칸에 선별검사지 이미지를 넣으면 오류가 표시된다.
- 올바른 파일은 정상 인식으로 이어진다.

자동 검증:

- CAGI fixture 파일은 `cagi`로 분류된다.
- 만족도 fixture 파일은 `satisfaction`으로 분류된다.
- 서로 뒤바뀐 입력은 API에서 `FORM_TYPE_MISMATCH`로 실패한다.
- 알 수 없는 이미지는 `unknown`으로 분류된다.

---

## 4.5 검수 화면 고도화

### 구현 단위

파일:

- `src/components/RecognitionReview.tsx`
- `src/lib/recognition/detectCheckmarks.ts`

작업:

1. 인식 결과에 candidates를 포함한다.
2. 낮은 신뢰도 필드를 우선적으로 눈에 띄게 표시한다.
3. 가능하면 원본 이미지 또는 crop preview를 표시한다.
4. 저장 전 필수값 누락을 명확히 안내한다.
5. 재촬영 권장 조건을 메시지로 표시한다.

### 검증 방법

수동 검증:

- low confidence 필드가 검수 화면에서 구분된다.
- 사용자가 low confidence 값을 수정하고 저장할 수 있다.
- 검증 실패 시 저장되지 않고 오류가 표시된다.

자동 검증:

- confidence 값별 배지 렌더링 테스트 후보를 만든다.
- 필수값 누락 draft 저장 시 `/api/students`가 검증 오류를 반환하는지 확인한다.

---

## 4.6 PDF 처리 안정화

### 구현 단위

파일:

- `src/components/ImageUploadPanel.tsx`
- `src/app/api/upload/route.ts`
- 신규 후보: `src/lib/pdf/pdfToImages.ts`

작업 방향 A: 클라이언트 유지

- `pdf.js` 로드 방식을 명확히 한다.
- CDN 전역 객체가 없을 때 사용자에게 명확한 오류를 표시한다.

작업 방향 B: 백엔드 전환

- 서버에서 PDF 페이지를 이미지로 변환한다.
- `tmp/jobs/{jobId}/uploads/{type}/page_001.png` 구조로 저장한다.
- 페이지 수를 기준으로 장수 일치 검증을 수행한다.

권장:

- 운영 안정성은 백엔드 전환이 더 낫다.
- 다만 서버 PDF 렌더링 의존성이 추가될 수 있으므로 환경 제약을 먼저 확인한다.

### 검증 방법

수동 검증:

- 선별검사지 PDF 1개와 만족도 PDF 1개를 업로드한다.
- 페이지 수가 같으면 분석 버튼이 활성화된다.
- 페이지 수가 다르면 오류가 표시된다.

자동 검증:

- 2페이지 PDF fixture를 업로드하면 이미지 2장이 생성되는지 확인한다.
- 페이지 수 불일치 테스트를 추가한다.

---

## 4.7 임시 파일 정리 정책

### 구현 단위

파일:

- `src/lib/storage/jobStore.ts`
- `src/lib/excel/templateManager.ts`
- 신규 후보: `src/app/api/jobs/cleanup/route.ts`

작업:

1. 작업 생성 시간을 기록한다.
2. 일정 시간 지난 job 폴더를 정리한다.
3. 사용자가 돌아가기 또는 새 작업 시작 시 현재 job 정리 여부를 결정한다.
4. 다운로드 파일 보존 기간을 정한다.
5. 개인정보가 포함된 이미지 파일이 서버에 장기 보존되지 않도록 한다.

### 검증 방법

수동 검증:

- 작업 취소 후 해당 job 업로드 폴더가 정리되는지 확인한다.
- 새 작업에서 이전 이미지가 보이지 않는지 확인한다.

자동 검증:

- 오래된 job 디렉터리만 삭제되는지 테스트한다.
- 현재 진행 중인 job 디렉터리는 삭제되지 않는지 테스트한다.

---

## 5. 테스트 확장 계획

현재 테스트:

```text
tests/validation.test.ts
tests/excel.test.ts
tests/integration.test.ts
tests/recognition-mark-density.test.ts
tests/form-classifier.test.ts
tests/recognize-form-mismatch.test.ts
tests/job-cleanup.test.ts
```

테스트 상태:

| 테스트 파일 | 목적 | 상태 |
|---|---|
| `tests/validation.test.ts` | 학생 데이터 검증 규칙 테스트 | 완료 |
| `tests/excel.test.ts` | 엑셀 쓰기 및 템플릿 보존 테스트 | 완료 |
| `tests/integration.test.ts` | 작업 생성 → 업로드 → 인식 → 저장 → 다운로드 통합 테스트 | 완료 |
| `tests/recognition-mark-density.test.ts` | ROI 마킹 밀도 계산 단위 테스트 | 완료 |
| `tests/form-classifier.test.ts` | 이미지 내용 기반 양식 종류 판별 테스트 | 완료 |
| `tests/recognize-form-mismatch.test.ts` | 업로드 칸과 실제 양식 불일치 감지 테스트 | 완료 |
| `tests/job-cleanup.test.ts` | 임시 작업 파일 삭제 정책 테스트 | 완료 |
| `tests/camera-capture.test.ts` | 카메라 세션 상태 전환과 파일 생성 로직 테스트 | 후보 |
| `tests/pdf-upload.test.ts` | PDF 페이지 분할 및 장수 검증 테스트 | 후보 |

브라우저 기반 수동 QA:

```text
데스크톱 localhost
모바일 HTTPS 환경
모바일 권한 거부
모바일 후면 카메라
좁은 화면 버튼 줄바꿈
장수 불일치 오류
검수 후 엑셀 다운로드
```

---

## 6. 구현 완료 기준

기능 구현은 다음 기준을 만족해야 완료로 본다.

1. 목업 고정값이 실제 사용자 데이터로 대체된다.
2. 인식 실패 항목은 임의값 대신 빈 값 또는 low confidence로 전달된다.
3. 사용자는 검수 화면에서 모든 인식값을 수정할 수 있다.
4. 저장 시 검증을 통과한 값만 엑셀에 반영된다.
5. 선별검사지와 만족도조사는 같은 학생 행 번호에 저장된다.
6. 파일이 뒤바뀐 경우 감지하거나 최소한 사용자에게 확인을 요구한다.
7. 카메라 또는 업로드 실패 시 복구 가능한 안내가 표시된다.
8. 테스트와 빌드가 통과한다.

필수 검증 명령:

```text
npm.cmd test
npm.cmd run build
```

---

## 7. 권장 작업 시작 순서

실제 코드 작업은 다음 순서로 진행한다.

```text
1. getUserMedia 카메라 세션 구현
2. 카메라 캡처 이미지 업로드 연동
3. 재촬영/재업로드 시 이전 파일 혼입 방지
4. OCR/Form Recognition MVP 좌표 템플릿 작성
5. 체크마크 밀도 계산 구현
6. 기본정보 OCR 또는 좌표 기반 체크 인식 구현
7. 이미지 내용 기반 양식 판별 구현
8. 검수 화면에 낮은 신뢰도/재촬영 안내 추가
9. PDF 처리 안정화
10. 임시 파일 정리 정책 구현
```

이 순서는 사용자가 바로 체감하는 촬영 흐름을 먼저 안정화하고, 이후 인식 정확도와 운영 안정성을 단계적으로 끌어올리는 방식이다.

---

## 8. 구현 상태 기록 — 2026-07-13 기준

### 8.1 완료된 기능

| 기능 | 구현 파일 | 현재 동작 | 검증 |
|---|---|---|---|
| 작업 생성 및 템플릿 복사 | `src/app/api/jobs/route.ts`, `src/lib/excel/templateManager.ts` | 새 jobId를 만들고 CAGI/만족도 엑셀 작업 파일을 생성한다. | `tests/integration.test.ts` |
| 순차/묶음 이미지 업로드 | `src/components/ImageUploadPanel.tsx`, `src/app/api/upload/route.ts` | 선별검사지와 만족도조사 이미지를 type별 prefix로 저장한다. | `tests/integration.test.ts` |
| 순차 재업로드 파일 교체 | `src/app/api/upload/route.ts` | `replaceExisting=true`일 때 같은 type의 이전 업로드 파일을 삭제한다. | `tests/integration.test.ts` |
| 카메라 2장 촬영 흐름 | `src/components/ImageUploadPanel.tsx` | `getUserMedia`로 선별검사지 → 만족도조사 순서로 촬영하고 업로드한다. | 빌드 통과, 수동 QA 필요 |
| 업로드 초기화와 서버 파일 정리 | `src/app/api/jobs/cleanup/route.ts`, `src/lib/storage/jobStore.ts`, `src/components/ImageUploadPanel.tsx` | 화면 초기화 시 업로드 폴더를 삭제하고 UI 카운트를 초기화한다. | `tests/job-cleanup.test.ts` |
| 잘못된 jobId 차단 | `src/app/api/upload/route.ts`, `src/app/api/recognize/route.ts` | 존재하지 않는 작업에 대한 업로드/인식 요청을 404로 반환한다. | `tests/job-cleanup.test.ts` |
| 만료 작업 정리 API | `src/app/api/jobs/cleanup/route.ts`, `src/lib/storage/jobStore.ts` | 24시간 TTL 기준으로 오래된 job 세션과 폴더를 삭제한다. | `tests/job-cleanup.test.ts` |
| ROI 마킹 밀도 계산 | `src/lib/recognition/markDensity.ts` | 후보 영역의 어두운 픽셀 비율과 점수 차이로 후보값/신뢰도를 산출한다. | `tests/recognition-mark-density.test.ts` |
| CAGI 일부 ROI 인식 MVP | `src/lib/recognition/roiTemplates.ts`, `src/lib/recognition/detectCheckmarks.ts` | CAGI 성별 및 문항 선택지 ROI를 분석해 draft에 반영한다. | `tests/integration.test.ts`, `tests/recognition-mark-density.test.ts` |
| 만족도 ROI 인식 MVP | `src/lib/recognition/roiTemplates.ts`, `src/lib/recognition/detectCheckmarks.ts` | 만족도 문항 1~10 선택지 ROI를 분석해 draft에 반영한다. | `tests/satisfaction-recognition.test.ts` |
| 이미지 내용 기반 양식 판별 MVP | `src/lib/recognition/classifyForm.ts` | CAGI/만족도 선택지 배치와 마킹 밀도 패턴으로 양식 종류를 판별한다. 파일명은 보조 힌트로 사용한다. | `tests/form-classifier.test.ts` |
| 업로드 칸과 실제 양식 불일치 감지 | `src/app/api/recognize/route.ts` | `cagi_` 파일이 만족도 양식으로 판별되거나 반대인 경우 `FORM_TYPE_MISMATCH`를 반환한다. | `tests/recognize-form-mismatch.test.ts` |
| 검수 화면 신뢰도/원본/crop 확인 | `src/components/RecognitionReview.tsx`, `src/app/api/uploads/image/route.ts`, `src/app/api/uploads/crop/route.ts` | low/medium confidence 항목을 강조하고 후보 점수 상위 3개, 원본 이미지, 선택지 영역 crop preview를 표시한다. | 수동 UI 확인 필요 |
| 검수 후 저장 및 엑셀 반영 | `src/components/RecognitionReview.tsx`, `src/app/api/students/route.ts`, `src/lib/excel/*` | 검증 통과 draft를 CAGI/만족도 엑셀 같은 행 번호에 저장한다. | `tests/integration.test.ts`, `tests/excel.test.ts` |
| 엑셀 다운로드 | `src/app/api/download/route.ts` | 작업 파일을 타입별로 다운로드한다. | `tests/integration.test.ts` |

### 8.2 부분 구현 또는 제한 사항

| 영역 | 현재 상태 | 남은 작업 |
|---|---|---|
| OCR/Form Recognition | CAGI와 만족도 선택지 ROI MVP가 구현됐다. | 기본정보 OCR/ROI 인식, 실제 촬영 이미지 정확도 보정이 필요하다. |
| 양식 판별 | 선택지 배치 기반 MVP이다. | 제목 OCR, 더 많은 실제 샘플 기반 임계값 튜닝, `unknown` 안내 고도화가 필요하다. |
| 검수 화면 | draft 값 수정, 저장, low/medium confidence 강조, 후보값 표시, 원본 이미지, 필드별 crop preview 확인이 가능하다. | 실제 샘플 기반 표시 품질 QA가 필요하다. |
| PDF 처리 | 클라이언트 `pdf.js` 전역 객체 의존 방식이다. | 서버 변환 또는 안정적인 번들 로드 방식으로 전환이 필요하다. |
| 임시 파일 정리 | API와 TTL 함수는 있다. | 새 작업 생성 시 자동 호출, 다운로드 만료 정책, 운영 배치/스케줄 연결이 필요하다. |
| 카메라 QA | 기능은 구현됐다. | 모바일 HTTPS 실기기, 권한 거부, 후면 카메라, 어두운 환경 수동 QA가 필요하다. |

### 8.3 현재 자동 검증 명령 결과

마지막 확인 기준:

```text
npm.cmd test
→ 8 files, 30 tests 통과

npm.cmd run build
→ Next.js production build 통과
```

### 8.4 다음 권장 작업

1. 실제 촬영 샘플 여러 장으로 양식 판별 및 CAGI/만족도 ROI 임계값을 튜닝한다.
2. 기본정보 연령대, 학교유형, 학년 인식 로직을 구현한다.
3. 실제 촬영 샘플 기반 crop preview/ROI 좌표 품질을 튜닝한다.
4. PDF 처리를 서버 변환 또는 안정적인 클라이언트 번들 방식으로 정리한다.

---

## 2026-07-29 진행 현황 업데이트

이번 작업에서 OCR/Form Recognition MVP의 기본정보 영역을 일부 확장했다.

완료:

- CAGI 양식의 `basic.schoolType` ROI 후보군을 추가했다.
- CAGI 양식의 `basic.grade` ROI 후보군을 추가했다.
- 체크박스 인식 결과를 실제 저장값인 `초등학교`, `중학교`, `고등학교`, `학교외기관`, `1학년`~`6학년`으로 매핑하도록 했다.
- `basic.age` 영역은 숫자 OCR 전 단계로 crop 가능한 field region으로 등록했다.
- 검수 화면과 crop API에서 나이 영역 preview를 확인할 수 있게 했다.

다음 작업 후보:

1. 실제 촬영 샘플로 학교유형/학년 ROI 좌표와 confidence 임계값을 보정한다.
2. `basic.age` 숫자 OCR 또는 간단한 digit segmentation 방식을 붙인다.
3. 기본정보 crop preview를 검수 화면에서 더 읽기 쉬운 크기와 안내 상태로 다듬는다.
4. 만족도 양식에도 필요 시 기본정보 영역 crop 또는 복사 검증을 추가한다.

로컬 서버 확인 항목:

- CAGI 이미지를 업로드하고 검수 화면에서 학교유형/학년 자동 입력값을 확인한다.
- 나이 입력칸 아래 crop preview가 CAGI 원본의 나이 영역을 보여주는지 확인한다.
- 학교유형/학년 crop preview와 후보 점수 chip이 실제 체크 위치와 맞는지 확인한다.
- 값 수정 후 저장, 검증, 엑셀 반영 흐름이 기존처럼 이어지는지 확인한다.
