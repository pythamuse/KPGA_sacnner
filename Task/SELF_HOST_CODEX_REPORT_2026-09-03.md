# 제3자 런타임 파일 자체 호스팅 — pdf.js·OpenCV·kor OCR 모델을 앱 출처에서 (2026-09-03)

사용자 승인(2026-09-03; "자체 호스팅 = 같은 앱 배포에서 라이브러리 파일까지 제공, 새 인프라 없음"). Docs/17 §3.17.
코덱스(테라-최대) 위임, 브랜치 `codex-self-host`, 커밋 `61ef803`, 병합 `a8dfef4`. 파일은 위임자가 고정 URL에서 내려받아
SHA-256을 기록한 뒤 체크아웃에 넣어 줬다(`public/vendor/README.md`). §0은 위임자의 판정, 그 뒤는 코덱스 보고서 원문.

## 0. 판정 — 병합

- 값 경로 무변경(인식 코드는 kor 워커의 `langPath`·`gzip` 옵션만). 메인 시험 468/0, tsc 통과.
- 코드에서 외부 출처 문자열 0(`cdnjs`·`unpkg`·`docs.opencv.org`), CSP `script-src 'self' …`, `connect-src 'self' data: blob:`.
  `'unsafe-eval'`은 OpenCV emscripten 때문에 유지.
- **dev 서버(브라우저)**: pdf.js가 `/vendor/pdfjs/6.1.200/pdf.min.mjs`로 로드, 리소스 타이밍에 외부 요청 0, HTML에 cdnjs 없음.
- **프로덕션 빌드(같은 날)**: `npm run build` 통과, `.nft.json`에 kor·eng 모델과 워커 스크립트 추적됨. `next start`(3001)에서 세트 1
  업로드·인식: 리소스는 `/vendor/pdfjs/6.1.200/pdf.min.mjs`·`pdf.worker.min.mjs`·`wasm/jbig2.wasm`뿐, 외부 요청 0,
  `/vendor/opencv/4.9.0/opencv.js`(10,257,356B)·`wasm/openjpeg.wasm` HEAD 200. 서버 로그에 워커·모델·CDN 오류 없음, OCR 동작
  (diacritics 로그 4). 결과 자동 339·나이 p1/p18=14 — dev 기준선과 동일.
- 저장소 +13MB(`public/vendor`) + kor 모델 15MB(`src/lib/recognition/assets`, 번들 추적).
- 남는 위험: 라이브러리 갱신은 수동(README의 절차). Vercel 정적 전송량이 첫 방문당 ≈12MB 늘지만 브라우저 캐시 뒤에는 0 —
  사용자가 확인한 Vercel 병목은 Blob 연산이라 이 변경과 무관.

# (코덱스 보고서 원문) 제3자 런타임 파일 자체 호스팅 보고서

- 브랜치: `codex-self-host`
- 작업 기준일: 2026-09-03
- 범위: PDF.js 6.1.200, OpenCV.js 4.9.0, 서버 kor OCR 모델을 앱과 같은 출처에서 제공

## 바꾼 파일:행

- `src/lib/pdf/pdfRenderConfig.ts:3-8` — `PDFJS_VERSION` 기반 `/vendor/pdfjs/${PDFJS_VERSION}/` 경로와 메인/워커/WASM URL을 구성.
- `src/app/layout.tsx:3,22` — 인라인 모듈 import를 `PDFJS_MAIN_SRC`로 변경.
- `src/lib/documentScanner/loadOpenCv.ts:1` — 메인 스레드 OpenCV script 경로를 `/vendor/opencv/4.9.0/opencv.js`로 변경.
- `src/lib/documentScanner/perspectiveCorrect.worker.ts:18` — 워커 `importScripts` 경로를 같은 출처 경로로 변경.
- `src/lib/recognition/ocrTextLines.ts:1541-1546` — kor worker에 `langPath`, `gzip: false`와 기존 cache/worker 경로를 함께 전달.
- `next.config.mjs:12-27` — 런타임 세 외부 출처를 CSP에서 제거하고 현재 third-party origin 주석을 갱신.
- `tests/pdf-render-config.test.ts:3-25` — PDF.js 메인/워커/WASM URL이 버전 기반 `/vendor/...`이고 외부 호스트가 아님을 고정.
- `tests/security-config.test.ts:1-20` — 실제 `next.config.mjs` CSP에서 cdnjs·unpkg·docs.opencv.org가 제거됐음을 고정.
- `public/vendor/README.md:1-34` — 각 vendor 파일의 원본 URL·버전·SHA-256과 갱신 절차를 기록.
- `public/vendor/**` — 사용자 제공 PDF.js/OpenCV 자산 16개를 포함.
- `src/lib/recognition/assets/kor.traineddata` — 사용자 제공 gunzip 해제 kor 모델을 포함(바이너리 파일이라 행 번호 없음).
- `report.md` — 이 보고서.

`next.config.mjs:71-75`의 `outputFileTracingIncludes['/api/recognize']`에 있는 `./src/lib/recognition/assets/**`는 이미 존재했고 그대로 유지했다. `package.json` 및 의존성은 변경하지 않았다.

## 최종 CSP 문자열 전문

```text
default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

`'unsafe-eval'`, `'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `data:`, `blob:`는 유지했다. Google Fonts 출처는 기존 `style-src`·`font-src` 용도 때문에 유지했다.

## SHA-256 목록

아래 해시는 커밋되는 로컬 파일의 SHA-256이다. `public/vendor/README.md`에도 같은 목록과 원본 URL·버전을 기록했다.

| 파일 | SHA-256 |
| --- | --- |
| `public/vendor/pdfjs/6.1.200/pdf.min.mjs` | `4ba2f15599b03fde8755ad91349920c21dadd3e8fd6b6460a7663d46d4cf21b5` |
| `public/vendor/pdfjs/6.1.200/pdf.worker.min.mjs` | `2ab9e09667296dab1a618868b3ce6e6c23d5b8f48120ae7c5b34e7e335ed01fa` |
| `public/vendor/pdfjs/6.1.200/wasm/jbig2.wasm` | `e6bee67724a7b5436fe8162638e3708cfc8d52b6342db69a49715e30ff27cfdc` |
| `public/vendor/pdfjs/6.1.200/wasm/jbig2_nowasm_fallback.js` | `04c795a6657a4553a64b781ea3e85256203d913c3b71b72b85fa3ce00622f458` |
| `public/vendor/pdfjs/6.1.200/wasm/LICENSE_JBIG2` | `9e66b7f1b934a28b37f3bc4dac97915de1674271e79a0a88182a18ed9731b4d1` |
| `public/vendor/pdfjs/6.1.200/wasm/LICENSE_OPENJPEG` | `a6af136f3e15038a666b61f376612a07d9a4e48cb7c01adbf3e33b3f14ab49b6` |
| `public/vendor/pdfjs/6.1.200/wasm/LICENSE_PDFJS_JBIG2` | `aad3cce09842e00e9e11ad5e8fef8cc02fbc3a3768fe2f007443b9cee37aaee5` |
| `public/vendor/pdfjs/6.1.200/wasm/LICENSE_PDFJS_OPENJPEG` | `717fc62da03292dbb4dd0c8280bd4ce7bb8550dcf31d772bc93455fb50313425` |
| `public/vendor/pdfjs/6.1.200/wasm/LICENSE_PDFJS_QCMS` | `eb5104ca33552be007857a28351bc408f379ddd4bfacab1226b09c6d1e9fd7c4` |
| `public/vendor/pdfjs/6.1.200/wasm/LICENSE_QCMS` | `36d847ae882f6574ebc72f56a4f354e4f104fde4a584373496482e97d52d31bc` |
| `public/vendor/pdfjs/6.1.200/wasm/openjpeg.wasm` | `004a0e62db930ba9ff2a22212f4554d0bb57a0635a8287caf70f98117cee14ba` |
| `public/vendor/pdfjs/6.1.200/wasm/openjpeg_nowasm_fallback.js` | `0f998419819da4491d8302222aa9e2ff2494685641aa2a6c21c3760c29f3e319` |
| `public/vendor/pdfjs/6.1.200/wasm/qcms_bg.wasm` | `bfdaeb649178748e54bcdaa819bcd5c5c5a4278c8eaaf5feb5a26071e1c25bfc` |
| `public/vendor/pdfjs/6.1.200/wasm/quickjs-eval.js` | `fe7930418e869791ce892567dbd0bc4698152b7e550b5cefa553992c56ddc325` |
| `public/vendor/pdfjs/6.1.200/wasm/quickjs-eval.wasm` | `7bcacc9f22cacf7e9b23866d2a6d1639693d40c7f144e41b7c69ed37ba9cbe8f` |
| `public/vendor/opencv/4.9.0/opencv.js` | `4d7b85e2e12ea0bd088f491c311d620a45b53d1489b7f065b4492a230bda243a` |
| `src/lib/recognition/assets/kor.traineddata` | `9520bfe9e3cfc38d4a808e036b0287c88a1d37fb80b9a0a23928ddccdd20595b` |

`kor.traineddata` 원본 gzip의 제공된 SHA-256은 `9d454186…`이다. 저장소에는 gunzip 해제 파일만 두었고, worker는 `gzip: false`로 읽는다. README의 17개 asset 행은 로컬 파일과 다시 대조했으며 모두 일치했다.

## 테스트 결과 전문

PowerShell의 실행 정책이 `npx.ps1`을 막으므로, Windows `cmd.exe`에서 요청한 명령을 그대로 실행했다. 두 명령 모두 로컬 `node_modules`를 사용했고 설치·다운로드는 하지 않았다.

### `npx tsc --noEmit`

```text
Process exited with code 0.
stdout/stderr: (empty)
```

### `npx vitest run`

```text
The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

 RUN  v1.6.1 C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/wt-host

 ✓ tests/capture-diagnostics.test.ts  (18 tests) 4ms
 ✓ tests/capture-guidance.test.ts  (29 tests) 6ms
 ✓ tests/tone-normalization.test.ts  (19 tests) 42ms
 ✓ tests/photo-binary-floor.test.ts  (13 tests) 59ms
 ✓ tests/band-structure.test.ts  (22 tests) 58ms
 ✓ tests/photo-binary-refusal.test.ts  (21 tests) 87ms
 ✓ tests/orb-align.test.ts  (17 tests) 111ms
 ✓ tests/ink-invariant.test.ts  (22 tests) 123ms
 ✓ tests/review-snapshot.test.ts  (30 tests) 131ms
 ✓ tests/frame-exposure.test.ts  (29 tests) 90ms
 ↓ tests/_probe-bounds-gate.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-tracedump.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-cells.test.ts  (1 test | 1 skipped)
 ↓ tests/real-scan-measure.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-ensemble.test.ts  (1 test | 1 skipped)
 ✓ tests/recognition-mark-density.test.ts  (19 tests) 355ms
 ↓ tests/_probe-gates.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-features.test.ts  (1 test | 1 skipped)
 ↓ tests/scan-repeat-measure.test.ts  (1 test | 1 skipped)
 ↓ tests/reversed-stack-recognition.test.ts  (1 test | 1 skipped)
 ✓ tests/label-export.test.ts  (5 tests) 53ms
 ✓ tests/grayscale-scan.test.ts  (4 tests) 93ms
 ✓ tests/table-row-detection.test.ts  (11 tests) 506ms
 ✓ tests/validation.test.ts  (11 tests) 5ms
 ↓ tests/_probe-photo-accuracy.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-photo.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-grid-crops.test.ts  (1 test | 1 skipped)
 ✓ tests/batch-matcher.test.ts  (10 tests) 16ms
 ✓ tests/perspective-correct.test.ts  (6 tests) 5ms
 ✓ tests/review-settlement.test.ts  (4 tests) 3ms
 ✓ tests/student-save-payload.test.ts  (3 tests) 54ms
 ✓ tests/student-save-route.test.ts  (3 tests) 9ms
 ✓ tests/table-grid-detection.test.ts  (21 tests) 800ms
 ↓ tests/_probe-photo-trace.test.ts  (1 test | 1 skipped)
 ↓ tests/_probe-grid.test.ts  (1 test | 1 skipped)
 ✓ tests/form-classifier.test.ts  (4 tests) 227ms
 ✓ tests/recognition-crop-source.test.ts  (6 tests) 4ms
 ↓ tests/_probe-photo-gates.test.ts  (1 test | 1 skipped)
 ✓ tests/cagi-early-intervention.test.ts  (2 tests) 5ms
 ✓ tests/review-crop-source.test.ts  (3 tests) 3ms
 ✓ tests/pdf-render-config.test.ts  (2 tests) 6ms
 ✓ tests/grid-override-completeness.test.ts  (11 tests) 1106ms
 ✓ tests/ocr-budget.test.ts  (1 test) 3ms
 ✓ tests/perspective-correction-policy.test.ts  (2 tests) 3ms
 ✓ tests/pdf-timeout.test.ts  (2 tests) 12ms
 ✓ tests/security-config.test.ts  (1 test) 2ms
 ✓ tests/field-crop.test.ts  (1 test) 2ms
 ✓ tests/blank-form-calibration.test.ts  (2 tests) 234ms
stdout | tests/ocr-text-lines.test.ts > OCR text line detection > detects approximate y positions for Korean text lines in a cropped region
ocr-text-lines observation {
  elapsedMs: 722,
  observed: [
    { y: 204, confidence: 93 },
    { y: 284, confidence: 92 },
    { y: 355, confidence: 82 },
    { y: 364, confidence: 93 },
    { y: 376, confidence: 41 },
    { y: 444, confidence: 86 },
    { y: 456, confidence: 83 }
  ]
}

 ✓ tests/ocr-text-lines.test.ts  (2 tests) 798ms
 ✓ tests/template-baseline.test.ts  (2 tests) 502ms
Warning: Invalid resolution 25 dpi. Using 70 instead.
 ✓ tests/review-suggestion.test.ts  (11 tests) 1851ms
 ✓ tests/job-cleanup.test.ts  (3 tests) 45ms
stdout | tests/blank-form-detection.test.ts > real blank-form detection > resolves every CAGI and satisfaction field from grid or row detection
blank-form recognition sources {
  "cagi.q01": "grid",
  "cagi.q02": "grid",
  "cagi.q03": "grid",
  "cagi.q04": "grid",
  "cagi.q05": "grid",
  "cagi.q06": "grid",
  "cagi.q07": "grid",
  "cagi.q08": "grid",
  "cagi.q09": "grid",
  "satisfaction.q01": "grid",
  "satisfaction.q02": "grid",
  "satisfaction.q03": "grid",
  "satisfaction.q04": "grid",
  "satisfaction.q05": "grid",
  "satisfaction.q06": "grid",
  "satisfaction.q07": "grid",
  "satisfaction.q08": "grid",
  "satisfaction.q09": "grid",
  "satisfaction.q10": "grid",
  "basic.gender": "grid",
  "basic.schoolType": "grid",
  "basic.grade": "grid"
}

 ✓ tests/excel.test.ts  (3 tests) 684ms
 ✓ tests/sheet-exposure.test.ts  (8 tests) 2034ms
Warning: Invalid resolution 25 dpi. Using 70 instead.
stdout | tests/blank-form-detection.test.ts > real blank-form detection > keeps detected row centres within 0.01 of the measured template coordinates
blank coordinate comparison [
  {
    "field": "cagi.q01",
    "source": "grid",
    "x": [
      0.6898,
      0.7468,
      0.8092,
      0.8768
    ],
    "y": 0.3337,
    "referenceY": 0.3335
  },
  {
    "field": "cagi.q02",
    "source": "grid",
    "x": [
      0.6898,
      0.7468,
      0.8092,
      0.8768
    ],
    "y": 0.3583,
    "referenceY": 0.3592
  },
  {
    "field": "cagi.q03",
    "source": "grid",
    "x": [
      0.6898,
      0.7468,
      0.8092,
      0.8768
    ],
    "y": 0.3827,
    "referenceY": 0.3848
  },
  {
    "field": "cagi.q04",
    "source": "grid",
    "x": [
      0.6898,
      0.7468,
      0.8092,
      0.8768
    ],
    "y": 0.4004,
    "referenceY": 0.4018
  },
  {
    "field": "cagi.q05",
    "source": "grid",
    "x": [
      0.6898,
      0.7468,
      0.8092,
      0.8768
    ],
    "y": 0.4184,
    "referenceY": 0.4189
  },
  {
    "field": "cagi.q06",
    "source": "grid",
    "x": [
      0.6898,
      0.7468,
      0.8092,
      0.8768
    ],
    "y": 0.4354,
    "referenceY": 0.436
  },
  {
    "field": "cagi.q07",
    "source": "grid",
    "x": [
      0.6898,
      0.7468,
      0.8092,
      0.8768
    ],
    "y": 0.4529,
    "referenceY": 0.4531
  },
  {
    "field": "cagi.q08",
    "source": "grid",
    "x": [
      0.6901,
      0.7471,
      0.8092,
      0.8771
    ],
    "y": 0.5116,
    "referenceY": 0.512
  },
  {
    "field": "cagi.q09",
    "source": "grid",
    "x": [
      0.6901,
      0.7471,
      0.8092,
      0.8771
    ],
    "y": 0.5293,
    "referenceY": 0.53
  },
  {
    "field": "basic.gender",
    "source": "grid",
    "x": [
      0.8031,
      0.9208
    ],
    "y": 0.157,
    "referenceY": 0.154
  },
  {
    "field": "basic.schoolType",
    "source": "grid",
    "x": [
      0.3474,
      0.5246,
      0.3474,
      0.6345
    ],
    "y": 0.1846,
    "referenceY": 0.1788
  },
  {
    "field": "basic.grade",
    "source": "grid",
    "x": [
      0.257,
      0.402,
      0.5471,
      0.257,
      0.402,
      0.5471
    ],
    "y": 0.2186,
    "referenceY": 0.218
  },
  {
    "field": "satisfaction.q01",
    "source": "grid",
    "x": [
      0.6907,
      0.7706,
      0.8513,
      0.9415
    ],
    "y": 0.285,
    "referenceY": 0.2852
  },
  {
    "field": "satisfaction.q02",
    "source": "grid",
    "x": [
      0.8498,
      0.9437
    ],
    "y": 0.4294,
    "referenceY": 0.4293
  },
  {
    "field": "satisfaction.q03",
    "source": "grid",
    "x": [
      0.8498,
      0.9437
    ],
    "y": 0.4776,
    "referenceY": 0.4775
  },
  {
    "field": "satisfaction.q04",
    "source": "grid",
    "x": [
      0.8498,
      0.9437
    ],
    "y": 0.5256,
    "referenceY": 0.5257
  },
  {
    "field": "satisfaction.q05",
    "source": "grid",
    "x": [
      0.8498,
      0.9437
    ],
    "y": 0.5609,
    "referenceY": 0.561
  },
  {
    "field": "satisfaction.q06",
    "source": "grid",
    "x": [
      0.8498,
      0.9437
    ],
    "y": 0.5967,
    "referenceY": 0.5968
  },
  {
    "field": "satisfaction.q07",
    "source": "grid",
    "x": [
      0.5851,
      0.6778,
      0.7618,
      0.8443,
      0.9415
    ],
    "y": 0.7512,
    "referenceY": 0.751
  },
  {
    "field": "satisfaction.q08",
    "source": "grid",
    "x": [
      0.5851,
      0.6778,
      0.7618,
      0.8443,
      0.9415
    ],
    "y": 0.7818,
    "referenceY": 0.7815
  },
  {
    "field": "satisfaction.q09",
    "source": "grid",
    "x": [
      0.5851,
      0.6778,
      0.7618,
      0.8443,
      0.9415
    ],
    "y": 0.8121,
    "referenceY": 0.812
  },
  {
    "field": "satisfaction.q10",
    "source": "grid",
    "x": [
      0.5851,
      0.6778,
      0.7618,
      0.8443,
      0.9415
    ],
    "y": 0.8429,
    "referenceY": 0.842
  }
]
blank basic per-candidate coordinates [
  {
    "field": "basic.schoolType",
    "value": "elementary",
    "templateX": 0.3475,
    "templateY": 0.174,
    "detectedX": 0.3474,
    "detectedY": 0.1718
  },
  {
    "field": "basic.schoolType",
    "value": "middle",
    "templateX": 0.5245,
    "templateY": 0.174,
    "detectedX": 0.5246,
    "detectedY": 0.1718
  },
  {
    "field": "basic.schoolType",
    "value": "high",
    "templateX": 0.3475,
    "templateY": 0.193,
    "detectedX": 0.3474,
    "detectedY": 0.1962
  },
  {
    "field": "basic.schoolType",
    "value": "outside",
    "templateX": 0.6345,
    "templateY": 0.174,
    "detectedX": 0.6345,
    "detectedY": 0.1718
  },
  {
    "field": "basic.grade",
    "value": "grade1",
    "templateX": 0.257,
    "templateY": 0.208,
    "detectedX": 0.257,
    "detectedY": 0.2085
  },
  {
    "field": "basic.grade",
    "value": "grade2",
    "templateX": 0.402,
    "templateY": 0.208,
    "detectedX": 0.402,
    "detectedY": 0.2085
  },
  {
    "field": "basic.grade",
    "value": "grade3",
    "templateX": 0.547,
    "templateY": 0.208,
    "detectedX": 0.5471,
    "detectedY": 0.2085
  },
  {
    "field": "basic.grade",
    "value": "grade4",
    "templateX": 0.257,
    "templateY": 0.228,
    "detectedX": 0.257,
    "detectedY": 0.2282
  },
  {
    "field": "basic.grade",
    "value": "grade5",
    "templateX": 0.402,
    "templateY": 0.228,
    "detectedX": 0.402,
    "detectedY": 0.2282
  },
  {
    "field": "basic.grade",
    "value": "grade6",
    "templateX": 0.547,
    "templateY": 0.228,
    "detectedX": 0.5471,
    "detectedY": 0.2282
  }
]

Warning: Invalid resolution 25 dpi. Using 70 instead.
stdout | tests/review-evidence.test.ts > review evidence serialization > keeps the recognition evidence sidecar within the per-field snapshot budget
recognition evidence bytes [{"field":"cagi.q01","bytes":130},{"field":"cagi.q02","bytes":130},{"field":"cagi.q03","bytes":130},{"field":"cagi.q04","bytes":130},{"field":"cagi.q05","bytes":130},{"field":"cagi.q06","bytes":130},{"field":"cagi.q07","bytes":130},{"field":"cagi.q08","bytes":130},{"field":"cagi.q09","bytes":130},{"field":"satisfaction.q01","bytes":130},{"field":"satisfaction.q02","bytes":130},{"field":"satisfaction.q03","bytes":130},{"field":"satisfaction.q04","bytes":130},{"field":"satisfaction.q05","bytes":130},{"field":"satisfaction.q06","bytes":130},{"field":"satisfaction.q07","bytes":130},{"field":"satisfaction.q08","bytes":130},{"field":"satisfaction.q09","bytes":130},{"field":"satisfaction.q10","bytes":130}]

 ✓ tests/review-evidence.test.ts  (19 tests) 1476ms
 ✓ tests/blank-form-detection.test.ts  (3 tests) 2251ms
Warning: Invalid resolution 25 dpi. Using 70 instead.
Warning: Invalid resolution 25 dpi. Using 70 instead.
 ✓ tests/satisfaction-recognition.test.ts  (3 tests) 2355ms
 ✓ tests/recognize-form-mismatch.test.ts  (3 tests) 1543ms
Warning: Invalid resolution 25 dpi. Using 70 instead.
 ✓ tests/integration.test.ts  (4 tests) 1277ms
Estimating resolution as 307
Detected 182 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
 ✓ tests/two-stream-grid.test.ts  (10 tests) 3247ms
Estimating resolution as 307
Detected 182 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 274
Detected 19 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 274
Detected 19 diacritics
Estimating resolution as 307
Detected 182 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 307
Detected 182 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 274
Detected 19 diacritics
Estimating resolution as 274
 ✓ tests/age-ocr.test.ts  (15 tests) 5623ms
Detected 19 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
 ✓ tests/sheet-quality.test.ts  (19 tests) 5768ms
Estimating resolution as 307
Detected 182 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 274
Detected 19 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 307
Detected 182 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 274
Detected 19 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 307
Detected 182 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 274
Detected 19 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 307
Detected 182 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 274
Detected 19 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 307
Detected 182 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 274
Detected 19 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 307
Detected 182 diacritics
Warning: Invalid resolution 25 dpi. Using 70 instead.
Estimating resolution as 274
Detected 19 diacritics
 ✓ tests/upload-registration-meta.test.ts  (9 tests) 22676ms

 Test Files  48 passed | 15 skipped (63)
      Tests  468 passed | 15 skipped (483)
   Start at  11:08:33
   Duration  24.27s (transform 5.29s, setup 6ms, collect 23.89s, tests 56.35s, environment 12ms, prepare 17.16s)

Process exited with code 0.
```

Vitest의 skip 15개는 저장소에 원래 존재하는 `_probe-*`, 측정용/반복 측정용 skip이며 이번 변경으로 추가된 것이 아니다.

## 명세와 다르게 한 것과 이유

- 기능·경로·CSP·OCR 옵션·자산 구성에서 다르게 한 것은 없다.
- 이 환경의 PowerShell 실행 정책이 `npx.ps1`을 차단했기 때문에 두 명령을 `cmd.exe`에서 실행했다. 명령 내용은 `npx tsc --noEmit`, `npx vitest run` 그대로이며, 로컬 의존성만 사용했다.
- 사용자 지시대로 `npm run build`는 실행하지 않았다. 빌드·배포 확인은 위임자 범위로 남겼다.
- 사용자 제공 사실대로 원본 `kor.traineddata.gz`는 저장하지 않았고, 제공된 축약 SHA-256 `9d454186…`만 기록했다. 저장소에 포함한 gunzip 결과의 전체 SHA-256은 표의 `9520bfe9...` 값이다.
