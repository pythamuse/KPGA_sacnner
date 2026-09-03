# Self-hosted third-party runtime assets

이 디렉터리의 파일은 브라우저가 앱과 같은 출처에서 받는 런타임 자산이다. 버전 디렉터리를 유지하고, 아래 원본 URL과 SHA-256을 함께 확인한다.

SHA-256은 저장소에 커밋된 로컬 파일 기준이다. `kor.traineddata`만 원본 gzip을 gunzip한 파일이므로, 원본 gzip의 SHA-256도 비고에 적었다.

| 로컬 파일 | 원본 URL | 버전 | 로컬 파일 SHA-256 |
| --- | --- | --- | --- |
| `public/vendor/pdfjs/6.1.200/pdf.min.mjs` | `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.1.200/pdf.min.mjs` | pdf.js 6.1.200 | `4ba2f15599b03fde8755ad91349920c21dadd3e8fd6b6460a7663d46d4cf21b5` |
| `public/vendor/pdfjs/6.1.200/pdf.worker.min.mjs` | `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.1.200/pdf.worker.min.mjs` | pdf.js 6.1.200 | `2ab9e09667296dab1a618868b3ce6e6c23d5b8f48120ae7c5b34e7e335ed01fa` |
| `public/vendor/pdfjs/6.1.200/wasm/jbig2.wasm` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/jbig2.wasm` | pdfjs-dist 6.1.200 | `e6bee67724a7b5436fe8162638e3708cfc8d52b6342db69a49715e30ff27cfdc` |
| `public/vendor/pdfjs/6.1.200/wasm/jbig2_nowasm_fallback.js` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/jbig2_nowasm_fallback.js` | pdfjs-dist 6.1.200 | `04c795a6657a4553a64b781ea3e85256203d913c3b71b72b85fa3ce00622f458` |
| `public/vendor/pdfjs/6.1.200/wasm/LICENSE_JBIG2` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/LICENSE_JBIG2` | pdfjs-dist 6.1.200 | `9e66b7f1b934a28b37f3bc4dac97915de1674271e79a0a88182a18ed9731b4d1` |
| `public/vendor/pdfjs/6.1.200/wasm/LICENSE_OPENJPEG` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/LICENSE_OPENJPEG` | pdfjs-dist 6.1.200 | `a6af136f3e15038a666b61f376612a07d9a4e48cb7c01adbf3e33b3f14ab49b6` |
| `public/vendor/pdfjs/6.1.200/wasm/LICENSE_PDFJS_JBIG2` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/LICENSE_PDFJS_JBIG2` | pdfjs-dist 6.1.200 | `aad3cce09842e00e9e11ad5e8fef8cc02fbc3a3768fe2f007443b9cee37aaee5` |
| `public/vendor/pdfjs/6.1.200/wasm/LICENSE_PDFJS_OPENJPEG` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/LICENSE_PDFJS_OPENJPEG` | pdfjs-dist 6.1.200 | `717fc62da03292dbb4dd0c8280bd4ce7bb8550dcf31d772bc93455fb50313425` |
| `public/vendor/pdfjs/6.1.200/wasm/LICENSE_PDFJS_QCMS` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/LICENSE_PDFJS_QCMS` | pdfjs-dist 6.1.200 | `eb5104ca33552be007857a28351bc408f379ddd4bfacab1226b09c6d1e9fd7c4` |
| `public/vendor/pdfjs/6.1.200/wasm/LICENSE_QCMS` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/LICENSE_QCMS` | pdfjs-dist 6.1.200 | `36d847ae882f6574ebc72f56a4f354e4f104fde4a584373496482e97d52d31bc` |
| `public/vendor/pdfjs/6.1.200/wasm/openjpeg.wasm` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/openjpeg.wasm` | pdfjs-dist 6.1.200 | `004a0e62db930ba9ff2a22212f4554d0bb57a0635a8287caf70f98117cee14ba` |
| `public/vendor/pdfjs/6.1.200/wasm/openjpeg_nowasm_fallback.js` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/openjpeg_nowasm_fallback.js` | pdfjs-dist 6.1.200 | `0f998419819da4491d8302222aa9e2ff2494685641aa2a6c21c3760c29f3e319` |
| `public/vendor/pdfjs/6.1.200/wasm/qcms_bg.wasm` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/qcms_bg.wasm` | pdfjs-dist 6.1.200 | `bfdaeb649178748e54bcdaa819bcd5c5c5a4278c8eaaf5feb5a26071e1c25bfc` |
| `public/vendor/pdfjs/6.1.200/wasm/quickjs-eval.js` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/quickjs-eval.js` | pdfjs-dist 6.1.200 | `fe7930418e869791ce892567dbd0bc4698152b7e550b5cefa553992c56ddc325` |
| `public/vendor/pdfjs/6.1.200/wasm/quickjs-eval.wasm` | `https://unpkg.com/pdfjs-dist@6.1.200/wasm/quickjs-eval.wasm` | pdfjs-dist 6.1.200 | `7bcacc9f22cacf7e9b23866d2a6d1639693d40c7f144e41b7c69ed37ba9cbe8f` |
| `public/vendor/opencv/4.9.0/opencv.js` | `https://docs.opencv.org/4.9.0/opencv.js` | OpenCV.js 4.9.0 | `4d7b85e2e12ea0bd088f491c311d620a45b53d1489b7f065b4492a230bda243a` |
| `src/lib/recognition/assets/kor.traineddata` | `https://tessdata.projectnaptha.com/4.0.0/kor.traineddata.gz` | tessdata 4.0.0 | `9520bfe9e3cfc38d4a808e036b0287c88a1d37fb80b9a0a23928ddccdd20595b` |

`kor.traineddata` 원본 gzip의 제공된 SHA-256은 `9d454186…`이다. 로컬 파일은 gzip을 해제한 결과이며 `gzip: false`로 읽는다.

## 갱신 절차

1. 버전 디렉터리를 새 버전으로 만들고, 위 표의 형식대로 해당 upstream 파일을 내려받는다. PDF.js 본체·워커는 cdnjs, decoder 디렉터리는 unpkg, OpenCV는 docs.opencv.org, kor 모델은 tessdata URL을 사용한다.
2. 내려받은 각 파일에 `Get-FileHash -Algorithm SHA256 <file>`를 실행해 교체 전에 SHA-256을 확인한다. 표의 해시와 다르면 교체하지 않는다.
3. `kor.traineddata.gz`는 원본 gzip 해시를 확인한 뒤 gunzip하여 `src/lib/recognition/assets/kor.traineddata`로 교체하고, 로컬 해시도 표에 갱신한다.
4. `PDFJS_VERSION`과 런타임 경로, 이 표와 `report.md`의 해시를 함께 갱신한 뒤 `npx tsc --noEmit` 및 `npx vitest run`을 실행한다.
