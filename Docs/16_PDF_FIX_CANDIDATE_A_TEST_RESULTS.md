# PDF_FIX_CANDIDATE_A_TEST_RESULTS — 후보 A 검증 결과

`Docs/15_PDF_RENDERING_FIX_CANDIDATES.md`에서 정리한 후보 A(클라이언트 pdf.js 버전/로딩 방식 교체)를 실제 현장 샘플 PDF 2건(`선별검사 샘플1.pdf`, `만족도조사1.pdf`, 각 19페이지)으로 검증했다. 코드 수정은 Codex CLI로 수행했다.

## 1. 시도 1 — pdf.js 3.4.120 → 3.11.174 (버전 문자열만 교체)

- 변경: `src/app/layout.tsx`의 `<script src>`와 `src/components/ImageUploadPanel.tsx`의 `GlobalWorkerOptions.workerSrc`의 버전 번호만 3.11.174로 변경(3.x 라인 최신, UMD 빌드 그대로 유지).
- 검증: 실제 Chrome에서 `page.render()` 호출을 직접 계측.
- **결과: 실패.** 3.11.174에서도 동일하게 `page.render()`가 20초 이상 응답 없이 멈춘다. 3.x 라인 안에서는 해결되지 않음을 확인.

## 2. 시도 2 — pdf.js 6.1.200 (ES 모듈 전환)

- 변경 내용:
  - `src/app/layout.tsx`: 기존 `<script src="...pdf.min.js" defer>` 태그를 인라인 `<script type="module">`로 교체. `import * as pdfjsLib from '.../pdf.min.mjs'` 후 `window.pdfjsLib = pdfjsLib`로 재노출해, 기존 코드가 참조하는 `window.pdfjsLib` 전역을 그대로 유지.
  - `src/components/ImageUploadPanel.tsx`: `GlobalWorkerOptions.workerSrc`를 `.../pdf.worker.min.mjs`(6.1.200)로 변경.
  - cdnjs 확인 결과 pdf.js는 v4부터 UMD(`pdf.min.js`) 빌드를 완전히 중단하고 ES 모듈(`.mjs`)만 배포하므로, 3.x 이후로 올리려면 이 로딩 방식 전환이 필수였다.

### 검증 1 — pdf.js API 직접 호출 (실제 Chrome, 콘솔 계측)

두 PDF의 전체 페이지(19+19=38페이지)에 대해 `page.render({canvasContext, viewport})`를 직접 호출해 소요 시간을 측정했다.

| 파일 | 페이지 수 | 결과 | 페이지당 소요 시간 |
|---|---:|---|---:|
| 선별검사 샘플1.pdf | 19 | 전 페이지 성공 | 11~13ms |
| 만족도조사1.pdf | 19 | 전 페이지 성공 | 11~13ms |

이전(3.4.120/3.11.174)에는 페이지 1에서 20~30초 이상 멈췄던 것과 비교하면, 38페이지 전체가 총 0.5초 이내에 끝났다.

### 검증 2 — 실제 앱 UI를 통한 엔드투엔드 테스트 (일괄 스캔 업로드)

로컬 개발 서버에서 실제 화면 흐름 그대로(청소년 트랙, 일괄 스캔 업로드) 두 PDF를 업로드했다.

| 단계 | 결과 |
|---|---|
| 1단계 선별검사지 PDF 업로드 → 변환 | 19장 전부 성공 (몇 초 내 완료, 멈춤 없음) |
| 2단계 만족도조사 PDF 업로드 → 변환 | 19장 전부 성공 |
| 장수 일치 확인 | 19장 vs 19장, 일치 |
| `POST /api/recognize` | **200 OK** — `FORM_TYPE_MISMATCH` 없이 19쌍 전부 통과 |
| 검수 화면 | "1 / 19번째 학생 데이터" 정상 표시 |

이전에 사용자가 실제로 겪었던 `FORM_TYPE_MISMATCH`("업로드 칸과 이미지 내용이 다른 파일이 10개 있습니다") 오류도 이번 두 샘플 파일 기준으로는 재현되지 않았다. render() 단계에서 멈추거나(또는 손상된 프레임으로) 넘어갔던 이미지가 양식 판별 점수 계산에 나쁜 영향을 줬을 가능성이 있으며, 렌더링이 정상화되면서 함께 해소된 것으로 보인다.

다만 검수 화면의 개별 항목(연령대 제외 전부)은 여전히 "낮음(low confidence)"으로 표시된다. 이는 별개의, 이미 문서화된 한계다 — ROI 좌표가 참고 이미지 1장 기준으로 만들어져 있어 실제 촬영/스캔 샘플에 대한 임계값 튜닝이 아직 안 된 상태이기 때문이다(`04_OCR_FORM_RECOGNITION_SPEC.md`, `12_REAL_FEATURE_IMPLEMENTATION_ROADMAP.md`에 이미 명시). 값이 임의로 잘못 채워지지 않고 낮은 신뢰도로 남아 수동 입력을 요구하는 것은 설계상 의도된 동작이며 오류가 아니다.

### 회귀 테스트

- `npm test`: 8 files, 31 tests 통과 (기존 자동 테스트는 pdf.js 브라우저 렌더링 경로를 타지 않으므로 영향 없음, 회귀 없음 확인됨)
- `npm run build`: 정상 통과

## 3. 결론

**후보 A(pdf.js를 6.1.200 ES 모듈 방식으로 전환)로 근본 문제가 해결된다.** 후보 B(서버 전환)는 당장은 불필요하다. 다만 다음은 별도로 남아있다.

- `convertPdfToImages()`에 페이지별 타임아웃이 여전히 없다. 이번에는 실제로 빠르게 끝나서 드러나지 않았지만, 앞으로 다른 PDF에서 유사한 디코딩 지연이 재발할 가능성에 대비해 방어 코드는 별도로 추가해야 한다(`15_PDF_RENDERING_FIX_CANDIDATES.md`에 이미 명시).
- 여전히 외부 CDN(cdnjs.cloudflare.com)에 의존한다. CDN 장애 시 PDF 업로드 전체가 막히는 리스크는 이번 수정으로 해결되지 않는다.
- 검수 화면 신뢰도가 대부분 낮게 나오는 ROI 튜닝 문제는 이번 수정 범위 밖이며 별도 작업이 필요하다.
