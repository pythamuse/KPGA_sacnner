# 사이클 1 기본정보 체크박스 배치 계측 프로브 — 에이전트 보고서 (2026-09-05)

이 문서는 계측 결과를 **해석하지 않는다**. 판정은 위임자가 한다.

## 바꾼 파일

- `src/lib/recognition/basicCheckboxDetection.ts:940-946` — 읽기 전용 핸들 추가(동작 무변경, 7줄 삽입):
  ```ts
  export const __probe = { findTranslationMatch, assignCandidates, flattenGroupRects };
  ```
  `git diff --stat`: `src/lib/recognition/basicCheckboxDetection.ts | 7 +++++++` (1 file changed, 7 insertions(+), 0 deletions). 이 외 `src/**` 변경 없음.
- `tests/_probe-basic-boxes.test.ts` (신규, 268줄) — ONE-OFF 프로브.

## 프로브 사용법

```
IMAGE=<jpg 경로> OUT=<출력 디렉터리> npx vitest run tests/_probe-basic-boxes.test.ts
```

두 환경변수 모두 있어야 실행된다(없으면 `describe.skip`). `OUT`은 각 실행에 **prefix로 직접** 넘겨야 한다 —
셸에서 `OUT=... &&`로 먼저 설정만 해두고 이후 `IMAGE=... npx vitest ...`처럼 `IMAGE`만 prefix로 주면
자식 프로세스에 `OUT`이 전달되지 않아 **조용히 skip된다**(처음 한 라운드에서 실제로 이 실수를 했고,
전 6장이 스킵된 것을 로그 줄 수(`[basic-boxes]` 0개)로 확인하고 재실행함 — 아래 "확신 없는 부분" 참고).

## 절대 조건 확인

- `npx tsc --noEmit`: 통과(출력 없음).
- `npx vitest run`(전체 스위트): `Test Files 54 passed | 19 skipped (73)`, `Tests 534 passed | 19 skipped (553)`. 새 프로브 파일은 `IMAGE`/`OUT` 미설정 시 스킵되어 이 카운트에 포함(스킵 19개 중 1개).
- `npm run build`: 실행하지 않음(지시대로).
- 새 의존성: 없음(`sharp`는 기존 의존성).
- 학생 파일 커밋: 없음. PNG 출력은 스크래치패드(`.../scratchpad/cycle1/probe/`)에만 썼고, 입력 JPG는 읽기만 했다.

## PNG 출력 (스크래치패드, 커밋 안 됨)

동일 페이지 번호가 두 표본 세트(`browser-19`, `scanpages-set1`)에 겹쳐서 파일명이 basename만으로는 충돌한다는
것을 발견해(첫 시도에서 `page-0002-basic.png`가 노드 실행에 덮어써짐), 출력 파일명을 경로의 마지막 세 세그먼트로
태깅하도록 프로브를 수정했다(`tests/_probe-basic-boxes.test.ts`의 `tag` 계산). 최종 파일 6개:

```
browser-19-cagi-page-0001-basic.png
browser-19-cagi-page-0002-basic.png
browser-19-cagi-page-0004-basic.png
browser-19-cagi-page-0011-basic.png
browser-19-cagi-page-0005-basic.png
scanpages-set1-cagi-page-0002-basic.png
```

파랑=기준 사각형(baseline candidate rects를 페이지 자신의 등록 경계로 투영), 초록=검출 후보(옆에 frameScore 표기),
빨강=`matchBasicCheckboxes` 최종 창. 크롭은 12개 기준점의 y범위 ± 40px, x는 페이지의 등록 경계(`getRegistrationBounds`)
전체 폭, 2배 확대.

## 6장 전체 로그 (`[basic-boxes] ...`만 추출, 원본은 vitest 실행 원문)

### 1. 브라우저 p1 (정상 — 성별·학교유형·학년 모두 자동 정답)

이미지: `C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/browser-19/cagi/page-0001.jpg`

```
[basic-boxes] image=C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/browser-19/cagi/page-0001.jpg
[basic-boxes] bounds={"left":83,"top":103,"right":873,"bottom":1197} source=template baselineBounds={"left":154,"top":190,"right":1619,"bottom":2219}
[basic-boxes] candidates=144
[basic-boxes] candidate#0 rect=276.0,276.0-288.0,288.0 center=0.2519,0.1636 fill=0.000 frameScore=0.813
[basic-boxes] candidate#1 rect=264.0,299.0-278.0,311.0 center=0.2380,0.1846 fill=0.000 frameScore=0.687
[basic-boxes] candidate#2 rect=454.0,295.0-466.0,307.0 center=0.4772,0.1810 fill=0.000 frameScore=0.667
[basic-boxes] candidate#3 rect=624.0,320.0-638.0,333.0 center=0.6937,0.2043 fill=0.000 frameScore=0.663
[basic-boxes] candidate#4 rect=343.0,333.0-355.0,345.0 center=0.3367,0.2157 fill=0.000 frameScore=0.646
[basic-boxes] candidate#5 rect=433.0,333.0-446.0,345.0 center=0.4513,0.2157 fill=0.000 frameScore=0.632
[basic-boxes] candidate#6 rect=450.0,231.0-462.0,244.0 center=0.4722,0.1229 fill=0.000 frameScore=0.624
[basic-boxes] candidate#7 rect=433.0,315.0-446.0,327.0 center=0.4513,0.1993 fill=0.000 frameScore=0.617
[basic-boxes] candidate#8 rect=549.0,321.0-561.0,332.0 center=0.5975,0.2043 fill=0.000 frameScore=0.610
[basic-boxes] candidate#9 rect=264.0,333.0-277.0,345.0 center=0.2373,0.2157 fill=0.000 frameScore=0.607
[basic-boxes] candidate#10 rect=223.0,293.0-236.0,305.0 center=0.1854,0.1792 fill=0.000 frameScore=0.584
[basic-boxes] candidate#11 rect=264.0,275.0-278.0,287.0 center=0.2380,0.1627 fill=0.000 frameScore=0.581
[basic-boxes] candidate#12 rect=507.0,230.0-520.0,242.0 center=0.5449,0.1216 fill=0.000 frameScore=0.575
[basic-boxes] candidate#13 rect=558.0,321.0-570.0,332.0 center=0.6089,0.2043 fill=0.000 frameScore=0.566
[basic-boxes] candidate#14 rect=156.0,285.0-168.0,296.0 center=0.1000,0.1714 fill=0.000 frameScore=0.566
[basic-boxes] candidate#15 rect=276.0,294.0-288.0,305.0 center=0.2519,0.1796 fill=0.000 frameScore=0.561
[basic-boxes] candidate#16 rect=333.0,315.0-345.0,326.0 center=0.3241,0.1988 fill=0.000 frameScore=0.558
[basic-boxes] candidate#17 rect=153.0,255.0-165.0,266.0 center=0.0962,0.1440 fill=0.000 frameScore=0.555
[basic-boxes] candidate#18 rect=513.0,324.0-525.0,335.0 center=0.5519,0.2070 fill=0.000 frameScore=0.554
[basic-boxes] candidate#19 rect=141.0,285.0-153.0,296.0 center=0.0810,0.1714 fill=0.000 frameScore=0.551
[basic-boxes] candidate#20 rect=164.0,323.0-176.0,335.0 center=0.1101,0.2066 fill=0.000 frameScore=0.548
[basic-boxes] candidate#21 rect=396.0,309.0-408.0,320.0 center=0.4038,0.1933 fill=0.000 frameScore=0.543
[basic-boxes] candidate#22 rect=223.0,274.0-236.0,286.0 center=0.1854,0.1618 fill=0.000 frameScore=0.542
[basic-boxes] candidate#23 rect=466.0,230.0-480.0,242.0 center=0.4937,0.1216 fill=0.000 frameScore=0.541
[basic-boxes] candidate#24 rect=423.0,315.0-435.0,326.0 center=0.4380,0.1988 fill=0.000 frameScore=0.539
[basic-boxes] candidate#25 rect=318.0,309.0-331.0,321.0 center=0.3057,0.1938 fill=0.000 frameScore=0.534
[basic-boxes] candidate#26 rect=129.0,285.0-141.0,296.0 center=0.0658,0.1714 fill=0.000 frameScore=0.533
[basic-boxes] candidate#27 rect=403.0,293.0-415.0,305.0 center=0.4127,0.1792 fill=0.000 frameScore=0.530
[basic-boxes] candidate#28 rect=126.0,255.0-138.0,266.0 center=0.0620,0.1440 fill=0.000 frameScore=0.527
[basic-boxes] candidate#29 rect=738.0,258.0-750.0,269.0 center=0.8367,0.1467 fill=0.000 frameScore=0.524
[basic-boxes] candidate#30 rect=402.0,229.0-414.0,241.0 center=0.4114,0.1207 fill=0.000 frameScore=0.518
[basic-boxes] candidate#31 rect=549.0,249.0-561.0,260.0 center=0.5975,0.1385 fill=0.000 frameScore=0.516
[basic-boxes] candidate#32 rect=291.0,267.0-305.0,280.0 center=0.2722,0.1559 fill=0.000 frameScore=0.515
[basic-boxes] candidate#33 rect=417.0,255.0-429.0,266.0 center=0.4304,0.1440 fill=0.000 frameScore=0.515
[basic-boxes] candidate#34 rect=343.0,309.0-356.0,321.0 center=0.3373,0.1938 fill=0.000 frameScore=0.514
[basic-boxes] candidate#35 rect=312.0,309.0-324.0,320.0 center=0.2975,0.1933 fill=0.000 frameScore=0.511
[basic-boxes] candidate#36 rect=331.0,333.0-345.0,345.0 center=0.3228,0.2157 fill=0.000 frameScore=0.509
[basic-boxes] candidate#37 rect=144.0,258.0-156.0,269.0 center=0.0848,0.1467 fill=0.000 frameScore=0.507
[basic-boxes] candidate#38 rect=549.0,258.0-561.0,269.0 center=0.5975,0.1467 fill=0.000 frameScore=0.503
[basic-boxes] candidate#39 rect=164.0,285.0-176.0,297.0 center=0.1101,0.1718 fill=0.000 frameScore=0.502
[basic-boxes] candidate#40 rect=255.0,309.0-267.0,320.0 center=0.2253,0.1933 fill=0.000 frameScore=0.502
[basic-boxes] candidate#41 rect=722.0,271.0-734.0,283.0 center=0.8165,0.1590 fill=0.000 frameScore=0.500
[basic-boxes] candidate#42 rect=222.0,309.0-234.0,320.0 center=0.1835,0.1933 fill=0.000 frameScore=0.498
[basic-boxes] candidate#43 rect=433.0,231.0-445.0,244.0 center=0.4506,0.1229 fill=0.000 frameScore=0.497
[basic-boxes] candidate#44 rect=447.0,276.0-459.0,287.0 center=0.4684,0.1632 fill=0.000 frameScore=0.496
[basic-boxes] candidate#45 rect=237.0,299.0-250.0,311.0 center=0.2032,0.1846 fill=0.000 frameScore=0.496
[basic-boxes] candidate#46 rect=442.0,294.0-456.0,307.0 center=0.4633,0.1805 fill=0.000 frameScore=0.493
[basic-boxes] candidate#47 rect=609.0,324.0-621.0,335.0 center=0.6734,0.2070 fill=0.000 frameScore=0.492
[basic-boxes] candidate#48 rect=291.0,258.0-303.0,269.0 center=0.2709,0.1467 fill=0.000 frameScore=0.491
[basic-boxes] candidate#49 rect=433.0,275.0-447.0,287.0 center=0.4519,0.1627 fill=0.000 frameScore=0.484
[basic-boxes] candidate#50 rect=251.0,272.0-265.0,285.0 center=0.2215,0.1604 fill=0.000 frameScore=0.483
[basic-boxes] candidate#51 rect=264.0,315.0-276.0,326.0 center=0.2367,0.1988 fill=0.000 frameScore=0.481
[basic-boxes] candidate#52 rect=312.0,321.0-324.0,332.0 center=0.2975,0.2043 fill=0.000 frameScore=0.473
[basic-boxes] candidate#53 rect=413.0,272.0-427.0,284.0 center=0.4266,0.1600 fill=0.000 frameScore=0.468
[basic-boxes] candidate#54 rect=504.0,321.0-516.0,332.0 center=0.5405,0.2043 fill=0.000 frameScore=0.467
[basic-boxes] candidate#55 rect=192.0,300.0-204.0,311.0 center=0.1456,0.1851 fill=0.000 frameScore=0.464
[basic-boxes] candidate#56 rect=192.0,309.0-204.0,320.0 center=0.1456,0.1933 fill=0.000 frameScore=0.464
[basic-boxes] candidate#57 rect=264.0,258.0-276.0,269.0 center=0.2367,0.1467 fill=0.000 frameScore=0.462
[basic-boxes] candidate#58 rect=717.0,300.0-729.0,311.0 center=0.8101,0.1851 fill=0.000 frameScore=0.458
[basic-boxes] candidate#59 rect=276.0,267.0-288.0,278.0 center=0.2519,0.1549 fill=0.000 frameScore=0.457
[basic-boxes] candidate#60 rect=414.0,309.0-426.0,320.0 center=0.4266,0.1933 fill=0.000 frameScore=0.456
[basic-boxes] candidate#61 rect=549.0,286.0-561.0,298.0 center=0.5975,0.1728 fill=0.000 frameScore=0.455
[basic-boxes] candidate#62 rect=237.0,272.0-251.0,284.0 center=0.2038,0.1600 fill=0.000 frameScore=0.453
[basic-boxes] candidate#63 rect=519.0,282.0-531.0,294.0 center=0.5595,0.1691 fill=0.000 frameScore=0.452
[basic-boxes] candidate#64 rect=558.0,255.0-570.0,266.0 center=0.6089,0.1440 fill=0.000 frameScore=0.448
[basic-boxes] candidate#65 rect=678.0,300.0-690.0,311.0 center=0.7608,0.1851 fill=0.000 frameScore=0.447
[basic-boxes] candidate#66 rect=528.0,321.0-540.0,332.0 center=0.5709,0.2043 fill=0.000 frameScore=0.441
[basic-boxes] candidate#67 rect=738.0,249.0-750.0,260.0 center=0.8367,0.1385 fill=0.000 frameScore=0.440
[basic-boxes] candidate#68 rect=435.0,300.0-447.0,311.0 center=0.4532,0.1851 fill=0.000 frameScore=0.440
[basic-boxes] candidate#69 rect=421.0,332.0-435.0,345.0 center=0.4367,0.2153 fill=0.000 frameScore=0.438
[basic-boxes] candidate#70 rect=117.0,255.0-129.0,266.0 center=0.0506,0.1440 fill=0.000 frameScore=0.436
[basic-boxes] candidate#71 rect=519.0,255.0-531.0,266.0 center=0.5595,0.1440 fill=0.000 frameScore=0.435
[basic-boxes] candidate#72 rect=423.0,267.0-435.0,278.0 center=0.4380,0.1549 fill=0.000 frameScore=0.434
[basic-boxes] candidate#73 rect=366.0,298.0-378.0,311.0 center=0.3658,0.1842 fill=0.000 frameScore=0.434
[basic-boxes] candidate#74 rect=488.0,237.0-501.0,250.0 center=0.5209,0.1284 fill=0.000 frameScore=0.433
[basic-boxes] candidate#75 rect=282.0,258.0-294.0,269.0 center=0.2595,0.1467 fill=0.000 frameScore=0.432
[basic-boxes] candidate#76 rect=624.0,255.0-636.0,266.0 center=0.6924,0.1440 fill=0.000 frameScore=0.431
[basic-boxes] candidate#77 rect=539.0,328.0-552.0,340.0 center=0.5854,0.2112 fill=0.000 frameScore=0.428
[basic-boxes] candidate#78 rect=258.0,294.0-270.0,305.0 center=0.2291,0.1796 fill=0.000 frameScore=0.426
[basic-boxes] candidate#79 rect=699.0,300.0-711.0,311.0 center=0.7873,0.1851 fill=0.000 frameScore=0.417
[basic-boxes] candidate#80 rect=690.0,300.0-702.0,311.0 center=0.7759,0.1851 fill=0.000 frameScore=0.416
[basic-boxes] candidate#81 rect=528.0,255.0-540.0,266.0 center=0.5709,0.1440 fill=0.000 frameScore=0.416
[basic-boxes] candidate#82 rect=375.0,300.0-387.0,311.0 center=0.3772,0.1851 fill=0.000 frameScore=0.415
[basic-boxes] candidate#83 rect=236.0,286.0-250.0,298.0 center=0.2025,0.1728 fill=0.000 frameScore=0.414
[basic-boxes] candidate#84 rect=162.0,249.0-174.0,260.0 center=0.1076,0.1385 fill=0.000 frameScore=0.413
[basic-boxes] candidate#85 rect=384.0,294.0-396.0,305.0 center=0.3886,0.1796 fill=0.000 frameScore=0.410
[basic-boxes] candidate#86 rect=96.0,309.0-108.0,320.0 center=0.0241,0.1933 fill=0.000 frameScore=0.409
[basic-boxes] candidate#87 rect=305.0,331.0-319.0,344.0 center=0.2899,0.2144 fill=0.000 frameScore=0.408
[basic-boxes] candidate#88 rect=354.0,309.0-366.0,320.0 center=0.3506,0.1933 fill=0.000 frameScore=0.407
[basic-boxes] candidate#89 rect=518.0,229.0-530.0,241.0 center=0.5582,0.1207 fill=0.000 frameScore=0.405
[basic-boxes] candidate#90 rect=708.0,300.0-720.0,311.0 center=0.7987,0.1851 fill=0.000 frameScore=0.405
[basic-boxes] candidate#91 rect=325.0,271.0-338.0,284.0 center=0.3146,0.1595 fill=0.000 frameScore=0.404
[basic-boxes] candidate#92 rect=396.0,300.0-408.0,311.0 center=0.4038,0.1851 fill=0.000 frameScore=0.404
[basic-boxes] candidate#93 rect=395.0,331.0-407.0,343.0 center=0.4025,0.2139 fill=0.000 frameScore=0.402
[basic-boxes] candidate#94 rect=118.0,285.0-130.0,298.0 center=0.0519,0.1723 fill=0.000 frameScore=0.401
[basic-boxes] candidate#95 rect=747.0,249.0-759.0,260.0 center=0.8481,0.1385 fill=0.000 frameScore=0.401
[basic-boxes] candidate#96 rect=453.0,267.0-465.0,278.0 center=0.4759,0.1549 fill=0.000 frameScore=0.400
[basic-boxes] candidate#97 rect=663.0,258.0-675.0,269.0 center=0.7418,0.1467 fill=0.000 frameScore=0.399
[basic-boxes] candidate#98 rect=96.0,300.0-108.0,311.0 center=0.0241,0.1851 fill=0.000 frameScore=0.398
[basic-boxes] candidate#99 rect=383.0,254.0-395.0,267.0 center=0.3873,0.1440 fill=0.000 frameScore=0.397
[basic-boxes] candidate#100 rect=120.0,321.0-132.0,332.0 center=0.0544,0.2043 fill=0.000 frameScore=0.395
[basic-boxes] candidate#101 rect=651.0,300.0-663.0,311.0 center=0.7266,0.1851 fill=0.000 frameScore=0.395
[basic-boxes] candidate#102 rect=717.0,291.0-729.0,302.0 center=0.8101,0.1769 fill=0.000 frameScore=0.394
[basic-boxes] candidate#103 rect=231.0,300.0-243.0,311.0 center=0.1949,0.1851 fill=0.000 frameScore=0.392
[basic-boxes] candidate#104 rect=248.0,314.0-260.0,326.0 center=0.2165,0.1984 fill=0.000 frameScore=0.390
[basic-boxes] candidate#105 rect=507.0,240.0-519.0,251.0 center=0.5443,0.1303 fill=0.000 frameScore=0.389
[basic-boxes] candidate#106 rect=324.0,249.0-336.0,260.0 center=0.3127,0.1385 fill=0.000 frameScore=0.386
[basic-boxes] candidate#107 rect=636.0,321.0-648.0,332.0 center=0.7076,0.2043 fill=0.000 frameScore=0.385
[basic-boxes] candidate#108 rect=366.0,285.0-378.0,296.0 center=0.3658,0.1714 fill=0.000 frameScore=0.383
[basic-boxes] candidate#109 rect=358.0,271.0-370.0,283.0 center=0.3557,0.1590 fill=0.000 frameScore=0.383
[basic-boxes] candidate#110 rect=162.0,258.0-174.0,269.0 center=0.1076,0.1467 fill=0.000 frameScore=0.382
[basic-boxes] candidate#111 rect=348.0,300.0-360.0,311.0 center=0.3430,0.1851 fill=0.000 frameScore=0.381
[basic-boxes] candidate#112 rect=303.0,309.0-315.0,320.0 center=0.2861,0.1933 fill=0.000 frameScore=0.378
[basic-boxes] candidate#113 rect=444.0,267.0-456.0,278.0 center=0.4646,0.1549 fill=0.000 frameScore=0.375
[basic-boxes] candidate#114 rect=387.0,309.0-399.0,320.0 center=0.3924,0.1933 fill=0.000 frameScore=0.375
[basic-boxes] candidate#115 rect=324.0,258.0-336.0,269.0 center=0.3127,0.1467 fill=0.000 frameScore=0.374
[basic-boxes] candidate#116 rect=660.0,291.0-672.0,302.0 center=0.7380,0.1769 fill=0.000 frameScore=0.372
[basic-boxes] candidate#117 rect=261.0,285.0-273.0,296.0 center=0.2329,0.1714 fill=0.000 frameScore=0.372
[basic-boxes] candidate#118 rect=333.0,324.0-345.0,335.0 center=0.3241,0.2070 fill=0.000 frameScore=0.372
[basic-boxes] candidate#119 rect=660.0,282.0-672.0,293.0 center=0.7380,0.1686 fill=0.000 frameScore=0.370
[basic-boxes] candidate#120 rect=538.0,318.0-551.0,330.0 center=0.5842,0.2020 fill=0.000 frameScore=0.369
[basic-boxes] candidate#121 rect=267.0,249.0-279.0,260.0 center=0.2405,0.1385 fill=0.000 frameScore=0.368
[basic-boxes] candidate#122 rect=717.0,282.0-729.0,293.0 center=0.8101,0.1686 fill=0.000 frameScore=0.368
[basic-boxes] candidate#123 rect=213.0,294.0-225.0,305.0 center=0.1722,0.1796 fill=0.000 frameScore=0.367
[basic-boxes] candidate#124 rect=366.0,234.0-378.0,245.0 center=0.3658,0.1248 fill=0.000 frameScore=0.365
[basic-boxes] candidate#125 rect=273.0,309.0-285.0,320.0 center=0.2481,0.1933 fill=0.000 frameScore=0.365
[basic-boxes] candidate#126 rect=253.0,332.0-266.0,344.0 center=0.2234,0.2148 fill=0.000 frameScore=0.364
[basic-boxes] candidate#127 rect=246.0,324.0-258.0,335.0 center=0.2139,0.2070 fill=0.000 frameScore=0.363
[basic-boxes] candidate#128 rect=660.0,300.0-672.0,311.0 center=0.7380,0.1851 fill=0.000 frameScore=0.363
[basic-boxes] candidate#129 rect=669.0,300.0-681.0,311.0 center=0.7494,0.1851 fill=0.000 frameScore=0.363
[basic-boxes] candidate#130 rect=589.0,244.0-603.0,256.0 center=0.6494,0.1344 fill=0.000 frameScore=0.362
[basic-boxes] candidate#131 rect=628.0,287.0-640.0,300.0 center=0.6975,0.1741 fill=0.000 frameScore=0.360
[basic-boxes] candidate#132 rect=435.0,255.0-447.0,266.0 center=0.4532,0.1440 fill=0.000 frameScore=0.359
[basic-boxes] candidate#133 rect=143.0,247.0-155.0,260.0 center=0.0835,0.1376 fill=0.000 frameScore=0.358
[basic-boxes] candidate#134 rect=524.0,244.0-536.0,256.0 center=0.5658,0.1344 fill=0.000 frameScore=0.357
[basic-boxes] candidate#135 rect=201.0,300.0-213.0,311.0 center=0.1570,0.1851 fill=0.000 frameScore=0.357
[basic-boxes] candidate#136 rect=201.0,309.0-213.0,320.0 center=0.1570,0.1933 fill=0.000 frameScore=0.357
[basic-boxes] candidate#137 rect=729.0,249.0-741.0,260.0 center=0.8253,0.1385 fill=0.000 frameScore=0.357
[basic-boxes] candidate#138 rect=651.0,255.0-663.0,266.0 center=0.7266,0.1440 fill=0.000 frameScore=0.355
[basic-boxes] candidate#139 rect=423.0,324.0-435.0,335.0 center=0.4380,0.2070 fill=0.000 frameScore=0.354
[basic-boxes] candidate#140 rect=246.0,300.0-258.0,311.0 center=0.2139,0.1851 fill=0.000 frameScore=0.354
[basic-boxes] candidate#141 rect=222.0,330.0-234.0,341.0 center=0.1835,0.2125 fill=0.000 frameScore=0.352
[basic-boxes] candidate#142 rect=726.0,300.0-738.0,311.0 center=0.8215,0.1851 fill=0.000 frameScore=0.351
[basic-boxes] candidate#143 rect=681.0,309.0-693.0,320.0 center=0.7646,0.1933 fill=0.000 frameScore=0.350
[basic-boxes] reference#0 normalized=0.7399,0.1474
[basic-boxes] reference#1 normalized=0.8440,0.1471
[basic-boxes] reference#2 normalized=0.2532,0.1656
[basic-boxes] reference#3 normalized=0.4758,0.1649
[basic-boxes] reference#4 normalized=0.2532,0.1833
[basic-boxes] reference#5 normalized=0.4775,0.1824
[basic-boxes] reference#6 normalized=0.2375,0.2011
[basic-boxes] reference#7 normalized=0.3372,0.2011
[basic-boxes] reference#8 normalized=0.4519,0.2006
[basic-boxes] reference#9 normalized=0.2375,0.2176
[basic-boxes] reference#10 normalized=0.3375,0.2171
[basic-boxes] reference#11 normalized=0.4519,0.2169
[basic-boxes] chosen translation=-0.0008,-0.0014 totalDistance=0.0279 maxDistance=0.0066 matches=12/12
[basic-boxes] small-translation seeds tried=15 (|x|,|y| <= 0.009)
[basic-boxes] best small translation=-0.0008,-0.0014 totalDistance=0.0279 maxDistance=0.0066 matches=12/12
[basic-boxes] matchBasicCheckboxes diagnostic=Checkbox geometry matched 12/12 candidates; max normalized residual 0.0066. 5 disagreed with that layout and were placed where it predicts (worst 6.0px).
[basic-boxes] matchedCount=12 maxResidual=0.0066 translation=-0.0008,-0.0014
[basic-boxes] final basic.gender[0] rect=661.0,257.0-673.0,269.0 correction=2.06px
[basic-boxes] final basic.gender[1] rect=743.0,256.0-755.0,268.0 correction=5.22px
[basic-boxes] final basic.schoolType[0] rect=276.0,276.0-288.0,288.0 correction=0.00px
[basic-boxes] final basic.schoolType[1] rect=452.0,276.0-464.0,288.0 correction=5.02px
[basic-boxes] final basic.schoolType[2] rect=276.0,296.0-288.0,308.0 correction=2.50px
[basic-boxes] final basic.schoolType[3] rect=454.0,295.0-466.0,307.0 correction=0.00px
[basic-boxes] final basic.grade[0] rect=264.0,315.0-276.0,326.0 correction=0.00px
[basic-boxes] final basic.grade[1] rect=343.0,315.0-355.0,327.0 correction=6.02px
[basic-boxes] final basic.grade[2] rect=433.0,315.0-446.0,327.0 correction=0.00px
[basic-boxes] final basic.grade[3] rect=264.0,333.0-277.0,345.0 correction=0.00px
[basic-boxes] final basic.grade[4] rect=343.0,333.0-355.0,345.0 correction=0.00px
[basic-boxes] final basic.grade[5] rect=433.0,333.0-446.0,345.0 correction=0.00px
[basic-boxes] wrote C:\Users\night\AppData\Local\Temp\claude\C--Users-night-Desktop-----------\d149eedf-bfb0-42b6-b2ca-4a34276eb708\scratchpad\cycle1\probe\browser-19-cagi-page-0001-basic.png crop=790x169 (2x -> 1580x338)
```

### 2. 브라우저 p2 (밀림, off ≈ -12~-16px, 세 그룹 모두 빈칸)

이미지: `C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/browser-19/cagi/page-0002.jpg`

```
[basic-boxes] image=C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/browser-19/cagi/page-0002.jpg
[basic-boxes] bounds={"left":83,"top":103,"right":873,"bottom":1197} source=template baselineBounds={"left":154,"top":190,"right":1619,"bottom":2219}
[basic-boxes] candidates=102
[basic-boxes] candidate#0 rect=433.0,314.0-445.0,326.0 center=0.4506,0.1984 fill=0.000 frameScore=0.708
[basic-boxes] candidate#1 rect=276.0,295.0-288.0,307.0 center=0.2519,0.1810 fill=0.000 frameScore=0.688
[basic-boxes] candidate#2 rect=440.0,274.0-454.0,286.0 center=0.4608,0.1618 fill=0.000 frameScore=0.675
[basic-boxes] candidate#3 rect=558.0,321.0-570.0,332.0 center=0.6089,0.2043 fill=0.000 frameScore=0.633
[basic-boxes] candidate#4 rect=129.0,285.0-141.0,296.0 center=0.0658,0.1714 fill=0.000 frameScore=0.618
[basic-boxes] candidate#5 rect=156.0,285.0-168.0,296.0 center=0.1000,0.1714 fill=0.000 frameScore=0.589
[basic-boxes] candidate#6 rect=276.0,276.0-288.0,288.0 center=0.2519,0.1636 fill=0.000 frameScore=0.583
[basic-boxes] candidate#7 rect=433.0,332.0-445.0,344.0 center=0.4506,0.2148 fill=0.000 frameScore=0.583
[basic-boxes] candidate#8 rect=141.0,285.0-153.0,296.0 center=0.0810,0.1714 fill=0.000 frameScore=0.576
[basic-boxes] candidate#9 rect=256.0,293.0-270.0,305.0 center=0.2278,0.1792 fill=0.000 frameScore=0.575
[basic-boxes] candidate#10 rect=549.0,321.0-561.0,332.0 center=0.5975,0.2043 fill=0.000 frameScore=0.569
[basic-boxes] candidate#11 rect=661.0,257.0-673.0,269.0 center=0.7392,0.1463 fill=0.000 frameScore=0.563
[basic-boxes] candidate#12 rect=263.0,333.0-275.0,345.0 center=0.2354,0.2157 fill=0.000 frameScore=0.563
[basic-boxes] candidate#13 rect=153.0,253.0-166.0,265.0 center=0.0968,0.1426 fill=0.000 frameScore=0.545
[basic-boxes] candidate#14 rect=127.0,252.0-139.0,264.0 center=0.0633,0.1417 fill=0.000 frameScore=0.538
[basic-boxes] candidate#15 rect=228.0,321.0-240.0,333.0 center=0.1911,0.2048 fill=0.000 frameScore=0.536
[basic-boxes] candidate#16 rect=450.0,230.0-462.0,242.0 center=0.4722,0.1216 fill=0.000 frameScore=0.535
[basic-boxes] candidate#17 rect=513.0,321.0-525.0,332.0 center=0.5519,0.2043 fill=0.000 frameScore=0.532
[basic-boxes] candidate#18 rect=543.0,261.0-555.0,272.0 center=0.5899,0.1495 fill=0.000 frameScore=0.531
[basic-boxes] candidate#19 rect=252.0,314.0-265.0,326.0 center=0.2222,0.1984 fill=0.000 frameScore=0.527
[basic-boxes] candidate#20 rect=518.0,259.0-530.0,272.0 center=0.5582,0.1485 fill=0.000 frameScore=0.525
[basic-boxes] candidate#21 rect=558.0,261.0-570.0,272.0 center=0.6089,0.1495 fill=0.000 frameScore=0.521
[basic-boxes] candidate#22 rect=528.0,261.0-540.0,272.0 center=0.5709,0.1495 fill=0.000 frameScore=0.520
[basic-boxes] candidate#23 rect=256.0,274.0-270.0,286.0 center=0.2278,0.1618 fill=0.000 frameScore=0.508
[basic-boxes] candidate#24 rect=403.0,293.0-415.0,305.0 center=0.4127,0.1792 fill=0.000 frameScore=0.495
[basic-boxes] candidate#25 rect=264.0,293.0-278.0,305.0 center=0.2380,0.1792 fill=0.000 frameScore=0.492
[basic-boxes] candidate#26 rect=518.0,281.0-530.0,293.0 center=0.5582,0.1682 fill=0.000 frameScore=0.491
[basic-boxes] candidate#27 rect=418.0,331.0-430.0,344.0 center=0.4316,0.2144 fill=0.000 frameScore=0.491
[basic-boxes] candidate#28 rect=163.0,285.0-175.0,297.0 center=0.1089,0.1718 fill=0.000 frameScore=0.487
[basic-boxes] candidate#29 rect=731.0,251.0-745.0,264.0 center=0.8291,0.1412 fill=0.000 frameScore=0.486
[basic-boxes] candidate#30 rect=264.0,274.0-277.0,286.0 center=0.2373,0.1618 fill=0.000 frameScore=0.485
[basic-boxes] candidate#31 rect=549.0,282.0-561.0,293.0 center=0.5975,0.1686 fill=0.000 frameScore=0.478
[basic-boxes] candidate#32 rect=222.0,309.0-234.0,320.0 center=0.1835,0.1933 fill=0.000 frameScore=0.475
[basic-boxes] candidate#33 rect=222.0,293.0-235.0,305.0 center=0.1842,0.1792 fill=0.000 frameScore=0.472
[basic-boxes] candidate#34 rect=163.0,323.0-175.0,335.0 center=0.1089,0.2066 fill=0.000 frameScore=0.471
[basic-boxes] candidate#35 rect=192.0,300.0-204.0,311.0 center=0.1456,0.1851 fill=0.000 frameScore=0.464
[basic-boxes] candidate#36 rect=192.0,309.0-204.0,320.0 center=0.1456,0.1933 fill=0.000 frameScore=0.464
[basic-boxes] candidate#37 rect=441.0,295.0-455.0,307.0 center=0.4620,0.1810 fill=0.000 frameScore=0.462
[basic-boxes] candidate#38 rect=420.0,314.0-434.0,326.0 center=0.4354,0.1984 fill=0.000 frameScore=0.462
[basic-boxes] candidate#39 rect=376.0,293.0-390.0,305.0 center=0.3797,0.1792 fill=0.000 frameScore=0.458
[basic-boxes] candidate#40 rect=253.0,333.0-265.0,345.0 center=0.2228,0.2157 fill=0.000 frameScore=0.457
[basic-boxes] candidate#41 rect=395.0,331.0-407.0,343.0 center=0.4025,0.2139 fill=0.000 frameScore=0.454
[basic-boxes] candidate#42 rect=141.0,258.0-153.0,269.0 center=0.0810,0.1467 fill=0.000 frameScore=0.452
[basic-boxes] candidate#43 rect=510.0,261.0-522.0,272.0 center=0.5481,0.1495 fill=0.000 frameScore=0.452
[basic-boxes] candidate#44 rect=402.0,321.0-414.0,332.0 center=0.4114,0.2043 fill=0.000 frameScore=0.446
[basic-boxes] candidate#45 rect=216.0,294.0-228.0,305.0 center=0.1759,0.1796 fill=0.000 frameScore=0.442
[basic-boxes] candidate#46 rect=744.0,246.0-756.0,257.0 center=0.8443,0.1357 fill=0.000 frameScore=0.442
[basic-boxes] candidate#47 rect=343.0,332.0-355.0,344.0 center=0.3367,0.2148 fill=0.000 frameScore=0.438
[basic-boxes] candidate#48 rect=118.0,253.0-130.0,265.0 center=0.0519,0.1426 fill=0.000 frameScore=0.430
[basic-boxes] candidate#49 rect=744.0,258.0-756.0,269.0 center=0.8443,0.1467 fill=0.000 frameScore=0.428
[basic-boxes] candidate#50 rect=498.0,321.0-510.0,332.0 center=0.5329,0.2043 fill=0.000 frameScore=0.422
[basic-boxes] candidate#51 rect=96.0,309.0-108.0,320.0 center=0.0241,0.1933 fill=0.000 frameScore=0.420
[basic-boxes] candidate#52 rect=549.0,246.0-561.0,257.0 center=0.5975,0.1357 fill=0.000 frameScore=0.417
[basic-boxes] candidate#53 rect=246.0,299.0-258.0,311.0 center=0.2139,0.1846 fill=0.000 frameScore=0.415
[basic-boxes] candidate#54 rect=246.0,324.0-258.0,335.0 center=0.2139,0.2070 fill=0.000 frameScore=0.414
[basic-boxes] candidate#55 rect=228.0,336.0-240.0,348.0 center=0.1911,0.2185 fill=0.000 frameScore=0.414
[basic-boxes] candidate#56 rect=222.0,274.0-235.0,286.0 center=0.1842,0.1618 fill=0.000 frameScore=0.414
[basic-boxes] candidate#57 rect=304.0,331.0-316.0,343.0 center=0.2873,0.2139 fill=0.000 frameScore=0.413
[basic-boxes] candidate#58 rect=498.0,261.0-510.0,272.0 center=0.5329,0.1495 fill=0.000 frameScore=0.411
[basic-boxes] candidate#59 rect=498.0,270.0-510.0,281.0 center=0.5329,0.1577 fill=0.000 frameScore=0.411
[basic-boxes] candidate#60 rect=477.0,234.0-489.0,245.0 center=0.5063,0.1248 fill=0.000 frameScore=0.409
[basic-boxes] candidate#61 rect=327.0,324.0-339.0,335.0 center=0.3165,0.2070 fill=0.000 frameScore=0.409
[basic-boxes] candidate#62 rect=360.0,276.0-372.0,287.0 center=0.3582,0.1632 fill=0.000 frameScore=0.407
[basic-boxes] candidate#63 rect=163.0,253.0-175.0,265.0 center=0.1089,0.1426 fill=0.000 frameScore=0.406
[basic-boxes] candidate#64 rect=414.0,270.0-426.0,281.0 center=0.4266,0.1577 fill=0.000 frameScore=0.403
[basic-boxes] candidate#65 rect=304.0,313.0-316.0,325.0 center=0.2873,0.1974 fill=0.000 frameScore=0.403
[basic-boxes] candidate#66 rect=423.0,261.0-435.0,272.0 center=0.4380,0.1495 fill=0.000 frameScore=0.400
[basic-boxes] candidate#67 rect=118.0,285.0-130.0,298.0 center=0.0519,0.1723 fill=0.000 frameScore=0.396
[basic-boxes] candidate#68 rect=426.0,324.0-438.0,335.0 center=0.4418,0.2070 fill=0.000 frameScore=0.396
[basic-boxes] candidate#69 rect=402.0,303.0-414.0,314.0 center=0.4114,0.1878 fill=0.000 frameScore=0.395
[basic-boxes] candidate#70 rect=118.0,322.0-130.0,335.0 center=0.0519,0.2061 fill=0.000 frameScore=0.392
[basic-boxes] candidate#71 rect=645.0,251.0-657.0,264.0 center=0.7190,0.1412 fill=0.000 frameScore=0.389
[basic-boxes] candidate#72 rect=645.0,261.0-657.0,272.0 center=0.7190,0.1495 fill=0.000 frameScore=0.386
[basic-boxes] candidate#73 rect=411.0,333.0-423.0,344.0 center=0.4228,0.2153 fill=0.000 frameScore=0.385
[basic-boxes] candidate#74 rect=528.0,324.0-540.0,335.0 center=0.5709,0.2070 fill=0.000 frameScore=0.383
[basic-boxes] candidate#75 rect=235.0,273.0-249.0,285.0 center=0.2013,0.1609 fill=0.000 frameScore=0.381
[basic-boxes] candidate#76 rect=246.0,309.0-258.0,320.0 center=0.2139,0.1933 fill=0.000 frameScore=0.380
[basic-boxes] candidate#77 rect=514.0,228.0-526.0,240.0 center=0.5532,0.1197 fill=0.000 frameScore=0.380
[basic-boxes] candidate#78 rect=585.0,261.0-597.0,272.0 center=0.6430,0.1495 fill=0.000 frameScore=0.379
[basic-boxes] candidate#79 rect=585.0,270.0-597.0,281.0 center=0.6430,0.1577 fill=0.000 frameScore=0.379
[basic-boxes] candidate#80 rect=402.0,312.0-414.0,323.0 center=0.4114,0.1961 fill=0.000 frameScore=0.378
[basic-boxes] candidate#81 rect=601.0,317.0-615.0,329.0 center=0.6646,0.2011 fill=0.000 frameScore=0.378
[basic-boxes] candidate#82 rect=585.0,319.0-598.0,331.0 center=0.6437,0.2029 fill=0.000 frameScore=0.377
[basic-boxes] candidate#83 rect=96.0,300.0-108.0,311.0 center=0.0241,0.1851 fill=0.000 frameScore=0.377
[basic-boxes] candidate#84 rect=358.0,230.0-370.0,243.0 center=0.3557,0.1220 fill=0.000 frameScore=0.376
[basic-boxes] candidate#85 rect=435.0,261.0-447.0,272.0 center=0.4532,0.1495 fill=0.000 frameScore=0.372
[basic-boxes] candidate#86 rect=384.0,294.0-396.0,305.0 center=0.3886,0.1796 fill=0.000 frameScore=0.372
[basic-boxes] candidate#87 rect=264.0,315.0-276.0,326.0 center=0.2367,0.1988 fill=0.000 frameScore=0.370
[basic-boxes] candidate#88 rect=220.0,335.0-232.0,348.0 center=0.1810,0.2180 fill=0.000 frameScore=0.370
[basic-boxes] candidate#89 rect=201.0,300.0-213.0,311.0 center=0.1570,0.1851 fill=0.000 frameScore=0.369
[basic-boxes] candidate#90 rect=201.0,309.0-213.0,320.0 center=0.1570,0.1933 fill=0.000 frameScore=0.369
[basic-boxes] candidate#91 rect=237.0,309.0-249.0,320.0 center=0.2025,0.1933 fill=0.000 frameScore=0.369
[basic-boxes] candidate#92 rect=327.0,315.0-339.0,326.0 center=0.3165,0.1988 fill=0.000 frameScore=0.367
[basic-boxes] candidate#93 rect=237.0,299.0-250.0,311.0 center=0.2032,0.1846 fill=0.000 frameScore=0.365
[basic-boxes] candidate#94 rect=312.0,321.0-324.0,332.0 center=0.2975,0.2043 fill=0.000 frameScore=0.363
[basic-boxes] candidate#95 rect=521.0,246.0-533.0,259.0 center=0.5620,0.1367 fill=0.000 frameScore=0.363
[basic-boxes] candidate#96 rect=435.0,237.0-447.0,248.0 center=0.4532,0.1275 fill=0.000 frameScore=0.360
[basic-boxes] candidate#97 rect=321.0,252.0-333.0,263.0 center=0.3089,0.1412 fill=0.000 frameScore=0.359
[basic-boxes] candidate#98 rect=507.0,237.0-519.0,248.0 center=0.5443,0.1275 fill=0.000 frameScore=0.358
[basic-boxes] candidate#99 rect=625.0,287.0-637.0,299.0 center=0.6937,0.1737 fill=0.000 frameScore=0.355
[basic-boxes] candidate#100 rect=433.0,293.0-446.0,306.0 center=0.4513,0.1796 fill=0.000 frameScore=0.353
[basic-boxes] candidate#101 rect=705.0,252.0-717.0,263.0 center=0.7949,0.1412 fill=0.000 frameScore=0.350
[basic-boxes] reference#0 normalized=0.7399,0.1474
[basic-boxes] reference#1 normalized=0.8440,0.1471
[basic-boxes] reference#2 normalized=0.2532,0.1656
[basic-boxes] reference#3 normalized=0.4758,0.1649
[basic-boxes] reference#4 normalized=0.2532,0.1833
[basic-boxes] reference#5 normalized=0.4775,0.1824
[basic-boxes] reference#6 normalized=0.2375,0.2011
[basic-boxes] reference#7 normalized=0.3372,0.2011
[basic-boxes] reference#8 normalized=0.4519,0.2006
[basic-boxes] reference#9 normalized=0.2375,0.2176
[basic-boxes] reference#10 normalized=0.3375,0.2171
[basic-boxes] reference#11 normalized=0.4519,0.2169
[basic-boxes] chosen translation=-0.0159,-0.0038 totalDistance=0.0351 maxDistance=0.0081 matches=12/12
[basic-boxes] small-translation seeds tried=10 (|x|,|y| <= 0.009)
[basic-boxes] no small-translation seed produced a full 12-box assignment
[basic-boxes] matchBasicCheckboxes diagnostic=Checkbox geometry matched 12/12 candidates; max normalized residual 0.0081. 4 disagreed with that layout and were placed where it predicts (worst 8.5px).
[basic-boxes] matchedCount=12 maxResidual=0.0081 translation=-0.0159,-0.0038
[basic-boxes] final basic.gender[0] rect=648.0,255.0-662.0,267.0 correction=5.32px
[basic-boxes] final basic.gender[1] rect=731.0,251.0-745.0,264.0 correction=0.00px
[basic-boxes] final basic.schoolType[0] rect=264.0,274.0-277.0,286.0 correction=0.00px
[basic-boxes] final basic.schoolType[1] rect=440.0,274.0-454.0,286.0 correction=0.00px
[basic-boxes] final basic.schoolType[2] rect=264.0,293.0-278.0,305.0 correction=0.00px
[basic-boxes] final basic.schoolType[3] rect=441.0,295.0-455.0,307.0 correction=0.00px
[basic-boxes] final basic.grade[0] rect=252.0,314.0-265.0,326.0 correction=0.00px
[basic-boxes] final basic.grade[1] rect=330.0,314.0-344.0,326.0 correction=4.03px
[basic-boxes] final basic.grade[2] rect=420.0,314.0-434.0,326.0 correction=0.00px
[basic-boxes] final basic.grade[3] rect=253.0,333.0-265.0,345.0 correction=0.00px
[basic-boxes] final basic.grade[4] rect=330.0,331.0-344.0,343.0 correction=8.50px
[basic-boxes] final basic.grade[5] rect=421.0,331.0-435.0,343.0 correction=4.03px
[basic-boxes] wrote C:\Users\night\AppData\Local\Temp\claude\C--Users-night-Desktop-----------\d149eedf-bfb0-42b6-b2ca-4a34276eb708\scratchpad\cycle1\probe\browser-19-cagi-page-0002-basic.png crop=790x169 (2x -> 1580x338)
```

### 3. 브라우저 p4 (밀림)

이미지: `C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/browser-19/cagi/page-0004.jpg`

```
[basic-boxes] image=C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/browser-19/cagi/page-0004.jpg
[basic-boxes] bounds={"left":83,"top":103,"right":873,"bottom":1197} source=template baselineBounds={"left":154,"top":190,"right":1619,"bottom":2219}
[basic-boxes] candidates=106
[basic-boxes] candidate#0 rect=453.0,297.0-466.0,310.0 center=0.4766,0.1833 fill=0.000 frameScore=0.808
[basic-boxes] candidate#1 rect=276.0,298.0-288.0,311.0 center=0.2519,0.1842 fill=0.000 frameScore=0.770
[basic-boxes] candidate#2 rect=276.0,278.0-288.0,291.0 center=0.2519,0.1659 fill=0.000 frameScore=0.683
[basic-boxes] candidate#3 rect=343.0,335.0-355.0,347.0 center=0.3367,0.2176 fill=0.000 frameScore=0.677
[basic-boxes] candidate#4 rect=558.0,324.0-570.0,335.0 center=0.6089,0.2070 fill=0.000 frameScore=0.661
[basic-boxes] candidate#5 rect=507.0,230.0-519.0,242.0 center=0.5443,0.1216 fill=0.000 frameScore=0.622
[basic-boxes] candidate#6 rect=450.0,232.0-462.0,244.0 center=0.4722,0.1234 fill=0.000 frameScore=0.619
[basic-boxes] candidate#7 rect=453.0,288.0-465.0,299.0 center=0.4759,0.1741 fill=0.000 frameScore=0.616
[basic-boxes] candidate#8 rect=744.0,258.0-756.0,269.0 center=0.8443,0.1467 fill=0.000 frameScore=0.616
[basic-boxes] candidate#9 rect=513.0,324.0-525.0,335.0 center=0.5519,0.2070 fill=0.000 frameScore=0.600
[basic-boxes] candidate#10 rect=129.0,287.0-143.0,299.0 center=0.0671,0.1737 fill=0.000 frameScore=0.600
[basic-boxes] candidate#11 rect=441.0,298.0-455.0,310.0 center=0.4620,0.1837 fill=0.000 frameScore=0.597
[basic-boxes] candidate#12 rect=141.0,288.0-153.0,299.0 center=0.0810,0.1741 fill=0.000 frameScore=0.580
[basic-boxes] candidate#13 rect=264.0,296.0-278.0,308.0 center=0.2380,0.1819 fill=0.000 frameScore=0.574
[basic-boxes] candidate#14 rect=440.0,276.0-454.0,288.0 center=0.4608,0.1636 fill=0.000 frameScore=0.570
[basic-boxes] candidate#15 rect=549.0,285.0-561.0,296.0 center=0.5975,0.1714 fill=0.000 frameScore=0.569
[basic-boxes] candidate#16 rect=264.0,335.0-276.0,347.0 center=0.2367,0.2176 fill=0.000 frameScore=0.562
[basic-boxes] candidate#17 rect=246.0,312.0-258.0,324.0 center=0.2139,0.1965 fill=0.000 frameScore=0.560
[basic-boxes] candidate#18 rect=156.0,288.0-168.0,299.0 center=0.1000,0.1741 fill=0.000 frameScore=0.553
[basic-boxes] candidate#19 rect=434.0,295.0-447.0,308.0 center=0.4525,0.1814 fill=0.000 frameScore=0.552
[basic-boxes] candidate#20 rect=549.0,323.0-561.0,335.0 center=0.5975,0.2066 fill=0.000 frameScore=0.547
[basic-boxes] candidate#21 rect=433.0,317.0-445.0,329.0 center=0.4506,0.2011 fill=0.000 frameScore=0.543
[basic-boxes] candidate#22 rect=263.0,318.0-275.0,330.0 center=0.2354,0.2020 fill=0.000 frameScore=0.542
[basic-boxes] candidate#23 rect=403.0,296.0-415.0,308.0 center=0.4127,0.1819 fill=0.000 frameScore=0.532
[basic-boxes] candidate#24 rect=162.0,249.0-174.0,261.0 center=0.1076,0.1389 fill=0.000 frameScore=0.512
[basic-boxes] candidate#25 rect=750.0,324.0-762.0,335.0 center=0.8519,0.2070 fill=0.000 frameScore=0.504
[basic-boxes] candidate#26 rect=453.0,279.0-465.0,290.0 center=0.4759,0.1659 fill=0.000 frameScore=0.504
[basic-boxes] candidate#27 rect=649.0,324.0-661.0,337.0 center=0.7241,0.2080 fill=0.000 frameScore=0.501
[basic-boxes] candidate#28 rect=164.0,326.0-176.0,338.0 center=0.1101,0.2093 fill=0.000 frameScore=0.500
[basic-boxes] candidate#29 rect=376.0,296.0-390.0,308.0 center=0.3797,0.1819 fill=0.000 frameScore=0.499
[basic-boxes] candidate#30 rect=225.0,273.0-237.0,284.0 center=0.1873,0.1604 fill=0.000 frameScore=0.498
[basic-boxes] candidate#31 rect=327.0,312.0-339.0,324.0 center=0.3165,0.1965 fill=0.000 frameScore=0.496
[basic-boxes] candidate#32 rect=706.0,253.0-718.0,265.0 center=0.7962,0.1426 fill=0.000 frameScore=0.495
[basic-boxes] candidate#33 rect=503.0,324.0-515.0,337.0 center=0.5392,0.2080 fill=0.000 frameScore=0.494
[basic-boxes] candidate#34 rect=240.0,276.0-252.0,287.0 center=0.2063,0.1632 fill=0.000 frameScore=0.493
[basic-boxes] candidate#35 rect=126.0,255.0-138.0,266.0 center=0.0620,0.1440 fill=0.000 frameScore=0.492
[basic-boxes] candidate#36 rect=549.0,258.0-561.0,269.0 center=0.5975,0.1467 fill=0.000 frameScore=0.491
[basic-boxes] candidate#37 rect=515.0,230.0-527.0,242.0 center=0.5544,0.1216 fill=0.000 frameScore=0.488
[basic-boxes] candidate#38 rect=141.0,264.0-153.0,275.0 center=0.0810,0.1522 fill=0.000 frameScore=0.485
[basic-boxes] candidate#39 rect=246.0,328.0-258.0,341.0 center=0.2139,0.2116 fill=0.000 frameScore=0.484
[basic-boxes] candidate#40 rect=316.0,313.0-330.0,326.0 center=0.3038,0.1979 fill=0.000 frameScore=0.484
[basic-boxes] candidate#41 rect=222.0,297.0-235.0,309.0 center=0.1842,0.1828 fill=0.000 frameScore=0.483
[basic-boxes] candidate#42 rect=123.0,287.0-136.0,299.0 center=0.0589,0.1737 fill=0.000 frameScore=0.476
[basic-boxes] candidate#43 rect=164.0,288.0-176.0,300.0 center=0.1101,0.1746 fill=0.000 frameScore=0.475
[basic-boxes] candidate#44 rect=343.0,317.0-355.0,330.0 center=0.3367,0.2016 fill=0.000 frameScore=0.474
[basic-boxes] candidate#45 rect=518.0,283.0-530.0,295.0 center=0.5582,0.1700 fill=0.000 frameScore=0.464
[basic-boxes] candidate#46 rect=549.0,249.0-561.0,260.0 center=0.5975,0.1385 fill=0.000 frameScore=0.463
[basic-boxes] candidate#47 rect=118.0,255.0-130.0,267.0 center=0.0519,0.1444 fill=0.000 frameScore=0.461
[basic-boxes] candidate#48 rect=246.0,297.0-258.0,308.0 center=0.2139,0.1824 fill=0.000 frameScore=0.461
[basic-boxes] candidate#49 rect=153.0,258.0-165.0,269.0 center=0.0962,0.1467 fill=0.000 frameScore=0.461
[basic-boxes] candidate#50 rect=162.0,264.0-174.0,275.0 center=0.1076,0.1522 fill=0.000 frameScore=0.459
[basic-boxes] candidate#51 rect=516.0,240.0-528.0,251.0 center=0.5557,0.1303 fill=0.000 frameScore=0.458
[basic-boxes] candidate#52 rect=427.0,273.0-441.0,286.0 center=0.4443,0.1613 fill=0.000 frameScore=0.457
[basic-boxes] candidate#53 rect=474.0,229.0-488.0,241.0 center=0.5038,0.1207 fill=0.000 frameScore=0.455
[basic-boxes] candidate#54 rect=364.0,226.0-377.0,238.0 center=0.3639,0.1179 fill=0.000 frameScore=0.446
[basic-boxes] candidate#55 rect=192.0,255.0-204.0,266.0 center=0.1456,0.1440 fill=0.000 frameScore=0.442
[basic-boxes] candidate#56 rect=747.0,246.0-759.0,257.0 center=0.8481,0.1357 fill=0.000 frameScore=0.441
[basic-boxes] candidate#57 rect=477.0,239.0-490.0,251.0 center=0.5070,0.1298 fill=0.000 frameScore=0.438
[basic-boxes] candidate#58 rect=376.0,239.0-388.0,251.0 center=0.3785,0.1298 fill=0.000 frameScore=0.438
[basic-boxes] candidate#59 rect=640.0,319.0-652.0,331.0 center=0.7127,0.2029 fill=0.000 frameScore=0.436
[basic-boxes] candidate#60 rect=528.0,324.0-540.0,335.0 center=0.5709,0.2070 fill=0.000 frameScore=0.433
[basic-boxes] candidate#61 rect=417.0,273.0-429.0,284.0 center=0.4304,0.1604 fill=0.000 frameScore=0.432
[basic-boxes] candidate#62 rect=402.0,324.0-414.0,335.0 center=0.4114,0.2070 fill=0.000 frameScore=0.431
[basic-boxes] candidate#63 rect=424.0,296.0-436.0,309.0 center=0.4392,0.1824 fill=0.000 frameScore=0.430
[basic-boxes] candidate#64 rect=132.0,264.0-144.0,275.0 center=0.0696,0.1522 fill=0.000 frameScore=0.429
[basic-boxes] candidate#65 rect=660.0,282.0-672.0,293.0 center=0.7380,0.1686 fill=0.000 frameScore=0.428
[basic-boxes] candidate#66 rect=312.0,324.0-324.0,335.0 center=0.2975,0.2070 fill=0.000 frameScore=0.426
[basic-boxes] candidate#67 rect=264.0,276.0-277.0,288.0 center=0.2373,0.1636 fill=0.000 frameScore=0.422
[basic-boxes] candidate#68 rect=235.0,302.0-249.0,314.0 center=0.2013,0.1874 fill=0.000 frameScore=0.418
[basic-boxes] candidate#69 rect=418.0,316.0-430.0,328.0 center=0.4316,0.2002 fill=0.000 frameScore=0.417
[basic-boxes] candidate#70 rect=305.0,313.0-317.0,325.0 center=0.2886,0.1974 fill=0.000 frameScore=0.411
[basic-boxes] candidate#71 rect=201.0,255.0-213.0,266.0 center=0.1570,0.1440 fill=0.000 frameScore=0.411
[basic-boxes] candidate#72 rect=216.0,297.0-228.0,308.0 center=0.1759,0.1824 fill=0.000 frameScore=0.410
[basic-boxes] candidate#73 rect=418.0,327.0-430.0,339.0 center=0.4316,0.2102 fill=0.000 frameScore=0.409
[basic-boxes] candidate#74 rect=335.0,335.0-348.0,347.0 center=0.3272,0.2176 fill=0.000 frameScore=0.408
[basic-boxes] candidate#75 rect=438.0,264.0-450.0,275.0 center=0.4570,0.1522 fill=0.000 frameScore=0.406
[basic-boxes] candidate#76 rect=695.0,271.0-707.0,283.0 center=0.7823,0.1590 fill=0.000 frameScore=0.406
[basic-boxes] candidate#77 rect=402.0,306.0-414.0,317.0 center=0.4114,0.1906 fill=0.000 frameScore=0.406
[basic-boxes] candidate#78 rect=728.0,256.0-740.0,269.0 center=0.8241,0.1458 fill=0.000 frameScore=0.406
[basic-boxes] candidate#79 rect=222.0,318.0-234.0,329.0 center=0.1835,0.2016 fill=0.000 frameScore=0.404
[basic-boxes] candidate#80 rect=304.0,334.0-316.0,346.0 center=0.2873,0.2166 fill=0.000 frameScore=0.403
[basic-boxes] candidate#81 rect=174.0,255.0-186.0,266.0 center=0.1228,0.1440 fill=0.000 frameScore=0.403
[basic-boxes] candidate#82 rect=487.0,237.0-500.0,250.0 center=0.5196,0.1284 fill=0.000 frameScore=0.401
[basic-boxes] candidate#83 rect=656.0,258.0-669.0,270.0 center=0.7335,0.1472 fill=0.000 frameScore=0.400
[basic-boxes] candidate#84 rect=222.0,333.0-234.0,344.0 center=0.1835,0.2153 fill=0.000 frameScore=0.399
[basic-boxes] candidate#85 rect=518.0,254.0-530.0,266.0 center=0.5582,0.1435 fill=0.000 frameScore=0.397
[basic-boxes] candidate#86 rect=670.0,271.0-682.0,283.0 center=0.7506,0.1590 fill=0.000 frameScore=0.396
[basic-boxes] candidate#87 rect=400.0,333.0-414.0,345.0 center=0.4101,0.2157 fill=0.000 frameScore=0.396
[basic-boxes] candidate#88 rect=324.0,249.0-336.0,260.0 center=0.3127,0.1385 fill=0.000 frameScore=0.392
[basic-boxes] candidate#89 rect=255.0,297.0-267.0,308.0 center=0.2253,0.1824 fill=0.000 frameScore=0.388
[basic-boxes] candidate#90 rect=246.0,288.0-258.0,299.0 center=0.2139,0.1741 fill=0.000 frameScore=0.384
[basic-boxes] candidate#91 rect=399.0,315.0-411.0,326.0 center=0.4076,0.1988 fill=0.000 frameScore=0.384
[basic-boxes] candidate#92 rect=402.0,230.0-414.0,242.0 center=0.4114,0.1216 fill=0.000 frameScore=0.382
[basic-boxes] candidate#93 rect=118.0,326.0-130.0,339.0 center=0.0519,0.2098 fill=0.000 frameScore=0.382
[basic-boxes] candidate#94 rect=540.0,330.0-552.0,341.0 center=0.5861,0.2125 fill=0.000 frameScore=0.382
[basic-boxes] candidate#95 rect=540.0,321.0-552.0,332.0 center=0.5861,0.2043 fill=0.000 frameScore=0.379
[basic-boxes] candidate#96 rect=321.0,339.0-333.0,350.0 center=0.3089,0.2207 fill=0.000 frameScore=0.378
[basic-boxes] candidate#97 rect=144.0,255.0-156.0,266.0 center=0.0848,0.1440 fill=0.000 frameScore=0.378
[basic-boxes] candidate#98 rect=507.0,240.0-519.0,251.0 center=0.5443,0.1303 fill=0.000 frameScore=0.367
[basic-boxes] candidate#99 rect=322.0,259.0-334.0,271.0 center=0.3101,0.1481 fill=0.000 frameScore=0.364
[basic-boxes] candidate#100 rect=111.0,264.0-123.0,275.0 center=0.0430,0.1522 fill=0.000 frameScore=0.361
[basic-boxes] candidate#101 rect=384.0,297.0-396.0,308.0 center=0.3886,0.1824 fill=0.000 frameScore=0.356
[basic-boxes] candidate#102 rect=303.0,249.0-315.0,260.0 center=0.2861,0.1385 fill=0.000 frameScore=0.355
[basic-boxes] candidate#103 rect=633.0,258.0-645.0,269.0 center=0.7038,0.1467 fill=0.000 frameScore=0.354
[basic-boxes] candidate#104 rect=288.0,249.0-300.0,260.0 center=0.2671,0.1385 fill=0.000 frameScore=0.352
[basic-boxes] candidate#105 rect=255.0,348.0-267.0,359.0 center=0.2253,0.2290 fill=0.000 frameScore=0.351
[basic-boxes] reference#0 normalized=0.7399,0.1474
[basic-boxes] reference#1 normalized=0.8440,0.1471
[basic-boxes] reference#2 normalized=0.2532,0.1656
[basic-boxes] reference#3 normalized=0.4758,0.1649
[basic-boxes] reference#4 normalized=0.2532,0.1833
[basic-boxes] reference#5 normalized=0.4775,0.1824
[basic-boxes] reference#6 normalized=0.2375,0.2011
[basic-boxes] reference#7 normalized=0.3372,0.2011
[basic-boxes] reference#8 normalized=0.4519,0.2006
[basic-boxes] reference#9 normalized=0.2375,0.2176
[basic-boxes] reference#10 normalized=0.3375,0.2171
[basic-boxes] reference#11 normalized=0.4519,0.2169
[basic-boxes] chosen translation=-0.0159,-0.0020 totalDistance=0.0585 maxDistance=0.0097 matches=12/12
[basic-boxes] small-translation seeds tried=13 (|x|,|y| <= 0.009)
[basic-boxes] best small translation=-0.0064,-0.0002 totalDistance=0.0695 maxDistance=0.0153 matches=12/12
[basic-boxes] matchBasicCheckboxes diagnostic=Checkbox geometry matched 12/12 candidates; max normalized residual 0.0097. 1 disagreed with that layout and were placed where it predicts (worst 9.6px).
[basic-boxes] matchedCount=12 maxResidual=0.0097 translation=-0.0159,-0.0020
[basic-boxes] final basic.gender[0] rect=647.0,257.0-659.0,269.0 correction=9.55px
[basic-boxes] final basic.gender[1] rect=728.0,256.0-740.0,269.0 correction=0.00px
[basic-boxes] final basic.schoolType[0] rect=264.0,276.0-277.0,288.0 correction=0.00px
[basic-boxes] final basic.schoolType[1] rect=440.0,276.0-454.0,288.0 correction=0.00px
[basic-boxes] final basic.schoolType[2] rect=264.0,296.0-278.0,308.0 correction=0.00px
[basic-boxes] final basic.schoolType[3] rect=441.0,298.0-455.0,310.0 correction=0.00px
[basic-boxes] final basic.grade[0] rect=246.0,312.0-258.0,324.0 correction=0.00px
[basic-boxes] final basic.grade[1] rect=327.0,312.0-339.0,324.0 correction=0.00px
[basic-boxes] final basic.grade[2] rect=418.0,316.0-430.0,328.0 correction=0.00px
[basic-boxes] final basic.grade[3] rect=246.0,328.0-258.0,341.0 correction=0.00px
[basic-boxes] final basic.grade[4] rect=335.0,335.0-348.0,347.0 correction=0.00px
[basic-boxes] final basic.grade[5] rect=418.0,327.0-430.0,339.0 correction=0.00px
[basic-boxes] wrote C:\Users\night\AppData\Local\Temp\claude\C--Users-night-Desktop-----------\d149eedf-bfb0-42b6-b2ca-4a34276eb708\scratchpad\cycle1\probe\browser-19-cagi-page-0004-basic.png crop=790x169 (2x -> 1580x338)
```

### 4. 브라우저 p11 (밀림)

이미지: `C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/browser-19/cagi/page-0011.jpg`

```
[basic-boxes] image=C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/browser-19/cagi/page-0011.jpg
[basic-boxes] bounds={"left":83,"top":103,"right":873,"bottom":1197} source=template baselineBounds={"left":154,"top":190,"right":1619,"bottom":2219}
[basic-boxes] candidates=101
[basic-boxes] candidate#0 rect=453.0,296.0-466.0,308.0 center=0.4766,0.1819 fill=0.000 frameScore=0.765
[basic-boxes] candidate#1 rect=452.0,276.0-464.0,289.0 center=0.4747,0.1641 fill=0.000 frameScore=0.659
[basic-boxes] candidate#2 rect=558.0,324.0-570.0,335.0 center=0.6089,0.2070 fill=0.000 frameScore=0.636
[basic-boxes] candidate#3 rect=263.0,315.0-275.0,327.0 center=0.2354,0.1993 fill=0.000 frameScore=0.615
[basic-boxes] candidate#4 rect=507.0,230.0-519.0,242.0 center=0.5443,0.1216 fill=0.000 frameScore=0.612
[basic-boxes] candidate#5 rect=222.0,275.0-235.0,287.0 center=0.1842,0.1627 fill=0.000 frameScore=0.610
[basic-boxes] candidate#6 rect=433.0,315.0-445.0,328.0 center=0.4506,0.1997 fill=0.000 frameScore=0.603
[basic-boxes] candidate#7 rect=513.0,324.0-525.0,335.0 center=0.5519,0.2070 fill=0.000 frameScore=0.598
[basic-boxes] candidate#8 rect=156.0,285.0-168.0,296.0 center=0.1000,0.1714 fill=0.000 frameScore=0.598
[basic-boxes] candidate#9 rect=128.0,285.0-142.0,297.0 center=0.0658,0.1718 fill=0.000 frameScore=0.598
[basic-boxes] candidate#10 rect=450.0,231.0-462.0,244.0 center=0.4722,0.1229 fill=0.000 frameScore=0.596
[basic-boxes] candidate#11 rect=143.0,257.0-157.0,270.0 center=0.0848,0.1467 fill=0.000 frameScore=0.575
[basic-boxes] candidate#12 rect=440.0,275.0-454.0,287.0 center=0.4608,0.1627 fill=0.000 frameScore=0.571
[basic-boxes] candidate#13 rect=163.0,323.0-175.0,336.0 center=0.1089,0.2070 fill=0.000 frameScore=0.568
[basic-boxes] candidate#14 rect=141.0,285.0-153.0,296.0 center=0.0810,0.1714 fill=0.000 frameScore=0.566
[basic-boxes] candidate#15 rect=263.0,333.0-275.0,345.0 center=0.2354,0.2157 fill=0.000 frameScore=0.552
[basic-boxes] candidate#16 rect=327.0,310.0-339.0,322.0 center=0.3165,0.1947 fill=0.000 frameScore=0.548
[basic-boxes] candidate#17 rect=260.0,294.0-272.0,306.0 center=0.2316,0.1801 fill=0.000 frameScore=0.540
[basic-boxes] candidate#18 rect=342.0,315.0-354.0,326.0 center=0.3354,0.1988 fill=0.000 frameScore=0.535
[basic-boxes] candidate#19 rect=744.0,259.0-756.0,271.0 center=0.8443,0.1481 fill=0.000 frameScore=0.531
[basic-boxes] candidate#20 rect=441.0,299.0-455.0,312.0 center=0.4620,0.1851 fill=0.000 frameScore=0.520
[basic-boxes] candidate#21 rect=255.0,304.0-269.0,317.0 center=0.2266,0.1897 fill=0.000 frameScore=0.519
[basic-boxes] candidate#22 rect=516.0,240.0-528.0,251.0 center=0.5557,0.1303 fill=0.000 frameScore=0.516
[basic-boxes] candidate#23 rect=518.0,283.0-530.0,295.0 center=0.5582,0.1700 fill=0.000 frameScore=0.501
[basic-boxes] candidate#24 rect=655.0,258.0-668.0,270.0 center=0.7323,0.1472 fill=0.000 frameScore=0.499
[basic-boxes] candidate#25 rect=517.0,230.0-529.0,242.0 center=0.5570,0.1216 fill=0.000 frameScore=0.499
[basic-boxes] candidate#26 rect=548.0,287.0-560.0,299.0 center=0.5962,0.1737 fill=0.000 frameScore=0.499
[basic-boxes] candidate#27 rect=136.0,253.0-150.0,265.0 center=0.0759,0.1426 fill=0.000 frameScore=0.497
[basic-boxes] candidate#28 rect=549.0,249.0-561.0,260.0 center=0.5975,0.1385 fill=0.000 frameScore=0.497
[basic-boxes] candidate#29 rect=549.0,324.0-561.0,335.0 center=0.5975,0.2070 fill=0.000 frameScore=0.495
[basic-boxes] candidate#30 rect=467.0,231.0-479.0,244.0 center=0.4937,0.1229 fill=0.000 frameScore=0.492
[basic-boxes] candidate#31 rect=503.0,323.0-515.0,336.0 center=0.5392,0.2070 fill=0.000 frameScore=0.482
[basic-boxes] candidate#32 rect=118.0,253.0-130.0,265.0 center=0.0519,0.1426 fill=0.000 frameScore=0.482
[basic-boxes] candidate#33 rect=420.0,338.0-434.0,350.0 center=0.4354,0.2203 fill=0.000 frameScore=0.482
[basic-boxes] candidate#34 rect=162.0,247.0-174.0,259.0 center=0.1076,0.1371 fill=0.000 frameScore=0.470
[basic-boxes] candidate#35 rect=549.0,258.0-561.0,269.0 center=0.5975,0.1467 fill=0.000 frameScore=0.466
[basic-boxes] candidate#36 rect=237.0,315.0-249.0,326.0 center=0.2025,0.1988 fill=0.000 frameScore=0.464
[basic-boxes] candidate#37 rect=237.0,333.0-249.0,344.0 center=0.2025,0.2153 fill=0.000 frameScore=0.464
[basic-boxes] candidate#38 rect=163.0,285.0-175.0,298.0 center=0.1089,0.1723 fill=0.000 frameScore=0.462
[basic-boxes] candidate#39 rect=528.0,255.0-540.0,266.0 center=0.5709,0.1440 fill=0.000 frameScore=0.460
[basic-boxes] candidate#40 rect=256.0,275.0-270.0,287.0 center=0.2278,0.1627 fill=0.000 frameScore=0.454
[basic-boxes] candidate#41 rect=216.0,276.0-228.0,287.0 center=0.1759,0.1632 fill=0.000 frameScore=0.454
[basic-boxes] candidate#42 rect=400.0,311.0-414.0,324.0 center=0.4101,0.1961 fill=0.000 frameScore=0.450
[basic-boxes] candidate#43 rect=394.0,337.0-407.0,349.0 center=0.4019,0.2194 fill=0.000 frameScore=0.450
[basic-boxes] candidate#44 rect=222.0,333.0-234.0,344.0 center=0.1835,0.2153 fill=0.000 frameScore=0.448
[basic-boxes] candidate#45 rect=558.0,255.0-570.0,266.0 center=0.6089,0.1440 fill=0.000 frameScore=0.444
[basic-boxes] candidate#46 rect=222.0,300.0-235.0,312.0 center=0.1842,0.1856 fill=0.000 frameScore=0.436
[basic-boxes] candidate#47 rect=327.0,328.0-339.0,340.0 center=0.3165,0.2112 fill=0.000 frameScore=0.436
[basic-boxes] candidate#48 rect=153.0,258.0-165.0,269.0 center=0.0962,0.1467 fill=0.000 frameScore=0.432
[basic-boxes] candidate#49 rect=624.0,255.0-636.0,266.0 center=0.6924,0.1440 fill=0.000 frameScore=0.430
[basic-boxes] candidate#50 rect=706.0,254.0-718.0,266.0 center=0.7962,0.1435 fill=0.000 frameScore=0.428
[basic-boxes] candidate#51 rect=651.0,249.0-663.0,260.0 center=0.7266,0.1385 fill=0.000 frameScore=0.426
[basic-boxes] candidate#52 rect=126.0,255.0-138.0,266.0 center=0.0620,0.1440 fill=0.000 frameScore=0.424
[basic-boxes] candidate#53 rect=663.0,249.0-675.0,260.0 center=0.7418,0.1385 fill=0.000 frameScore=0.419
[basic-boxes] candidate#54 rect=376.0,294.0-390.0,306.0 center=0.3797,0.1801 fill=0.000 frameScore=0.418
[basic-boxes] candidate#55 rect=728.0,255.0-740.0,267.0 center=0.8241,0.1444 fill=0.000 frameScore=0.416
[basic-boxes] candidate#56 rect=413.0,276.0-426.0,289.0 center=0.4259,0.1641 fill=0.000 frameScore=0.416
[basic-boxes] candidate#57 rect=451.0,242.0-463.0,255.0 center=0.4734,0.1330 fill=0.000 frameScore=0.415
[basic-boxes] candidate#58 rect=216.0,285.0-228.0,296.0 center=0.1759,0.1714 fill=0.000 frameScore=0.414
[basic-boxes] candidate#59 rect=235.0,299.0-249.0,312.0 center=0.2013,0.1851 fill=0.000 frameScore=0.413
[basic-boxes] candidate#60 rect=540.0,321.0-552.0,332.0 center=0.5861,0.2043 fill=0.000 frameScore=0.410
[basic-boxes] candidate#61 rect=645.0,264.0-657.0,275.0 center=0.7190,0.1522 fill=0.000 frameScore=0.410
[basic-boxes] candidate#62 rect=649.0,324.0-661.0,337.0 center=0.7241,0.2080 fill=0.000 frameScore=0.409
[basic-boxes] candidate#63 rect=669.0,282.0-681.0,293.0 center=0.7494,0.1686 fill=0.000 frameScore=0.405
[basic-boxes] candidate#64 rect=453.0,267.0-465.0,278.0 center=0.4759,0.1549 fill=0.000 frameScore=0.403
[basic-boxes] candidate#65 rect=172.0,254.0-184.0,267.0 center=0.1203,0.1440 fill=0.000 frameScore=0.403
[basic-boxes] candidate#66 rect=252.0,315.0-265.0,327.0 center=0.2222,0.1993 fill=0.000 frameScore=0.399
[basic-boxes] candidate#67 rect=300.0,254.0-312.0,266.0 center=0.2823,0.1435 fill=0.000 frameScore=0.399
[basic-boxes] candidate#68 rect=701.0,325.0-713.0,337.0 center=0.7899,0.2084 fill=0.000 frameScore=0.396
[basic-boxes] candidate#69 rect=290.0,254.0-302.0,267.0 center=0.2696,0.1440 fill=0.000 frameScore=0.388
[basic-boxes] candidate#70 rect=402.0,229.0-414.0,241.0 center=0.4114,0.1207 fill=0.000 frameScore=0.387
[basic-boxes] candidate#71 rect=303.0,315.0-315.0,326.0 center=0.2861,0.1988 fill=0.000 frameScore=0.387
[basic-boxes] candidate#72 rect=507.0,240.0-519.0,251.0 center=0.5443,0.1303 fill=0.000 frameScore=0.385
[basic-boxes] candidate#73 rect=636.0,348.0-648.0,359.0 center=0.7076,0.2290 fill=0.000 frameScore=0.384
[basic-boxes] candidate#74 rect=248.0,338.0-260.0,350.0 center=0.2165,0.2203 fill=0.000 frameScore=0.383
[basic-boxes] candidate#75 rect=477.0,234.0-489.0,245.0 center=0.5063,0.1248 fill=0.000 frameScore=0.383
[basic-boxes] candidate#76 rect=117.0,285.0-129.0,296.0 center=0.0506,0.1714 fill=0.000 frameScore=0.381
[basic-boxes] candidate#77 rect=519.0,255.0-531.0,266.0 center=0.5595,0.1440 fill=0.000 frameScore=0.377
[basic-boxes] candidate#78 rect=633.0,255.0-645.0,266.0 center=0.7038,0.1440 fill=0.000 frameScore=0.376
[basic-boxes] candidate#79 rect=376.0,238.0-388.0,250.0 center=0.3785,0.1289 fill=0.000 frameScore=0.375
[basic-boxes] candidate#80 rect=708.0,282.0-720.0,293.0 center=0.7987,0.1686 fill=0.000 frameScore=0.373
[basic-boxes] candidate#81 rect=423.0,316.0-435.0,328.0 center=0.4380,0.2002 fill=0.000 frameScore=0.372
[basic-boxes] candidate#82 rect=528.0,330.0-540.0,341.0 center=0.5709,0.2125 fill=0.000 frameScore=0.370
[basic-boxes] candidate#83 rect=225.0,285.0-237.0,296.0 center=0.1873,0.1714 fill=0.000 frameScore=0.370
[basic-boxes] candidate#84 rect=304.0,337.0-316.0,349.0 center=0.2873,0.2194 fill=0.000 frameScore=0.367
[basic-boxes] candidate#85 rect=528.0,321.0-540.0,332.0 center=0.5709,0.2043 fill=0.000 frameScore=0.366
[basic-boxes] candidate#86 rect=132.0,264.0-144.0,275.0 center=0.0696,0.1522 fill=0.000 frameScore=0.365
[basic-boxes] candidate#87 rect=162.0,258.0-174.0,269.0 center=0.1076,0.1467 fill=0.000 frameScore=0.363
[basic-boxes] candidate#88 rect=487.0,237.0-500.0,250.0 center=0.5196,0.1284 fill=0.000 frameScore=0.363
[basic-boxes] candidate#89 rect=582.0,348.0-594.0,359.0 center=0.6392,0.2290 fill=0.000 frameScore=0.363
[basic-boxes] candidate#90 rect=615.0,348.0-627.0,359.0 center=0.6810,0.2290 fill=0.000 frameScore=0.363
[basic-boxes] candidate#91 rect=429.0,276.0-441.0,287.0 center=0.4456,0.1632 fill=0.000 frameScore=0.360
[basic-boxes] candidate#92 rect=261.0,285.0-273.0,296.0 center=0.2329,0.1714 fill=0.000 frameScore=0.360
[basic-boxes] candidate#93 rect=345.0,306.0-357.0,317.0 center=0.3392,0.1906 fill=0.000 frameScore=0.359
[basic-boxes] candidate#94 rect=429.0,299.0-443.0,312.0 center=0.4468,0.1851 fill=0.000 frameScore=0.358
[basic-boxes] candidate#95 rect=153.0,249.0-165.0,260.0 center=0.0962,0.1385 fill=0.000 frameScore=0.357
[basic-boxes] candidate#96 rect=234.0,283.0-248.0,296.0 center=0.2000,0.1705 fill=0.000 frameScore=0.355
[basic-boxes] candidate#97 rect=237.0,324.0-249.0,335.0 center=0.2025,0.2070 fill=0.000 frameScore=0.352
[basic-boxes] candidate#98 rect=366.0,283.0-378.0,296.0 center=0.3658,0.1705 fill=0.000 frameScore=0.351
[basic-boxes] candidate#99 rect=558.0,264.0-570.0,275.0 center=0.6089,0.1522 fill=0.000 frameScore=0.351
[basic-boxes] candidate#100 rect=705.0,264.0-717.0,275.0 center=0.7949,0.1522 fill=0.000 frameScore=0.350
[basic-boxes] reference#0 normalized=0.7399,0.1474
[basic-boxes] reference#1 normalized=0.8440,0.1471
[basic-boxes] reference#2 normalized=0.2532,0.1656
[basic-boxes] reference#3 normalized=0.4758,0.1649
[basic-boxes] reference#4 normalized=0.2532,0.1833
[basic-boxes] reference#5 normalized=0.4775,0.1824
[basic-boxes] reference#6 normalized=0.2375,0.2011
[basic-boxes] reference#7 normalized=0.3372,0.2011
[basic-boxes] reference#8 normalized=0.4519,0.2006
[basic-boxes] reference#9 normalized=0.2375,0.2176
[basic-boxes] reference#10 normalized=0.3375,0.2171
[basic-boxes] reference#11 normalized=0.4519,0.2169
[basic-boxes] chosen translation=-0.0200,-0.0027 totalDistance=0.0578 maxDistance=0.0076 matches=12/12
[basic-boxes] small-translation seeds tried=10 (|x|,|y| <= 0.009)
[basic-boxes] best small translation=-0.0077,-0.0002 totalDistance=0.0979 maxDistance=0.0146 matches=12/12
[basic-boxes] matchBasicCheckboxes diagnostic=Checkbox geometry matched 12/12 candidates; max normalized residual 0.0076.
[basic-boxes] matchedCount=12 maxResidual=0.0076 translation=-0.0200,-0.0027
[basic-boxes] final basic.gender[0] rect=645.0,264.0-657.0,275.0 correction=0.00px
[basic-boxes] final basic.gender[1] rect=728.0,255.0-740.0,267.0 correction=0.00px
[basic-boxes] final basic.schoolType[0] rect=256.0,275.0-270.0,287.0 correction=0.00px
[basic-boxes] final basic.schoolType[1] rect=440.0,275.0-454.0,287.0 correction=0.00px
[basic-boxes] final basic.schoolType[2] rect=260.0,294.0-272.0,306.0 correction=0.00px
[basic-boxes] final basic.schoolType[3] rect=441.0,299.0-455.0,312.0 correction=0.00px
[basic-boxes] final basic.grade[0] rect=252.0,315.0-265.0,327.0 correction=0.00px
[basic-boxes] final basic.grade[1] rect=327.0,310.0-339.0,322.0 correction=0.00px
[basic-boxes] final basic.grade[2] rect=423.0,316.0-435.0,328.0 correction=0.00px
[basic-boxes] final basic.grade[3] rect=248.0,338.0-260.0,350.0 correction=0.00px
[basic-boxes] final basic.grade[4] rect=327.0,328.0-339.0,340.0 correction=0.00px
[basic-boxes] final basic.grade[5] rect=420.0,338.0-434.0,350.0 correction=0.00px
[basic-boxes] wrote C:\Users\night\AppData\Local\Temp\claude\C--Users-night-Desktop-----------\d149eedf-bfb0-42b6-b2ca-4a34276eb708\scratchpad\cycle1\probe\browser-19-cagi-page-0011-basic.png crop=790x169 (2x -> 1580x338)
```

### 5. 브라우저 p5 (off=+50~+74, 배치 실패)

이미지: `C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/browser-19/cagi/page-0005.jpg`

```
[basic-boxes] image=C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/browser-19/cagi/page-0005.jpg
[basic-boxes] bounds={"left":83,"top":103,"right":873,"bottom":1197} source=template baselineBounds={"left":154,"top":190,"right":1619,"bottom":2219}
[basic-boxes] candidates=89
[basic-boxes] candidate#0 rect=453.0,295.0-466.0,307.0 center=0.4766,0.1810 fill=0.000 frameScore=0.767
[basic-boxes] candidate#1 rect=276.0,296.0-288.0,308.0 center=0.2519,0.1819 fill=0.000 frameScore=0.708
[basic-boxes] candidate#2 rect=263.0,334.0-275.0,346.0 center=0.2354,0.2166 fill=0.000 frameScore=0.688
[basic-boxes] candidate#3 rect=128.0,286.0-142.0,298.0 center=0.0658,0.1728 fill=0.000 frameScore=0.645
[basic-boxes] candidate#4 rect=558.0,324.0-570.0,335.0 center=0.6089,0.2070 fill=0.000 frameScore=0.639
[basic-boxes] candidate#5 rect=450.0,231.0-462.0,244.0 center=0.4722,0.1229 fill=0.000 frameScore=0.607
[basic-boxes] candidate#6 rect=343.0,315.0-355.0,327.0 center=0.3367,0.1993 fill=0.000 frameScore=0.604
[basic-boxes] candidate#7 rect=513.0,324.0-525.0,335.0 center=0.5519,0.2070 fill=0.000 frameScore=0.599
[basic-boxes] candidate#8 rect=276.0,277.0-288.0,289.0 center=0.2519,0.1645 fill=0.000 frameScore=0.583
[basic-boxes] candidate#9 rect=433.0,315.0-445.0,327.0 center=0.4506,0.1993 fill=0.000 frameScore=0.583
[basic-boxes] candidate#10 rect=433.0,333.0-445.0,345.0 center=0.4506,0.2157 fill=0.000 frameScore=0.583
[basic-boxes] candidate#11 rect=655.0,257.0-667.0,269.0 center=0.7316,0.1463 fill=0.000 frameScore=0.583
[basic-boxes] candidate#12 rect=156.0,288.0-168.0,299.0 center=0.1000,0.1741 fill=0.000 frameScore=0.574
[basic-boxes] candidate#13 rect=263.0,315.0-275.0,327.0 center=0.2354,0.1993 fill=0.000 frameScore=0.572
[basic-boxes] candidate#14 rect=163.0,323.0-175.0,336.0 center=0.1089,0.2070 fill=0.000 frameScore=0.563
[basic-boxes] candidate#15 rect=343.0,333.0-355.0,345.0 center=0.3367,0.2157 fill=0.000 frameScore=0.563
[basic-boxes] candidate#16 rect=143.0,258.0-157.0,271.0 center=0.0848,0.1476 fill=0.000 frameScore=0.560
[basic-boxes] candidate#17 rect=452.0,276.0-464.0,288.0 center=0.4747,0.1636 fill=0.000 frameScore=0.556
[basic-boxes] candidate#18 rect=506.0,229.0-519.0,241.0 center=0.5437,0.1207 fill=0.000 frameScore=0.555
[basic-boxes] candidate#19 rect=253.0,310.0-265.0,322.0 center=0.2228,0.1947 fill=0.000 frameScore=0.554
[basic-boxes] candidate#20 rect=141.0,288.0-153.0,299.0 center=0.0810,0.1741 fill=0.000 frameScore=0.541
[basic-boxes] candidate#21 rect=440.0,275.0-454.0,287.0 center=0.4608,0.1627 fill=0.000 frameScore=0.537
[basic-boxes] candidate#22 rect=548.0,322.0-560.0,334.0 center=0.5962,0.2057 fill=0.000 frameScore=0.537
[basic-boxes] candidate#23 rect=162.0,264.0-174.0,275.0 center=0.1076,0.1522 fill=0.000 frameScore=0.526
[basic-boxes] candidate#24 rect=264.0,295.0-278.0,307.0 center=0.2380,0.1810 fill=0.000 frameScore=0.522
[basic-boxes] candidate#25 rect=403.0,294.0-415.0,306.0 center=0.4127,0.1801 fill=0.000 frameScore=0.521
[basic-boxes] candidate#26 rect=548.0,257.0-560.0,269.0 center=0.5962,0.1463 fill=0.000 frameScore=0.517
[basic-boxes] candidate#27 rect=441.0,294.0-455.0,307.0 center=0.4620,0.1805 fill=0.000 frameScore=0.502
[basic-boxes] candidate#28 rect=136.0,254.0-150.0,266.0 center=0.0759,0.1435 fill=0.000 frameScore=0.497
[basic-boxes] candidate#29 rect=163.0,286.0-175.0,299.0 center=0.1089,0.1732 fill=0.000 frameScore=0.495
[basic-boxes] candidate#30 rect=253.0,333.0-265.0,345.0 center=0.2228,0.2157 fill=0.000 frameScore=0.491
[basic-boxes] candidate#31 rect=518.0,282.0-530.0,294.0 center=0.5582,0.1691 fill=0.000 frameScore=0.485
[basic-boxes] candidate#32 rect=236.0,300.0-250.0,312.0 center=0.2025,0.1856 fill=0.000 frameScore=0.485
[basic-boxes] candidate#33 rect=548.0,247.0-560.0,259.0 center=0.5962,0.1371 fill=0.000 frameScore=0.483
[basic-boxes] candidate#34 rect=126.0,255.0-138.0,266.0 center=0.0620,0.1440 fill=0.000 frameScore=0.477
[basic-boxes] candidate#35 rect=222.0,295.0-235.0,307.0 center=0.1842,0.1810 fill=0.000 frameScore=0.477
[basic-boxes] candidate#36 rect=132.0,264.0-144.0,275.0 center=0.0696,0.1522 fill=0.000 frameScore=0.472
[basic-boxes] candidate#37 rect=548.0,286.0-560.0,298.0 center=0.5962,0.1728 fill=0.000 frameScore=0.472
[basic-boxes] candidate#38 rect=159.0,249.0-171.0,260.0 center=0.1038,0.1385 fill=0.000 frameScore=0.466
[basic-boxes] candidate#39 rect=237.0,273.0-249.0,284.0 center=0.2025,0.1604 fill=0.000 frameScore=0.464
[basic-boxes] candidate#40 rect=153.0,258.0-165.0,269.0 center=0.0962,0.1467 fill=0.000 frameScore=0.455
[basic-boxes] candidate#41 rect=147.0,249.0-159.0,260.0 center=0.0886,0.1385 fill=0.000 frameScore=0.455
[basic-boxes] candidate#42 rect=420.0,315.0-434.0,327.0 center=0.4354,0.1993 fill=0.000 frameScore=0.449
[basic-boxes] candidate#43 rect=655.0,247.0-669.0,259.0 center=0.7329,0.1371 fill=0.000 frameScore=0.442
[basic-boxes] candidate#44 rect=381.0,294.0-393.0,306.0 center=0.3848,0.1801 fill=0.000 frameScore=0.439
[basic-boxes] candidate#45 rect=330.0,338.0-344.0,350.0 center=0.3215,0.2203 fill=0.000 frameScore=0.437
[basic-boxes] candidate#46 rect=487.0,237.0-500.0,250.0 center=0.5196,0.1284 fill=0.000 frameScore=0.433
[basic-boxes] candidate#47 rect=264.0,276.0-278.0,288.0 center=0.2380,0.1636 fill=0.000 frameScore=0.433
[basic-boxes] candidate#48 rect=435.0,294.0-447.0,305.0 center=0.4532,0.1796 fill=0.000 frameScore=0.424
[basic-boxes] candidate#49 rect=118.0,322.0-130.0,334.0 center=0.0519,0.2057 fill=0.000 frameScore=0.423
[basic-boxes] candidate#50 rect=400.0,332.0-414.0,344.0 center=0.4101,0.2148 fill=0.000 frameScore=0.419
[basic-boxes] candidate#51 rect=402.0,229.0-414.0,241.0 center=0.4114,0.1207 fill=0.000 frameScore=0.419
[basic-boxes] candidate#52 rect=303.0,315.0-315.0,326.0 center=0.2861,0.1988 fill=0.000 frameScore=0.418
[basic-boxes] candidate#53 rect=309.0,338.0-323.0,350.0 center=0.2949,0.2203 fill=0.000 frameScore=0.417
[basic-boxes] candidate#54 rect=438.0,285.0-450.0,296.0 center=0.4570,0.1714 fill=0.000 frameScore=0.405
[basic-boxes] candidate#55 rect=701.0,321.0-713.0,333.0 center=0.7899,0.2048 fill=0.000 frameScore=0.405
[basic-boxes] candidate#56 rect=225.0,273.0-237.0,284.0 center=0.1873,0.1604 fill=0.000 frameScore=0.405
[basic-boxes] candidate#57 rect=228.0,310.0-240.0,322.0 center=0.1911,0.1947 fill=0.000 frameScore=0.405
[basic-boxes] candidate#58 rect=318.0,309.0-330.0,320.0 center=0.3051,0.1933 fill=0.000 frameScore=0.395
[basic-boxes] candidate#59 rect=645.0,253.0-657.0,265.0 center=0.7190,0.1426 fill=0.000 frameScore=0.395
[basic-boxes] candidate#60 rect=240.0,348.0-252.0,359.0 center=0.2063,0.2290 fill=0.000 frameScore=0.394
[basic-boxes] candidate#61 rect=255.0,276.0-267.0,287.0 center=0.2253,0.1632 fill=0.000 frameScore=0.394
[basic-boxes] candidate#62 rect=424.0,294.0-436.0,307.0 center=0.4392,0.1805 fill=0.000 frameScore=0.394
[basic-boxes] candidate#63 rect=246.0,294.0-258.0,305.0 center=0.2139,0.1796 fill=0.000 frameScore=0.392
[basic-boxes] candidate#64 rect=498.0,327.0-510.0,338.0 center=0.5329,0.2098 fill=0.000 frameScore=0.387
[basic-boxes] candidate#65 rect=249.0,348.0-261.0,359.0 center=0.2177,0.2290 fill=0.000 frameScore=0.384
[basic-boxes] candidate#66 rect=442.0,257.0-454.0,270.0 center=0.4620,0.1467 fill=0.000 frameScore=0.383
[basic-boxes] candidate#67 rect=327.0,309.0-339.0,321.0 center=0.3165,0.1938 fill=0.000 frameScore=0.382
[basic-boxes] candidate#68 rect=359.0,232.0-371.0,244.0 center=0.3570,0.1234 fill=0.000 frameScore=0.380
[basic-boxes] candidate#69 rect=514.0,230.0-526.0,242.0 center=0.5532,0.1216 fill=0.000 frameScore=0.379
[basic-boxes] candidate#70 rect=466.0,231.0-478.0,243.0 center=0.4924,0.1225 fill=0.000 frameScore=0.379
[basic-boxes] candidate#71 rect=220.0,311.0-233.0,324.0 center=0.1816,0.1961 fill=0.000 frameScore=0.378
[basic-boxes] candidate#72 rect=227.0,338.0-240.0,350.0 center=0.1905,0.2203 fill=0.000 frameScore=0.378
[basic-boxes] candidate#73 rect=386.0,239.0-399.0,251.0 center=0.3918,0.1298 fill=0.000 frameScore=0.374
[basic-boxes] candidate#74 rect=518.0,257.0-530.0,269.0 center=0.5582,0.1463 fill=0.000 frameScore=0.373
[basic-boxes] candidate#75 rect=412.0,275.0-426.0,288.0 center=0.4253,0.1632 fill=0.000 frameScore=0.373
[basic-boxes] candidate#76 rect=410.0,237.0-422.0,250.0 center=0.4215,0.1284 fill=0.000 frameScore=0.371
[basic-boxes] candidate#77 rect=306.0,324.0-318.0,335.0 center=0.2899,0.2070 fill=0.000 frameScore=0.366
[basic-boxes] candidate#78 rect=246.0,339.0-258.0,350.0 center=0.2139,0.2207 fill=0.000 frameScore=0.366
[basic-boxes] candidate#79 rect=273.0,348.0-285.0,359.0 center=0.2481,0.2290 fill=0.000 frameScore=0.363
[basic-boxes] candidate#80 rect=246.0,276.0-258.0,287.0 center=0.2139,0.1632 fill=0.000 frameScore=0.362
[basic-boxes] candidate#81 rect=323.0,258.0-335.0,270.0 center=0.3114,0.1472 fill=0.000 frameScore=0.358
[basic-boxes] candidate#82 rect=753.0,321.0-765.0,332.0 center=0.8557,0.2043 fill=0.000 frameScore=0.358
[basic-boxes] candidate#83 rect=525.0,324.0-537.0,335.0 center=0.5671,0.2070 fill=0.000 frameScore=0.358
[basic-boxes] candidate#84 rect=117.0,285.0-129.0,296.0 center=0.0506,0.1714 fill=0.000 frameScore=0.356
[basic-boxes] candidate#85 rect=744.0,324.0-756.0,335.0 center=0.8443,0.2070 fill=0.000 frameScore=0.355
[basic-boxes] candidate#86 rect=255.0,294.0-267.0,305.0 center=0.2253,0.1796 fill=0.000 frameScore=0.354
[basic-boxes] candidate#87 rect=388.0,314.0-400.0,326.0 center=0.3937,0.1984 fill=0.000 frameScore=0.353
[basic-boxes] candidate#88 rect=264.0,348.0-276.0,359.0 center=0.2367,0.2290 fill=0.000 frameScore=0.351
[basic-boxes] reference#0 normalized=0.7399,0.1474
[basic-boxes] reference#1 normalized=0.8440,0.1471
[basic-boxes] reference#2 normalized=0.2532,0.1656
[basic-boxes] reference#3 normalized=0.4758,0.1649
[basic-boxes] reference#4 normalized=0.2532,0.1833
[basic-boxes] reference#5 normalized=0.4775,0.1824
[basic-boxes] reference#6 normalized=0.2375,0.2011
[basic-boxes] reference#7 normalized=0.3372,0.2011
[basic-boxes] reference#8 normalized=0.4519,0.2006
[basic-boxes] reference#9 normalized=0.2375,0.2176
[basic-boxes] reference#10 normalized=0.3375,0.2171
[basic-boxes] reference#11 normalized=0.4519,0.2169
[basic-boxes] findTranslationMatch returned undefined (no full 12-box assignment within tolerance)
[basic-boxes] small-translation seeds tried=12 (|x|,|y| <= 0.009)
[basic-boxes] no small-translation seed produced a full 12-box assignment
[basic-boxes] matchBasicCheckboxes returned undefined
[basic-boxes] wrote C:\Users\night\AppData\Local\Temp\claude\C--Users-night-Desktop-----------\d149eedf-bfb0-42b6-b2ca-4a34276eb708\scratchpad\cycle1\probe\browser-19-cagi-page-0005-basic.png crop=790x169 (2x -> 1580x338)
```

### 6. 노드 렌더 p2 (정상 비교군)

이미지: `C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/scanpages-set1/cagi/page-0002.jpg`

```
[basic-boxes] image=C:/Users/night/AppData/Local/Temp/claude/C--Users-night-Desktop-----------/d149eedf-bfb0-42b6-b2ca-4a34276eb708/scratchpad/scanpages-set1/cagi/page-0002.jpg
[basic-boxes] bounds={"left":83,"top":103,"right":874,"bottom":1198} source=template baselineBounds={"left":154,"top":190,"right":1619,"bottom":2219}
[basic-boxes] candidates=129
[basic-boxes] candidate#0 rect=276.0,295.0-288.0,307.0 center=0.2516,0.1808 fill=0.000 frameScore=0.812
[basic-boxes] candidate#1 rect=263.0,332.0-276.0,345.0 center=0.2358,0.2151 fill=0.000 frameScore=0.740
[basic-boxes] candidate#2 rect=433.0,314.0-445.0,326.0 center=0.4501,0.1982 fill=0.000 frameScore=0.708
[basic-boxes] candidate#3 rect=343.0,332.0-355.0,344.0 center=0.3363,0.2146 fill=0.000 frameScore=0.708
[basic-boxes] candidate#4 rect=263.0,314.0-276.0,326.0 center=0.2358,0.1982 fill=0.000 frameScore=0.704
[basic-boxes] candidate#5 rect=661.0,257.0-673.0,269.0 center=0.7383,0.1461 fill=0.000 frameScore=0.688
[basic-boxes] candidate#6 rect=440.0,274.0-454.0,286.0 center=0.4602,0.1616 fill=0.000 frameScore=0.675
[basic-boxes] candidate#7 rect=558.0,321.0-570.0,332.0 center=0.6081,0.2041 fill=0.000 frameScore=0.641
[basic-boxes] candidate#8 rect=549.0,321.0-561.0,332.0 center=0.5967,0.2041 fill=0.000 frameScore=0.622
[basic-boxes] candidate#9 rect=129.0,285.0-141.0,296.0 center=0.0657,0.1712 fill=0.000 frameScore=0.612
[basic-boxes] candidate#10 rect=141.0,285.0-153.0,296.0 center=0.0809,0.1712 fill=0.000 frameScore=0.609
[basic-boxes] candidate#11 rect=256.0,293.0-270.0,305.0 center=0.2276,0.1790 fill=0.000 frameScore=0.604
[basic-boxes] candidate#12 rect=156.0,285.0-168.0,296.0 center=0.0999,0.1712 fill=0.000 frameScore=0.589
[basic-boxes] candidate#13 rect=252.0,314.0-265.0,326.0 center=0.2219,0.1982 fill=0.000 frameScore=0.586
[basic-boxes] candidate#14 rect=276.0,276.0-288.0,288.0 center=0.2516,0.1635 fill=0.000 frameScore=0.583
[basic-boxes] candidate#15 rect=433.0,332.0-445.0,344.0 center=0.4501,0.2146 fill=0.000 frameScore=0.583
[basic-boxes] candidate#16 rect=360.0,276.0-372.0,287.0 center=0.3578,0.1630 fill=0.000 frameScore=0.552
[basic-boxes] candidate#17 rect=738.0,256.0-750.0,268.0 center=0.8357,0.1452 fill=0.000 frameScore=0.548
[basic-boxes] candidate#18 rect=549.0,256.0-561.0,268.0 center=0.5967,0.1452 fill=0.000 frameScore=0.547
[basic-boxes] candidate#19 rect=558.0,261.0-570.0,272.0 center=0.6081,0.1493 fill=0.000 frameScore=0.544
[basic-boxes] candidate#20 rect=450.0,230.0-462.0,242.0 center=0.4716,0.1215 fill=0.000 frameScore=0.535
[basic-boxes] candidate#21 rect=342.0,315.0-354.0,326.0 center=0.3350,0.1986 fill=0.000 frameScore=0.533
[basic-boxes] candidate#22 rect=513.0,321.0-525.0,332.0 center=0.5512,0.2041 fill=0.000 frameScore=0.530
[basic-boxes] candidate#23 rect=216.0,294.0-228.0,305.0 center=0.1757,0.1795 fill=0.000 frameScore=0.527
[basic-boxes] candidate#24 rect=540.0,261.0-552.0,272.0 center=0.5853,0.1493 fill=0.000 frameScore=0.520
[basic-boxes] candidate#25 rect=264.0,294.0-278.0,306.0 center=0.2377,0.1799 fill=0.000 frameScore=0.506
[basic-boxes] candidate#26 rect=528.0,261.0-540.0,272.0 center=0.5702,0.1493 fill=0.000 frameScore=0.503
[basic-boxes] candidate#27 rect=518.0,281.0-530.0,293.0 center=0.5575,0.1680 fill=0.000 frameScore=0.501
[basic-boxes] candidate#28 rect=744.0,246.0-756.0,257.0 center=0.8432,0.1356 fill=0.000 frameScore=0.501
[basic-boxes] candidate#29 rect=549.0,282.0-561.0,293.0 center=0.5967,0.1685 fill=0.000 frameScore=0.500
[basic-boxes] candidate#30 rect=518.0,260.0-530.0,272.0 center=0.5575,0.1489 fill=0.000 frameScore=0.499
[basic-boxes] candidate#31 rect=403.0,293.0-415.0,305.0 center=0.4121,0.1790 fill=0.000 frameScore=0.499
[basic-boxes] candidate#32 rect=141.0,261.0-153.0,272.0 center=0.0809,0.1493 fill=0.000 frameScore=0.499
[basic-boxes] candidate#33 rect=623.0,259.0-635.0,272.0 center=0.6903,0.1484 fill=0.000 frameScore=0.498
[basic-boxes] candidate#34 rect=453.0,276.0-465.0,287.0 center=0.4753,0.1630 fill=0.000 frameScore=0.496
[basic-boxes] candidate#35 rect=222.0,309.0-234.0,320.0 center=0.1833,0.1932 fill=0.000 frameScore=0.496
[basic-boxes] candidate#36 rect=395.0,331.0-407.0,343.0 center=0.4020,0.2137 fill=0.000 frameScore=0.495
[basic-boxes] candidate#37 rect=446.0,264.0-458.0,277.0 center=0.4665,0.1530 fill=0.000 frameScore=0.494
[basic-boxes] candidate#38 rect=228.0,321.0-240.0,332.0 center=0.1909,0.2041 fill=0.000 frameScore=0.493
[basic-boxes] candidate#39 rect=163.0,323.0-175.0,335.0 center=0.1087,0.2064 fill=0.000 frameScore=0.487
[basic-boxes] candidate#40 rect=264.0,274.0-277.0,286.0 center=0.2370,0.1616 fill=0.000 frameScore=0.485
[basic-boxes] candidate#41 rect=514.0,228.0-526.0,240.0 center=0.5525,0.1196 fill=0.000 frameScore=0.477
[basic-boxes] candidate#42 rect=441.0,294.0-455.0,306.0 center=0.4614,0.1799 fill=0.000 frameScore=0.476
[basic-boxes] candidate#43 rect=601.0,317.0-615.0,329.0 center=0.6637,0.2009 fill=0.000 frameScore=0.474
[basic-boxes] candidate#44 rect=163.0,285.0-175.0,297.0 center=0.1087,0.1717 fill=0.000 frameScore=0.470
[basic-boxes] candidate#45 rect=418.0,313.0-430.0,326.0 center=0.4311,0.1977 fill=0.000 frameScore=0.470
[basic-boxes] candidate#46 rect=153.0,255.0-165.0,266.0 center=0.0961,0.1438 fill=0.000 frameScore=0.465
[basic-boxes] candidate#47 rect=192.0,300.0-204.0,311.0 center=0.1454,0.1849 fill=0.000 frameScore=0.464
[basic-boxes] candidate#48 rect=192.0,309.0-204.0,320.0 center=0.1454,0.1932 fill=0.000 frameScore=0.464
[basic-boxes] candidate#49 rect=423.0,261.0-435.0,272.0 center=0.4374,0.1493 fill=0.000 frameScore=0.460
[basic-boxes] candidate#50 rect=427.0,271.0-441.0,284.0 center=0.4437,0.1594 fill=0.000 frameScore=0.457
[basic-boxes] candidate#51 rect=126.0,252.0-138.0,263.0 center=0.0619,0.1411 fill=0.000 frameScore=0.455
[basic-boxes] candidate#52 rect=510.0,261.0-522.0,272.0 center=0.5474,0.1493 fill=0.000 frameScore=0.453
[basic-boxes] candidate#53 rect=237.0,309.0-249.0,320.0 center=0.2023,0.1932 fill=0.000 frameScore=0.448
[basic-boxes] candidate#54 rect=402.0,321.0-414.0,332.0 center=0.4109,0.2041 fill=0.000 frameScore=0.446
[basic-boxes] candidate#55 rect=376.0,293.0-390.0,305.0 center=0.3793,0.1790 fill=0.000 frameScore=0.446
[basic-boxes] candidate#56 rect=366.0,285.0-378.0,296.0 center=0.3654,0.1712 fill=0.000 frameScore=0.444
[basic-boxes] candidate#57 rect=540.0,324.0-552.0,335.0 center=0.5853,0.2068 fill=0.000 frameScore=0.443
[basic-boxes] candidate#58 rect=333.0,315.0-345.0,326.0 center=0.3236,0.1986 fill=0.000 frameScore=0.433
[basic-boxes] candidate#59 rect=237.0,299.0-250.0,311.0 center=0.2029,0.1845 fill=0.000 frameScore=0.429
[basic-boxes] candidate#60 rect=246.0,315.0-258.0,326.0 center=0.2137,0.1986 fill=0.000 frameScore=0.429
[basic-boxes] candidate#61 rect=549.0,246.0-561.0,257.0 center=0.5967,0.1356 fill=0.000 frameScore=0.425
[basic-boxes] candidate#62 rect=246.0,324.0-258.0,335.0 center=0.2137,0.2068 fill=0.000 frameScore=0.423
[basic-boxes] candidate#63 rect=162.0,261.0-174.0,272.0 center=0.1075,0.1493 fill=0.000 frameScore=0.422
[basic-boxes] candidate#64 rect=732.0,246.0-744.0,257.0 center=0.8281,0.1356 fill=0.000 frameScore=0.421
[basic-boxes] candidate#65 rect=129.0,261.0-141.0,272.0 center=0.0657,0.1493 fill=0.000 frameScore=0.421
[basic-boxes] candidate#66 rect=96.0,309.0-108.0,320.0 center=0.0240,0.1932 fill=0.000 frameScore=0.420
[basic-boxes] candidate#67 rect=423.0,333.0-435.0,344.0 center=0.4374,0.2151 fill=0.000 frameScore=0.420
[basic-boxes] candidate#68 rect=304.0,331.0-316.0,343.0 center=0.2870,0.2137 fill=0.000 frameScore=0.418
[basic-boxes] candidate#69 rect=453.0,294.0-465.0,305.0 center=0.4753,0.1795 fill=0.000 frameScore=0.417
[basic-boxes] candidate#70 rect=222.0,274.0-235.0,286.0 center=0.1839,0.1616 fill=0.000 frameScore=0.415
[basic-boxes] candidate#71 rect=304.0,313.0-317.0,325.0 center=0.2876,0.1973 fill=0.000 frameScore=0.414
[basic-boxes] candidate#72 rect=507.0,237.0-519.0,248.0 center=0.5436,0.1274 fill=0.000 frameScore=0.413
[basic-boxes] candidate#73 rect=235.0,282.0-249.0,295.0 center=0.2010,0.1694 fill=0.000 frameScore=0.412
[basic-boxes] candidate#74 rect=237.0,333.0-249.0,344.0 center=0.2023,0.2151 fill=0.000 frameScore=0.412
[basic-boxes] candidate#75 rect=498.0,261.0-510.0,272.0 center=0.5322,0.1493 fill=0.000 frameScore=0.411
[basic-boxes] candidate#76 rect=498.0,270.0-510.0,281.0 center=0.5322,0.1575 fill=0.000 frameScore=0.411
[basic-boxes] candidate#77 rect=477.0,234.0-489.0,245.0 center=0.5057,0.1247 fill=0.000 frameScore=0.409
[basic-boxes] candidate#78 rect=228.0,336.0-240.0,348.0 center=0.1909,0.2183 fill=0.000 frameScore=0.408
[basic-boxes] candidate#79 rect=498.0,321.0-510.0,332.0 center=0.5322,0.2041 fill=0.000 frameScore=0.405
[basic-boxes] candidate#80 rect=225.0,285.0-237.0,296.0 center=0.1871,0.1712 fill=0.000 frameScore=0.405
[basic-boxes] candidate#81 rect=645.0,252.0-657.0,263.0 center=0.7181,0.1411 fill=0.000 frameScore=0.404
[basic-boxes] candidate#82 rect=312.0,321.0-324.0,332.0 center=0.2971,0.2041 fill=0.000 frameScore=0.404
[basic-boxes] candidate#83 rect=327.0,324.0-339.0,335.0 center=0.3161,0.2068 fill=0.000 frameScore=0.403
[basic-boxes] candidate#84 rect=609.0,317.0-621.0,329.0 center=0.6726,0.2009 fill=0.000 frameScore=0.403
[basic-boxes] candidate#85 rect=225.0,294.0-237.0,305.0 center=0.1871,0.1795 fill=0.000 frameScore=0.397
[basic-boxes] candidate#86 rect=426.0,324.0-438.0,335.0 center=0.4412,0.2068 fill=0.000 frameScore=0.396
[basic-boxes] candidate#87 rect=360.0,230.0-372.0,243.0 center=0.3578,0.1219 fill=0.000 frameScore=0.396
[basic-boxes] candidate#88 rect=402.0,303.0-414.0,314.0 center=0.4109,0.1877 fill=0.000 frameScore=0.395
[basic-boxes] candidate#89 rect=528.0,324.0-540.0,335.0 center=0.5702,0.2068 fill=0.000 frameScore=0.394
[basic-boxes] candidate#90 rect=414.0,270.0-426.0,281.0 center=0.4260,0.1575 fill=0.000 frameScore=0.393
[basic-boxes] candidate#91 rect=498.0,237.0-510.0,248.0 center=0.5322,0.1274 fill=0.000 frameScore=0.391
[basic-boxes] candidate#92 rect=585.0,319.0-597.0,331.0 center=0.6422,0.2027 fill=0.000 frameScore=0.389
[basic-boxes] candidate#93 rect=645.0,261.0-657.0,272.0 center=0.7181,0.1493 fill=0.000 frameScore=0.386
[basic-boxes] candidate#94 rect=246.0,285.0-258.0,296.0 center=0.2137,0.1712 fill=0.000 frameScore=0.385
[basic-boxes] candidate#95 rect=322.0,257.0-334.0,269.0 center=0.3097,0.1461 fill=0.000 frameScore=0.385
[basic-boxes] candidate#96 rect=246.0,294.0-258.0,305.0 center=0.2137,0.1795 fill=0.000 frameScore=0.383
[basic-boxes] candidate#97 rect=435.0,261.0-447.0,272.0 center=0.4526,0.1493 fill=0.000 frameScore=0.383
[basic-boxes] candidate#98 rect=216.0,285.0-228.0,296.0 center=0.1757,0.1712 fill=0.000 frameScore=0.382
[basic-boxes] candidate#99 rect=219.0,336.0-233.0,348.0 center=0.1808,0.2183 fill=0.000 frameScore=0.379
[basic-boxes] candidate#100 rect=411.0,333.0-423.0,344.0 center=0.4223,0.2151 fill=0.000 frameScore=0.379
[basic-boxes] candidate#101 rect=433.0,293.0-446.0,306.0 center=0.4507,0.1795 fill=0.000 frameScore=0.374
[basic-boxes] candidate#102 rect=435.0,237.0-447.0,248.0 center=0.4526,0.1274 fill=0.000 frameScore=0.372
[basic-boxes] candidate#103 rect=118.0,247.0-130.0,260.0 center=0.0518,0.1374 fill=0.000 frameScore=0.370
[basic-boxes] candidate#104 rect=395.0,313.0-407.0,325.0 center=0.4020,0.1973 fill=0.000 frameScore=0.370
[basic-boxes] candidate#105 rect=384.0,294.0-396.0,305.0 center=0.3881,0.1795 fill=0.000 frameScore=0.368
[basic-boxes] candidate#106 rect=118.0,322.0-130.0,335.0 center=0.0518,0.2059 fill=0.000 frameScore=0.367
[basic-boxes] candidate#107 rect=312.0,309.0-324.0,320.0 center=0.2971,0.1932 fill=0.000 frameScore=0.367
[basic-boxes] candidate#108 rect=96.0,300.0-108.0,311.0 center=0.0240,0.1849 fill=0.000 frameScore=0.366
[basic-boxes] candidate#109 rect=237.0,273.0-249.0,284.0 center=0.2023,0.1603 fill=0.000 frameScore=0.365
[basic-boxes] candidate#110 rect=324.0,309.0-336.0,320.0 center=0.3123,0.1932 fill=0.000 frameScore=0.364
[basic-boxes] candidate#111 rect=705.0,252.0-717.0,263.0 center=0.7939,0.1411 fill=0.000 frameScore=0.364
[basic-boxes] candidate#112 rect=168.0,243.0-180.0,255.0 center=0.1150,0.1333 fill=0.000 frameScore=0.363
[basic-boxes] candidate#113 rect=585.0,345.0-597.0,356.0 center=0.6422,0.2260 fill=0.000 frameScore=0.363
[basic-boxes] candidate#114 rect=705.0,261.0-717.0,272.0 center=0.7939,0.1493 fill=0.000 frameScore=0.362
[basic-boxes] candidate#115 rect=255.0,324.0-267.0,335.0 center=0.2250,0.2068 fill=0.000 frameScore=0.362
[basic-boxes] candidate#116 rect=411.0,315.0-423.0,326.0 center=0.4223,0.1986 fill=0.000 frameScore=0.361
[basic-boxes] candidate#117 rect=144.0,252.0-156.0,263.0 center=0.0847,0.1411 fill=0.000 frameScore=0.361
[basic-boxes] candidate#118 rect=633.0,261.0-645.0,272.0 center=0.7029,0.1493 fill=0.000 frameScore=0.361
[basic-boxes] candidate#119 rect=626.0,287.0-638.0,299.0 center=0.6941,0.1735 fill=0.000 frameScore=0.359
[basic-boxes] candidate#120 rect=585.0,261.0-597.0,272.0 center=0.6422,0.1493 fill=0.000 frameScore=0.357
[basic-boxes] candidate#121 rect=585.0,270.0-597.0,281.0 center=0.6422,0.1575 fill=0.000 frameScore=0.357
[basic-boxes] candidate#122 rect=111.0,261.0-123.0,272.0 center=0.0430,0.1493 fill=0.000 frameScore=0.355
[basic-boxes] candidate#123 rect=729.0,261.0-741.0,272.0 center=0.8243,0.1493 fill=0.000 frameScore=0.355
[basic-boxes] candidate#124 rect=573.0,324.0-585.0,335.0 center=0.6271,0.2068 fill=0.000 frameScore=0.352
[basic-boxes] candidate#125 rect=576.0,345.0-588.0,356.0 center=0.6308,0.2260 fill=0.000 frameScore=0.351
[basic-boxes] candidate#126 rect=417.0,324.0-429.0,335.0 center=0.4298,0.2068 fill=0.000 frameScore=0.351
[basic-boxes] candidate#127 rect=264.0,324.0-276.0,335.0 center=0.2364,0.2068 fill=0.000 frameScore=0.351
[basic-boxes] candidate#128 rect=540.0,315.0-552.0,326.0 center=0.5853,0.1986 fill=0.000 frameScore=0.350
[basic-boxes] reference#0 normalized=0.7399,0.1474
[basic-boxes] reference#1 normalized=0.8440,0.1471
[basic-boxes] reference#2 normalized=0.2532,0.1656
[basic-boxes] reference#3 normalized=0.4758,0.1649
[basic-boxes] reference#4 normalized=0.2532,0.1833
[basic-boxes] reference#5 normalized=0.4775,0.1824
[basic-boxes] reference#6 normalized=0.2375,0.2011
[basic-boxes] reference#7 normalized=0.3372,0.2011
[basic-boxes] reference#8 normalized=0.4519,0.2006
[basic-boxes] reference#9 normalized=0.2375,0.2176
[basic-boxes] reference#10 normalized=0.3375,0.2171
[basic-boxes] reference#11 normalized=0.4519,0.2169
[basic-boxes] chosen translation=-0.0018,-0.0024 totalDistance=0.0121 maxDistance=0.0066 matches=12/12
[basic-boxes] small-translation seeds tried=14 (|x|,|y| <= 0.009)
[basic-boxes] best small translation=-0.0018,-0.0024 totalDistance=0.0121 maxDistance=0.0066 matches=12/12
[basic-boxes] matchBasicCheckboxes diagnostic=Checkbox geometry matched 12/12 candidates; max normalized residual 0.0066. 3 disagreed with that layout and were placed where it predicts (worst 5.1px).
[basic-boxes] matchedCount=12 maxResidual=0.0066 translation=-0.0018,-0.0024
[basic-boxes] final basic.gender[0] rect=661.0,256.0-673.0,268.0 correction=1.00px
[basic-boxes] final basic.gender[1] rect=743.0,255.0-755.0,267.0 correction=5.10px
[basic-boxes] final basic.schoolType[0] rect=276.0,276.0-288.0,288.0 correction=0.00px
[basic-boxes] final basic.schoolType[1] rect=452.0,275.0-464.0,287.0 correction=1.12px
[basic-boxes] final basic.schoolType[2] rect=276.0,295.0-288.0,307.0 correction=0.00px
[basic-boxes] final basic.schoolType[3] rect=453.0,294.0-465.0,305.0 correction=0.00px
[basic-boxes] final basic.grade[0] rect=263.0,314.0-276.0,326.0 correction=0.00px
[basic-boxes] final basic.grade[1] rect=342.0,315.0-354.0,326.0 correction=0.00px
[basic-boxes] final basic.grade[2] rect=433.0,314.0-445.0,326.0 correction=0.00px
[basic-boxes] final basic.grade[3] rect=263.0,332.0-276.0,345.0 correction=0.00px
[basic-boxes] final basic.grade[4] rect=343.0,332.0-355.0,344.0 correction=0.00px
[basic-boxes] final basic.grade[5] rect=433.0,332.0-445.0,344.0 correction=0.00px
[basic-boxes] wrote C:\Users\night\AppData\Local\Temp\claude\C--Users-night-Desktop-----------\d149eedf-bfb0-42b6-b2ca-4a34276eb708\scratchpad\cycle1\probe\scanpages-set1-cagi-page-0002-basic.png crop=791x169 (2x -> 1582x338)
```

## 확신 없는 부분 / 확인해 달라고 표시하고 싶은 것

1. **`OUT` 환경변수 누락으로 첫 라운드는 전부 스킵됐다.** 셸 스크립트에서 `OUT="..." &&`로 변수만
   설정하고 각 `npx vitest` 호출에는 `IMAGE=...`만 prefix로 줬더니, 자식 프로세스에 `OUT`이 전달되지
   않아 6개 실행 모두 `describe.skip`으로 조용히 넘어갔다(exit code는 0). `grep -c "\[basic-boxes\]"`가
   0을 반환하는 것으로 알아챘고, `IMAGE=... OUT=... npx vitest ...`처럼 **두 변수 모두 같은 명령에
   prefix**하도록 고쳐 재실행해 이 보고서의 로그를 얻었다. 이 문서에 실린 로그는 재실행분이다.
2. **"기준 사각형(파랑)"을 페이지 좌표로 투영하는 방식은 지시문에 정확한 공식이 없어 직접 정했다.**
   `flattenGroupRects`가 반환하는 정규화 좌표(기준선 자신의 등록 경계에 대해 정규화)를 그대로 쓰지 않고,
   baseline의 각 후보 사각형(4개 모서리 전부)을 `baselineBounds` 대비 정규화한 뒤 **페이지 자신의**
   `bounds`로 역정규화해서(`projectRect`) 파란 사각형의 크기·위치를 만들었다. 이동(translation)을 적용하지
   않은, "레이아웃이 이 페이지에 그대로 있었다면 있어야 할 자리"를 보여주는 셈이다. 다른 정의(예: 이동을
   적용한 위치, 또는 중심점만 표시)를 원했다면 알려달라.
3. **`x` 크롭 범위는 지시문에 없어 임의로 정했다** — "y 범위는 기준점 12개를 포함하도록 ±40px"만
   명시돼 있어, x는 페이지의 등록 경계(`getRegistrationBounds(image)`) 전체 폭을 썼다. `BASIC_REGION`이
   좌우 0.5%~99.5%라 사실상 페이지 폭 전체와 거의 같다.
4. **"작은 이동" 후보의 시드 생성이 `findTranslationMatch` 내부와 완전히 같은 코드가 아니라 프로브 안에서
   재구현한 것이다** — `MAX_TRANSLATION`(비공개 상수, 0.03)은 노출 대상이 아니었으므로, 프로브는 그
   상한 없이 기준점×후보 쌍의 이동을 전부 순회한 뒤 `|x|,|y| ≤ MATCH_TOLERANCE/2`로만 걸렀다. 결과적으로
   같은 시드 집합을 만들지만(0.009 < 0.03이라 상한에 걸리는 시드가 없다), 구현이 원본 함수 안에 있지 않고
   프로브가 흉내 낸 것이라는 점은 밝혀둔다.
5. **`p5`는 `findTranslationMatch`가 `undefined`를 반환**해 `matchBasicCheckboxes` 최종 결과 로그가
   없다(위 5번 섹션 로그 참고). PNG는 그래도 썼다 — 파랑/초록만 있고 빨강(최종 창)은 없다.
6. **`scoringImage`가 항상 raw 등록 이미지와 같다는 것은 코드로 확인했지만(`selectGridDetectionStream`,
   `detectCheckmarks.ts:996-1034`), 이 프로브는 `selectGridDetectionStream` 자체를 호출하지 않고
   `applyTemplateRegistrationFrame`만 직접 호출한다.** `photoProvenance`가 false인 스캔 경로에서는
   두 결과가 동일함을 소스로 확인했지만, 혹시 이 6장 중 하나라도 `cagiPhotoProvenance: true` 경로로
   채점된 적이 있다면(사진 촬영본이 아니라 스캔/브라우저 렌더라 그럴 가능성은 낮아 보이지만) 이 프로브가
   그 분기를 재현하지 않는다는 점은 확인해 줄 필요가 있다.
