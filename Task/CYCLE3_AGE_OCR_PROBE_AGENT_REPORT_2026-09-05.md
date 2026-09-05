# 사이클 3 나이 OCR 계측 프로브 -- 에이전트 보고서 (2026-09-05)

주문서: `cycle3-order.md` (스크래치패드). 브랜치 `cycle3-age-ocr-probe`, 기준 커밋 `7eacbed`.
**계측 라운드다. 제품 동작 무변경, 판정 없음.**

## 바꾼 파일 (줄 번호는 이 커밋 기준)

### `src/lib/recognition/ocrTextLines.ts` (+105/-5)

- **줄 4**: `import fs from 'fs/promises';` 추가.
- **줄 32-49** (`DigitOcrOptions` 안): `dumpLabel?: string` 필드 추가. 바로 아래
  `interface DigitOcrDump { dir: string; label: string; }` (파일 비공개) 추가.
- **줄 358-366** (`recognizeDigitsInRegionDetailed` 안, `recognizeDigitsCropDetailed` 호출
  직전): `AGE_OCR_DUMP_DIR` 환경변수와 `options.dumpLabel`을 **둘 다** 요구해 `DigitOcrDump | undefined`를
  만든다. 하나라도 없으면 `undefined`.
- **줄 371**: `recognizeDigitsCropDetailed(imageBuffer, crop, templateReference, dump)` -- 4번째
  인자 추가.
- **줄 639-969** (`recognizeDigitsCropDetailed`, `readDigitStrokes`, `buildDigitStrokes` 시그니처):
  각각 `dump?: DigitOcrDump` 매개변수 추가하고 호출부에서 그대로 전달.
- **줄 884**: `readDigitStrokes`의 획별 루프 안, `renderStrokesForOcr`가 만든 PNG를 tesseract에
  넘기기 **직전**에 `dumpDigitOcrPng(dump, \`stroke-${perStroke.length + 1}\`, image)` 삽입 --
  이미 만들어진 PNG 버퍼를 그대로 디스크에 쓰는 것뿐이라 추가 인코딩이 없다.
- **줄 941-991** (새 헬퍼 3개, `buildDigitStrokes` 바로 위): `dumpDigitOcrPng`(PNG 버퍼를
  `<label>-<suffix>.png`로 씀), `dumpDigitOcrRaw`(원시 1채널 픽셀을 sharp로 PNG 인코딩 후 위
  함수 호출), `invertMaskToGrayscale`(`InkMask.data`의 1=잉크를 0=검정으로 뒤집음). 세 함수 모두
  `dump`가 `undefined`면 즉시 반환하고, 쓰기 실패는 조용히 삼킨다(계측이 OCR 판정에 영향을 주면
  안 되므로).
- **줄 993-1006** (`buildDigitStrokes` 안, upscale 계산 직후): `dump`가 있을 때만 **별도의** sharp
  디코드로 원본 크롭(회색조, 68×17 그대로, 리사이즈 없음)을 얻어 `crop` 접미사로 덤프. 실제 파이프라인이
  읽는 버퍼와는 독립적인 두 번째 디코드라 원본 경로를 조금도 건드리지 않는다.
- **줄 1030-1033** (`buildInkMask` 호출 직후): 템플릿 숫자 제거 + Otsu 이진화가 끝난 직후,
  룰 제거·프레임 필터링 **전**의 `mask.data`(384×96, `shape.workWidth`/`workHeight`와 같은 크기)를
  `work` 접미사로 덤프.

**환경변수 없을 때 무동작 확인**: 위 삽입은 전부 `if (dump) { ... }` 또는 `if (!dump) return;` 뒤에
있고, `dump`는 `AGE_OCR_DUMP_DIR`가 없거나 `dumpLabel`이 없으면 항상 `undefined`다. `detectCheckmarks.ts`는
`dumpLabel`을 절대 넘기지 않으므로(아래) 제품 경로에서 `dump`는 항상 `undefined` -- 새 코드는 전부
건너뛴다. 기존 OCR 테스트 18개(`ocr-text-lines.test.ts`, `age-ocr.test.ts`, `ocr-budget.test.ts`)가
그대로 통과해 이를 뒷받침한다.

### `src/lib/recognition/detectCheckmarks.ts` (+15/-2)

- **줄 1116**: `buildPageInkCalibration`에 `export` 추가.
- **줄 1198**: `mergeBasicCheckboxDetection`에 `export` 추가.

가시성만 바꿨다 -- 두 함수의 본문·호출 시점·인자는 그대로다. 프로브 B가 `recognizeStudentForms`와
**같은 함수**를 호출하게 하려고 했다(재구현이 아니라). `toDigitOcrOptions`(줄 754, 여전히 비공개)는
export하지 않았다 -- 프로브가 필요한 세 필드(`photoProvenance`, `grayscaleScan`, 이제 `dumpLabel`)를
그 자리에서 직접 만드는 편이 함수 하나 더 export하는 것보다 작은 변경이라 판단했다.

## 프로브 사용법

### 프로브 1 -- `tests/_probe-age-crops.test.ts`

```
CAGI_DIR="<page-00NN.jpg가 있는 디렉터리>" OUT="<덤프 디렉터리>" \
  npx vitest run tests/_probe-age-crops.test.ts
```

`PAGE_COUNT`(기본 19)로 페이지 수 조절 가능. `CAGI_DIR` 또는 `OUT`이 없으면 `describe.skip`.

### 프로브 2 -- `tests/_probe-age-variants.test.ts`

```
CROP_DIR="<프로브 1의 OUT>" OUT="<variants.jsonl 경로>" \
  npx vitest run tests/_probe-age-variants.test.ts
```

`VARIANT_SCALES`(기본 `4,6,8,12`), `VARIANT_PSMS`(기본 `7,8,13`)로 격자 축소 가능(콤마 구분).
`CROP_DIR` 또는 `OUT`이 없으면 `describe.skip`.

## 프로브 1 실행 -- 19쪽 전문

`CAGI_DIR=.../scratchpad/browser-19/cagi OUT=.../scratchpad/cycle3/crops`, 2.84초.

```
page-0001 value=14 status=accepted gate=Age OCR accepted 14 [gate=narrow-stroke-is-one]: the wide shape read as 4 at confidence 96 of 60 needed, and the other is too narrow for any digit but 1. [whole-box="14" conf=33 per-digit="4" conf=0 (19x85=""c0 71x81="4"c96)] [crop=68x17 work=384x96 tmpl=1 otsu=132 ink=166/1000 strokes=2(19x85,71x81) rules=1(walls=1)] [ageOcrConfidence=96.0 photo=no accepted=true]
page-0002 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=whole-box-unreadable]: only the per-digit reading was a number in range. [whole-box="" conf=0 per-digit="7" conf=0 (15x63=""c0 69x53="7"c0)] [crop=68x17 work=384x96 tmpl=1 otsu=129 ink=128/1000 strokes=2(15x63,69x53) rules=1(walls=1)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0003 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=no-number-read]: neither reading was a 1-20 number. [whole-box="0" conf=0 per-digit=skipped] [crop=68x17 work=384x96 tmpl=1 otsu=135 ink=131/1000 strokes=3(20x64,40x41,37x33) rules=1(walls=1)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0004 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=whole-box-unreadable]: only the per-digit reading was a number in range. [whole-box="" conf=0 per-digit="7" conf=0 (19x75=""c0 32x69="7"c17)] [crop=68x17 work=384x96 tmpl=1 otsu=135 ink=56/1000 strokes=2(19x75,32x69) rules=0(walls=0 best=24/211@s=5/12)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0005 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=whole-box-unreadable]: only the per-digit reading was a number in range. [whole-box="" conf=0 per-digit="1" conf=0 (20x83="1"c66 59x54=""c0)] [crop=68x17 work=384x96 tmpl=1 otsu=129 ink=140/1000 strokes=2(20x83,59x54) rules=1(walls=1)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0006 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=no-number-read]: neither reading was a 1-20 number. [whole-box="" conf=0 per-digit="" conf=0 (18x96=""c0 76x87=""c0)] [crop=68x17 work=384x96 tmpl=1 otsu=132 ink=104/1000 strokes=2(18x96,76x87) rules=0(walls=0 best=56/211@s=-12/12)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0007 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=no-number-read]: neither reading was a 1-20 number. [whole-box="" conf=0 per-digit="" conf=0 (39x52=""c0 116x96=""c0)] [crop=68x17 work=384x96 tmpl=1 otsu=132 ink=101/1000 strokes=2(39x52,116x96) rules=0(walls=0 best=76/211@s=-12/12)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0008 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=whole-box-unreadable]: only the per-digit reading was a number in range. [whole-box="" conf=0 per-digit="9" conf=0 (27x70=""c0 47x64="9"c52)] [crop=68x17 work=384x96 tmpl=1 otsu=129 ink=111/1000 strokes=2(27x70,47x64) rules=1(walls=1)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0009 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=agreed-below-confidence]: both readings said 3 but the best confidence was 17 of 60 needed. [whole-box="3" conf=17 per-digit="3" conf=0 (31x77=""c0 70x86="3"c93)] [crop=68x17 work=384x96 tmpl=1 otsu=135 ink=87/1000 strokes=2(31x77,70x86) rules=0(walls=0 best=65/211@s=-12/12)] [ageOcrConfidence=17.0 photo=no accepted=false]
page-0010 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=no-number-read]: neither reading was a 1-20 number. [whole-box="" conf=0 per-digit="" conf=0 (19x80=""c0 77x87=""c0)] [crop=68x17 work=384x96 tmpl=1 otsu=132 ink=79/1000 strokes=2(19x80,77x87) rules=0(walls=0 best=77/211@s=-12/12)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0011 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=whole-box-below-confidence]: the only number read was 1 at confidence 0 of 60 needed. [whole-box="1" conf=0 per-digit="" conf=0 (14x96=""c0 87x96=""c0)] [crop=68x17 work=384x96 tmpl=1 otsu=132 ink=104/1000 strokes=2(14x96,87x96) rules=0(walls=0 best=65/211@s=-12/12)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0012 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=no-number-read]: neither reading was a 1-20 number. [whole-box="" conf=0 per-digit="" conf=0 (38x80=""c0 77x87=""c0)] [crop=68x17 work=384x96 tmpl=1 otsu=132 ink=236/1000 strokes=2(38x80,77x87) rules=1(walls=1)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0013 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=no-number-read]: neither reading was a 1-20 number. [whole-box="" conf=0 per-digit="" conf=0 (25x69=""c0 81x74=""c0)] [crop=68x17 work=384x96 tmpl=1 otsu=135 ink=195/1000 strokes=2(25x69,81x74) rules=1(walls=1)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0014 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=whole-box-unreadable]: only the per-digit reading was a number in range. [whole-box="" conf=0 per-digit="2" conf=0 (25x65=""c0 72x74="2"c15)] [crop=68x17 work=384x96 tmpl=1 otsu=129 ink=85/1000 strokes=2(25x65,72x74) rules=0(walls=0 best=52/211@s=3/12)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0015 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=whole-box-unreadable]: only the per-digit reading was a number in range. [whole-box="" conf=0 per-digit="3" conf=0 (19x81=""c0 58x86="3"c5)] [crop=68x17 work=384x96 tmpl=1 otsu=135 ink=74/1000 strokes=2(19x81,58x86) rules=0(walls=0 best=55/211@s=-12/12)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0016 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=no-number-read]: neither reading was a 1-20 number. [whole-box="" conf=0 per-digit="" conf=0 (20x74=""c0 101x86=""c0)] [crop=68x17 work=384x96 tmpl=1 otsu=132 ink=167/1000 strokes=2(20x74,101x86) rules=1(walls=1)] [ageOcrConfidence=0.0 photo=no accepted=false]
page-0017 value=undefined status=parse_or_confidence_rejected gate=Age OCR rejected [gate=readers-disagreed]: the two readings were different numbers. [whole-box="3" conf=33 per-digit="13" conf=71 (25x74="1"c71 71x74="3"c82)] [crop=68x17 work=384x96 tmpl=1 otsu=132 ink=180/1000 strokes=2(25x74,71x74) rules=1(walls=1)] [ageOcrConfidence=71.0 photo=no accepted=false]
page-0018 value=14 status=accepted gate=Age OCR accepted 14 [gate=narrow-stroke-is-one]: the wide shape read as 4 at confidence 87 of 60 needed, and the other is too narrow for any digit but 1. [whole-box="" conf=0 per-digit="4" conf=0 (20x85=""c0 88x96="4"c87)] [crop=68x17 work=384x96 tmpl=1 otsu=132 ink=101/1000 strokes=2(20x85,88x96) rules=0(walls=0 best=86/211@s=-12/12)] [ageOcrConfidence=87.0 photo=no accepted=true]
page-0019 value=undefined status=no_handwriting_found gate=Age OCR found no handwriting in the age box once the printed rules were removed. [crop=68x17 work=384x96 tmpl=1 otsu=138 ink=20/1000 strokes=0() rules=0(walls=0 best=59/211@s=-12/12)] [ageOcrConfidence=none photo=no accepted=false]
```

이 결과는 주문서의 "확정된 사실" #2(전체 상자 13명 빈 문자열/4명 오독, 자릿수 판독 둘째 자리 오독,
통과 2명)와 값 수준까지 일치한다(page-0001/0018만 accepted, 둘 다 `narrow-stroke-is-one` 게이트).

**PNG 산출물**: `.../scratchpad/cycle3/crops/`에 72개 파일. 19쪽 중 17쪽은 `page-00NN-{crop,work,stroke-1,stroke-2}.png`(4개씩) --
획이 1~2개일 때만 획별 이미지가 만들어진다(제품 로직 그대로: `readDigitStrokes`는 획이 1~2개일 때만
자릿수별 읽기를 시도). page-0003은 획 3개라 `crop`/`work`만(자릿수별 읽기 스킵), page-0019는 잉크
부족(`ink=20/1000` < `DIGIT_MIN_INK_FRACTION`)으로 획 자체가 없어 `crop`/`work`만. `page-0001-crop.png`를
직접 열어 "14"가, `page-0001-work.png`에서 이진화된 "1 4"가 보이는 것을 육안 확인했다.

## 프로브 2 실행 -- 변형 격자와 실행 시간

전체 격자(축소 없이) 그대로 돌렸다: 배율 {4,6,8,12} × 보간 {nearest,lanczos} × 이진화 {none,otsu} ×
팽창 {0,1,2} × PSM {7,8,13} = **페이지당 144개, 19쪽 × 144 = 2,736줄**.

```
2쪽 예비 실행: 288줄, 5.35초 (≈18.6ms/변형)
19쪽 전체 실행: 2,736줄, 52.66초 (vitest 자체 종료까지 52.78초)
```

축소가 필요 없어 `VARIANT_SCALES`/`VARIANT_PSMS`는 기본값을 그대로 썼다. 산출물:
`.../scratchpad/cycle3/variants.jsonl`(2,736줄, `{page, variant:{scale,interp,binarize,dilate,psm}, text, confidence}`
형태 확인됨). 자릿수별(`SINGLE_CHAR`) 읽기는 스윕하지 않았다(주문서 지시대로 -- 제품 경로가 이미 함).

## 확신 없는 부분 / 해석이 필요했던 지점

1. **"work" 이미지를 뜨는 시점**: 주문서는 "템플릿 제거·이진화 뒤 tesseract에 넘기는 그것"이라
   적었지만, 실제로 tesseract에 넘어가는 이미지는 `renderStrokesForOcr`가 획 경계로 다시 잘라
   48px 높이로 재조정한 것이지 384×96 전체가 아니다. 384×96 전체 캔버스는 룰 제거·프레임 필터링
   *전* 상태로 떴다(즉 `buildInkMask` 직후, `eraseHorizontalRules`/`keepDigitStrokes` 전) --
   기존 진단 문자열의 `work=384x96` 표기와 동일한 지점이라 이것이 맞는 해석이라 판단했지만,
   룰 제거 *후* 상태를 원했다면 다른 스냅숏이다.
2. **팽창(dilate) 정의**: 주문서에 구조 요소 모양이 명시되지 않아 정사각형 커널로 구현했다.
   이진화=none일 때는 그레이스케일 최소값 필터(어두운 쪽으로 확장), 이진화=otsu일 때는 이진
   팽창(반경 내 잉크가 하나라도 있으면 잉크)으로 서로 다른 연산을 적용했다 -- 이것이 유일하게
   말이 되는 해석이라 생각했지만 확정된 사실이 아니다.
3. **크롭 원본의 채널**: `page-00NN.jpg`가 3채널 JPEG(892×1261, RGB)라 `loadImageAnalysisData` /
   sharp의 `.grayscale()`이 어떤 가중치로 회색조 변환하는지는 조사하지 않았다(제품 코드가 이미
   쓰는 동일한 `.grayscale()` 호출을 그대로 재사용했을 뿐이다).
4. **신뢰도 0인데 텍스트가 있는 줄이 다수** (`variants.jsonl`에서도, 프로브 1 로그의 `per-digit`
   필드에서도 관찰됨, 예: page-0002 `per-digit="7" conf=0`). tesseract.js가 일부 PSM에서 신뢰도를
   0으로 보고하면서도 텍스트를 반환하는 것으로 보이는데, 이는 제품 코드에서도 이미 관찰되는 동작이라
   프로브의 버그가 아니라고 판단했지만 근본 원인은 조사하지 않았다.
5. **`toDigitOcrOptions`를 export하지 않은 것**: 위에 적었듯 의도적 선택이지만, 이후 프로브가
   또 필요해지면 이 함수를 export하는 편이 더 나을 수 있다.

## 검증

- `npx tsc --noEmit`: 통과(무출력).
- `npx vitest run`: **534 passed, 21 skipped, 0 failed** (54 test files passed, 21 skipped --
  스킵은 `_probe-*.test.ts`류 전부와 env 미설정 테스트).
- `git diff --stat`: `detectCheckmarks.ts` +15/-2, `ocrTextLines.ts` +105/-5. 학생 파일은 워크트리에
  전혀 복사하지 않았다(`CAGI_DIR`/`CROP_DIR`로 스크래치패드 원본을 읽기만 했다).
- `npm run build`는 실행하지 않았다(주문서 절대 조건).
