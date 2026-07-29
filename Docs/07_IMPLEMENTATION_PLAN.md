# IMPLEMENTATION_PLAN — 구현 계획

## 1. 권장 기술 구조

웹 기반으로 구현한다.

예시 스택:

| 영역 | 권장 선택지 |
|---|---|
| 프론트엔드 | Next.js 또는 React |
| 백엔드 | Node.js API Route 또는 Express |
| 엑셀 처리 | 원본 보존 능력 검증 후 라이브러리 선택 |
| 이미지 처리 | 서버 측 이미지 전처리 + OCR/Form Recognition 모듈 |
| 임시 저장소 | 서버 local tmp, S3 호환 스토리지, 또는 세션 스토리지 |
| 배포 | Vercel, Render, Railway, 자체 서버 등 |

단, 엑셀 템플릿의 `x14:dataValidations` 보존이 중요하므로, 엑셀 라이브러리는 반드시 사전 검증 후 확정한다.

---

## 2. 모듈 구조

```text
src/
  app/
    page.tsx
    api/
      jobs/
      upload/
      recognize/
      students/
      download/
  components/
    NewJobButton.tsx
    ImageUploadPanel.tsx
    RecognitionReview.tsx
    StudentTable.tsx
    ErrorSummary.tsx
  lib/
    validation/
      normalize.ts
      validateStudent.ts
      schemas.ts
    excel/
      loadTemplates.ts
      writeCagi.ts
      writeSatisfaction.ts
      verifyWorkbook.ts
    recognition/
      classifyForm.ts
      extractCagi.ts
      extractSatisfaction.ts
      preprocessImage.ts
    storage/
      jobStore.ts
      tempFiles.ts
  tests/
    validation.test.ts
    excel.test.ts
    integration.test.ts
```

---

## 3. 단계별 구현

### Phase 1. 데이터 모델·검증

목표:

- OCR 없이 수동 입력 JSON만으로 검증 가능해야 한다.

작업:

1. StudentData 타입 정의
2. 정규화 함수 작성
3. 검증 함수 작성
4. 예시 데이터 테스트 작성

완료 기준:

- 예시 데이터가 통과한다.
- 잘못된 성별, 학년, 만족도 값이 실패한다.

### Phase 2. 엑셀 쓰기

목표:

- OCR 없이 예시 JSON을 엑셀 2개에 정확히 입력한다.

작업:

1. 원본 템플릿 복사
2. CAGI 3행 쓰기
3. 만족도 3행 쓰기
4. 10명 반복 입력 테스트
5. 저장 후 재읽기 검증
6. 드롭다운 보존 확인

완료 기준:

- CAGI와 만족도 파일의 행 번호가 일치한다.
- 예시 값이 정확히 입력된다.
- 엑셀 양식이 깨지지 않는다.

### Phase 3. 웹 UI

목표:

- 사용자가 웹에서 작업 생성, 이미지 업로드, 결과 확인, 다운로드를 할 수 있다.

작업:

1. 새 작업 화면
2. 학생 추가 화면
3. 선별검사지 이미지 업로드 칸
4. 만족도 이미지 업로드 칸
5. 인식 결과 확인 화면
6. 학생 목록
7. 다운로드 버튼

완료 기준:

- OCR 없이 mock 인식 결과로 전체 흐름이 작동한다.

### Phase 4. 이미지 인식 MVP

목표:

- 예시 이미지에서 필요한 값을 추출하거나 최소한 사용자 확인용 후보값을 생성한다.

작업:

1. 양식 종류 분류
2. 이미지 전처리
3. 관심 영역 정의
4. 체크마크 감지
5. OCR 보조 인식
6. 신뢰도 산출

완료 기준:

- 예시 이미지에서 기대값을 생성한다.
- 낮은 신뢰도 항목은 확인 필요로 표시한다.

### Phase 5. 운영 안정화

목표:

- 실제 현장 이미지에서 오류를 줄인다.

작업:

1. 다양한 촬영 이미지 수집
2. 실패 케이스 분류
3. 재촬영 안내 개선
4. 관심 영역 보정
5. 검증 로그 개선
6. 개인정보 로그 제거

---

## 4. API 설계 초안

### 4.1 새 작업 생성

```http
POST /api/jobs
```

응답:

```json
{
  "jobId": "job_abc123"
}
```

### 4.2 이미지 업로드

```http
POST /api/jobs/{jobId}/upload
```

요청:

- multipart/form-data
- type: `cagi` 또는 `satisfaction`
- file: image

응답:

```json
{
  "imageId": "img_abc123",
  "formType": "cagi"
}
```

### 4.3 이미지 인식

```http
POST /api/jobs/{jobId}/recognize
```

요청:

```json
{
  "cagiImageId": "img_1",
  "satisfactionImageId": "img_2"
}
```

응답:

```json
{
  "studentDraft": {
    "basic": {},
    "cagi": {},
    "satisfaction": {},
    "confidence": {}
  },
  "warnings": []
}
```

### 4.4 학생 저장

```http
POST /api/jobs/{jobId}/students
```

요청:

```json
{
  "student": {}
}
```

응답:

```json
{
  "ok": true,
  "row": 3
}
```

### 4.5 다운로드

```http
POST /api/jobs/{jobId}/download
```

응답:

```json
{
  "cagiDownloadUrl": "...",
  "satisfactionDownloadUrl": "..."
}
```

---

## 5. 개발 우선순위

| 우선순위 | 작업 |
|---:|---|
| 1 | 데이터 모델·검증 |
| 2 | 엑셀 정확 입력 |
| 3 | 템플릿 보존 테스트 |
| 4 | 사용자 확인 UI |
| 5 | 이미지 업로드 |
| 6 | OCR/Form Recognition |
| 7 | 다운로드 |
| 8 | 개인정보·임시파일 삭제 |

---

## 6. 권장 MVP 전략

처음부터 OCR 완성도를 목표로 하지 말고, 다음 순서로 구현한다.

1. 수동 입력값으로 엑셀 자동 생성 성공
2. Mock OCR 결과로 UI 흐름 성공
3. 예시 이미지 2장에 대한 인식 성공
4. 실제 현장 사진을 추가하면서 인식률 개선

이 순서를 지키면 엑셀 업로드 실패 문제를 먼저 해결하고, OCR은 점진적으로 고도화할 수 있다.
