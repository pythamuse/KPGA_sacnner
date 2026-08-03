# PDF 일괄 스캔 렌더링 멈춤 수정

> 이 문서는 기존 `Docs/15_PDF_RENDERING_FIX_CANDIDATES.md`, `Docs/16_PDF_FIX_CANDIDATE_A_TEST_RESULTS.md`,
> `Docs/17_VERCEL_STATEFULNESS_AND_JBIG2_ISSUES.md`(2절, JBIG2 부분)을 통합한 문서입니다.

## 배경

2026-08-01, 실제 현장 PDF 2건(`선별검사 샘플1.pdf`, `만족도조사1.pdf`, 각 19페이지)을 일괄 스캔 업로드로 넣으면 "PDF 페이지를 변환하고 있습니다 (1/19)"에서 진행이 멈추고 다시는 진행되지 않는다. 사용자에게는 오류 메시지 없이 무한 로딩처럼 보인다.

## 작업 내용

### 1. 원인 조사

실제 Chrome에서 `src/components/ImageUploadPanel.tsx`의 `convertPdfToImages()`/`renderPdfPageToFile()`이 호출하는 pdf.js 단계를 하나씩 직접 실행하며 타임아웃을 걸어 확인:

| 단계 | 결과 |
|---|---|
| `pdfjsLib.getDocument()` | 정상 (수십 ms), 19페이지 확인 |
| `page.getTextContent()` | 정상, 텍스트 항목 0개 (순수 스캔 이미지 페이지) |
| `page.getOperatorList()` | 정상, 연산 5개(이미지 1장 그리기 수준) |
| `page.render({canvasContext, viewport})` | **15~30초 이상 응답 없음. 무한 대기.** |

`getOperatorList()`는 빠른데 `render()`만 멈춘다는 것은 PDF 구조 파싱은 문제없고, 임베딩된 이미지를 디코딩/래스터화하는 단계에서 멈춘다는 뜻이다. 스캐너 소프트웨어가 흑백 스캔 문서에 흔히 쓰는 CCITT G4/JBIG2류 압축 이미지를, 이 앱이 CDN으로 고정해 쓰던 pdf.js `3.4.120`(2023년 빌드)이 처리하다 멈추는 유형으로 추정.

기존 자동 테스트가 못 잡은 이유: `tests/*.test.ts`는 전부 합성 PNG/SVG 이미지를 쓰고, 실제 브라우저의 pdf.js 렌더링 경로를 통과한 적이 없었다.

### 2. 후보 비교

- **후보 A — 클라이언트 pdf.js 버전/로딩 방식 교체**: 변경 범위 작음, 서버 의존성 불필요, pdf.js 자체 버그 수정을 그대로 받음. 다만 v4+ 부터는 UMD 빌드가 없어 ES 모듈(`.mjs`) 전환이 필요.
- **후보 B — PDF→이미지 변환을 서버로 이전**: poppler/mupdf/pdfium 계열이 스캔 이미지 코덱을 더 안정적으로 지원하지만, Vercel 서버리스에서의 검증이 필요하고 변경 범위가 큼.

→ 후보 A부터 시도, 실패 시 B로 전환하는 방향으로 진행.

### 3. 후보 A 구현 (pdf.js 3.4.120 → 6.1.200 ES 모듈 전환)

- 3.11.174(3.x 최신, UMD 유지)로 먼저 시도 → **실패**(동일하게 20초 이상 멈춤, 3.x 라인 안에서는 해결 안 됨).
- 6.1.200(ESM 전환)으로 재시도:
  - `src/app/layout.tsx`: `<script type="module">`로 교체, `import * as pdfjsLib from '.../pdf.min.mjs'` 후 `window.pdfjsLib`에 재노출.
  - `src/components/ImageUploadPanel.tsx`: `GlobalWorkerOptions.workerSrc`를 `.../pdf.worker.min.mjs`(6.1.200)로 변경.

### 4. JBIG2 잔존 버그 재발견 (2026-08-02, PR #3 Vercel 프리뷰 재현 테스트)

"38페이지 전부 13ms 내외로 렌더링 성공"이라던 이전 검증은 **1페이지만 반복 테스트**한 결과였음이 드러남. 같은 파일의 **6페이지를 단독 렌더링**하면:

```
page.render() 호출 → 50초 이상 응답 없음 (완전히 멈춤, 타임아웃 아님)
```

브라우저 콘솔에는 다음이 반복 출력됨:
```
Warning: Unable to decode image "img_p6_1": "JBig2Error: JBig2 failed to initialize".
Warning: Dependent image isn't ready yet
... (img_p7_1 ~ img_p18_1까지 반복)
```

즉 pdf.js 6.1.200으로도 "PDF 렌더링 멈춤"이 전부 해결된 게 아니라, 우연히 1페이지가 JBIG2를 안 쓰는 페이지라 통과했을 뿐이고, JBIG2로 인코딩된 페이지는 여전히 멈춘다. pdf.js는 순수 JS 자체 JBIG2 디코더를 쓰는데, 특정 스캐너가 만드는 JBIG2 인코딩 방식에서 취약점이 있는 것으로 보인다.

이 문제는 인식 신뢰도가 대부분 "낮음"으로 나오는 문제와도 연결될 수 있다는 가설이 있다: 디코딩이 실패하면 pdf.js가 해당 이미지를 빈 화면/깨진 상태로 넘길 수 있고, 그 경우 서버로 올라가는 이미지 자체가 내용이 없는 상태일 수 있다(단, 타임아웃으로 막힌 페이지는 애초에 전송조차 안 됨).

## 테스트 결과

### 후보 A, 1차 검증 (2026-08-02 이전, 단일 페이지 반복)

- pdf.js API 직접 호출: 두 PDF 전체(19+19=38페이지) `page.render()` 호출, 전 페이지 성공, 페이지당 11~13ms.
- 실제 앱 UI E2E: 1·2단계 PDF 업로드 → 변환 19장씩 전부 성공, `POST /api/recognize` 200 OK, `FORM_TYPE_MISMATCH` 재현 안 됨.
- `npm test`: 8 files, 31 tests 통과. `npm run build`: 통과.
- 검수 화면 개별 항목(연령대 제외)은 여전히 "낮음"으로 표시 — 이는 ROI 좌표 튜닝 미비라는 별개의 기지 한계로 판단(당시 결론).

### JBIG2 재발견 이후 (2026-08-02, 다중 페이지 재현)

- 같은 파일의 6페이지 단독 렌더링 시 50초 이상 무응답 재현 확인.
- 위 "38페이지 전부 성공" 결론은 **정정 필요** — 1페이지만 반복 검증한 표본 오류였음.
- `src/lib/pdf/withTimeout.ts`(페이지별 타임아웃 방어 코드)는 유효했다 — 최소한 "영원히 멈춘 것처럼 보이는" 상황은 20초 후 명확한 오류로 바뀐다. 다만 이는 증상 완화이지 근본 해결이 아니다.

## 다음 작업을 위한 피드백

- **미해결**: JBIG2 인코딩 페이지의 렌더링 멈춤. pdf.js의 순수 JS JBIG2 디코더 자체의 한계로 보이며, CDN 버전을 더 올려서 해결될지는 미확인.
- **권장 후속 방향**: 애초에 후보 B로 남겨뒀던 "PDF→이미지 변환을 서버의 더 성숙한 라이브러리(poppler/mupdf/pdfium)로 이전". 새 라이브러리 조사·Vercel 서버리스 호환성 검증이 필요한 별도 작업 규모.
- 여전히 외부 CDN(cdnjs.cloudflare.com) 의존 — CDN 장애 시 PDF 업로드 전체가 막히는 리스크는 이번 수정으로 해결되지 않음.
- 페이지별 타임아웃(`withTimeout.ts`)은 계속 유지할 것 — JBIG2가 근본 해결되기 전까지는 유일한 안전장치.
