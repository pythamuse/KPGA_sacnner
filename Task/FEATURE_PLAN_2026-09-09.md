# 사진 등록 기능 — 작업 계획과 위임 (2026-09-09)

사용자 지시: 기능 구현 작업 계획을 세우고, **쉬운 작업은 코덱스(gpt-5.6-luna, reasoning max)** 에, **복잡한 작업은 오퍼스 서브에이전트**에
코드 작성을 맡긴다. 판정·측정·병합은 메인 에이전트가 한다(CLAUDE.md §0·§1). 이 지시로 2026-09-05의 "코덱스 중단·소넷 대체"는 해제됐다.

대상은 [PHOTO_BATCH_ORDER_2026-09-09.md](PHOTO_BATCH_ORDER_2026-09-09.md)에서 구현 뒤 남은 것과, 같은 흐름에 걸려 있던 미착수 주문 하나다.

## 1. 작업 항목

| # | 작업 | 난이도 | 담당 | 왜 그 담당인가 |
|---|---|---|---|---|
| W1 | **테스트 버전 라벨 자동화** — 빌드 시점에 커밋 SHA·날짜로 라벨을 만든다 ([VERSION_LABEL_AUTOMATION.md](VERSION_LABEL_AUTOMATION.md)) | 쉬움 | 코덱스 | 파일 셋(`next.config.mjs`·`page.tsx`·README), 함정 하나(렌더 시점 `new Date()` 금지)가 주문서에 다 적혀 있다 |
| W2 | **PDF 페이지도 짝 미리보기 썸네일** — 지금은 PDF에서 온 페이지가 회색 자리표시자다. 스캐너 PDF가 주 경로이고 역순 실수가 보이는 자리가 이 띠다 | 쉬움 | 코덱스 | `runBatchFromRawFiles` 한 함수 안에서 끝난다. 변환된 페이지 File이 이미 손에 있다 |
| W3 | **한 번에 전부 선택 → 시각순 정렬 → 양식 자동 분류 → 자동 짝짓기** (PHOTO_BATCH_ORDER §3 E). 두 묶음 문제(§2-2)를 없앤다 | 복잡 | 오퍼스 | 분류기가 사진에서 얼마나 맞는지 **먼저 재야** 한다. 서버 내용 분류는 사진에서 잡음이 많아 파일명을 믿도록 바꾼 이력이 있다(2026-08-02). 후보는 ORB 템플릿 두 개에 대한 정합 인라이어 비교 — 보정 워커가 이미 계산하는 값이다 |

보류(이번 계획 밖): 밝기 재촬영(PHOTO_BATCH_ORDER §5에서 닫힘), 실기기 촬영 가이드 검증(사람이 필요), 사진 경로 p16 취소 표시 추천(인식 축·계측 대상).

## 2. W1 착수 전 결정 (주문서 §5) — 메인 에이전트가 정했다

1. 라벨은 **`v{빌드일}.{SHA 7자}`**. 순번은 버린다(자동화하면 "그날 몇 번째"는 뜻이 없다). SHA는 배포와 커밋을 대조하는 데 쓴다.
2. README의 수동 규칙은 **폐기**하고 자동 라벨 설명으로 바꾼다. "이 줄이 그대로면 배포를 빠뜨렸다"는 신호는 SHA가 대신한다 — 화면 SHA가 `git log`의 HEAD와 다르면 배포가 안 된 것이다.
3. 로컬 dev는 `local-dev`로 표시해 배포본과 구별한다.

이 변경을 배포하는 커밋까지는 수동 규칙이 적용된다(라벨 v2026-09-09.1은 이미 올렸다).

## 3. W3의 두 단계 (계측 먼저, §2)

**단계 1 — 분류 정확도 측정 (코드 수정 없음).** 세트 1~3 원본 사진 114장(`C:/Users/night/Desktop/사진샘플/Set{1,2,3}/{선별검사,만족도}`)을
ORB 템플릿 둘(`src/lib/documentScanner/orbTemplate.{cagi,satisfaction}.json`)에 각각 정합해 인라이어 수·비율을 뽑고, 정답(폴더)과 대조한다.
판정: 114/114이고 1위·2위 인라이어 비의 최소값이 충분히 크면 단계 2로 간다. 아니면 틀린 장을 눈으로 보고 대안(사용자가 목록에서 앞/뒤 토글)을 기본으로 둔다.

**단계 2 — UI.** 일괄 모드에 "앞·뒷면 한 번에 선택" 입력을 추가한다. 시각순 정렬 → 장마다 분류 → 번호 목록에 앞/뒤 배지(토글 가능) →
"이 순서로 등록"에서 앞면 목록·뒷면 목록으로 나눠 기존 경로로 보낸다. 분류 불확실(비가 낮음)한 장은 배지를 비우고 사용자가 고르게 한다.
장수가 안 맞으면 기존 불일치 차단이 그대로 작동한다.

## 4. 실행 규칙

- 코덱스: `codex exec --skip-git-repo-check --approve-for-me --cd <worktree> "$(cat order.md)" < /dev/null > run.log 2>&1` (§1.1). 워크트리 `.claude/worktrees/codex-w1-*`·`codex-w2-*`,
  `node_modules`는 메인의 것을 정션으로 연결. 30분마다 `node scripts/check-delegates.cjs`(§1.3).
- 오퍼스: `Agent(model: 'opus', isolation: 'worktree')`, 단계 1 보고서를 받은 뒤 단계 2를 같은 에이전트에 이어서 맡긴다.
- 셋 다 **자체 합격 판정 금지**, 커밋 금지, `npm run build` 금지(dev 서버가 `.next`를 쓴다). 결과는 `git diff --stat`과 테스트 출력 원문으로 돌려받고, 메인이
  dev 브라우저에서 확인한 뒤 병합한다.

## 5. 결과

| # | 담당 | 왕복 | 결과 | 확인 | 커밋 |
|---|---|---|---|---|---|
| W1 | 코덱스 | 약 8분, 토큰 미표시 |  env 블록 +  + README 개정 + 테스트 3개. 배포 라벨  꼴, 로컬  | dev 재시작 후 화면에 , 콘솔 오류 0 |  |
| W2 | 코덱스 | 약 3분, 43.9k 토큰 | 한 줄(에 PDF 페이지 File의 object URL) | dev에서 세트 1 PDF 두 개: 카드 19 · blob 썸네일 38 · 첫 장 892×1261 로드 |  |
| W3-1 | 오퍼스 | 5분, 122.7k 토큰 | Set1 선별검사/cagi-p1.jpg  truth=cagi  cagi[264/398 r=0.663]  sat[33/87 r=0.379]  -> cagi
Set1 선별검사/cagi-p2.jpg  truth=cagi  cagi[208/270 r=0.770]  sat[18/73 r=0.247]  -> cagi
Set1 선별검사/cagi-p3.jpg  truth=cagi  cagi[225/284 r=0.792]  sat[19/69 r=0.275]  -> cagi
Set1 선별검사/cagi-p4.jpg  truth=cagi  cagi[231/297 r=0.778]  sat[23/67 r=0.343]  -> cagi
Set1 선별검사/cagi-p5.jpg  truth=cagi  cagi[294/354 r=0.831]  sat[31/78 r=0.397]  -> cagi
Set1 선별검사/cagi-p6.jpg  truth=cagi  cagi[194/260 r=0.746]  sat[15/64 r=0.234]  -> cagi
Set1 선별검사/cagi-p7.jpg  truth=cagi  cagi[231/293 r=0.788]  sat[28/79 r=0.354]  -> cagi
Set1 선별검사/cagi-p8.jpg  truth=cagi  cagi[351/432 r=0.813]  sat[34/88 r=0.386]  -> cagi
Set1 선별검사/cagi-p9.jpg  truth=cagi  cagi[315/412 r=0.765]  sat[31/92 r=0.337]  -> cagi
Set1 선별검사/cagi-p10.jpg  truth=cagi  cagi[223/273 r=0.817]  sat[25/70 r=0.357]  -> cagi
Set1 선별검사/cagi-p11.jpg  truth=cagi  cagi[242/362 r=0.668]  sat[28/76 r=0.368]  -> cagi
Set1 선별검사/cagi-p12.jpg  truth=cagi  cagi[239/374 r=0.639]  sat[30/89 r=0.337]  -> cagi
Set1 선별검사/cagi-p13.jpg  truth=cagi  cagi[283/343 r=0.825]  sat[21/72 r=0.292]  -> cagi
Set1 선별검사/cagi-p14.jpg  truth=cagi  cagi[212/278 r=0.763]  sat[24/66 r=0.364]  -> cagi
Set1 선별검사/cagi-p15.jpg  truth=cagi  cagi[168/270 r=0.622]  sat[22/75 r=0.293]  -> cagi
Set1 선별검사/cagi-p16.jpg  truth=cagi  cagi[167/267 r=0.625]  sat[16/59 r=0.271]  -> cagi
Set1 선별검사/cagi-p17.jpg  truth=cagi  cagi[271/338 r=0.802]  sat[19/71 r=0.268]  -> cagi
Set1 선별검사/cagi-p18.jpg  truth=cagi  cagi[237/325 r=0.729]  sat[27/72 r=0.375]  -> cagi
Set1 선별검사/cagi-p19.jpg  truth=cagi  cagi[242/319 r=0.759]  sat[21/73 r=0.288]  -> cagi
Set1 만족도/sat-p1.jpg  truth=satisfaction  cagi[23/94 r=0.245]  sat[252/386 r=0.653]  -> satisfaction
Set1 만족도/sat-p2.jpg  truth=satisfaction  cagi[15/74 r=0.203]  sat[174/294 r=0.592]  -> satisfaction
Set1 만족도/sat-p3.jpg  truth=satisfaction  cagi[21/81 r=0.259]  sat[207/360 r=0.575]  -> satisfaction
Set1 만족도/sat-p4.jpg  truth=satisfaction  cagi[21/94 r=0.223]  sat[229/357 r=0.641]  -> satisfaction
Set1 만족도/sat-p5.jpg  truth=satisfaction  cagi[32/100 r=0.320]  sat[282/406 r=0.695]  -> satisfaction
Set1 만족도/sat-p6.jpg  truth=satisfaction  cagi[17/67 r=0.254]  sat[150/262 r=0.573]  -> satisfaction
Set1 만족도/sat-p7.jpg  truth=satisfaction  cagi[27/100 r=0.270]  sat[246/395 r=0.623]  -> satisfaction
Set1 만족도/sat-p8.jpg  truth=satisfaction  cagi[19/77 r=0.247]  sat[180/307 r=0.586]  -> satisfaction
Set1 만족도/sat-p9.jpg  truth=satisfaction  cagi[19/82 r=0.232]  sat[214/333 r=0.643]  -> satisfaction
Set1 만족도/sat-p10.jpg  truth=satisfaction  cagi[27/91 r=0.297]  sat[191/326 r=0.586]  -> satisfaction
Set1 만족도/sat-p11.jpg  truth=satisfaction  cagi[29/97 r=0.299]  sat[199/346 r=0.575]  -> satisfaction
Set1 만족도/sat-p12.jpg  truth=satisfaction  cagi[16/74 r=0.216]  sat[198/335 r=0.591]  -> satisfaction
Set1 만족도/sat-p13.jpg  truth=satisfaction  cagi[26/102 r=0.255]  sat[258/345 r=0.748]  -> satisfaction
Set1 만족도/sat-p14.jpg  truth=satisfaction  cagi[21/82 r=0.256]  sat[179/287 r=0.624]  -> satisfaction
Set1 만족도/sat-p15.jpg  truth=satisfaction  cagi[26/93 r=0.280]  sat[290/377 r=0.769]  -> satisfaction
Set1 만족도/sat-p16.jpg  truth=satisfaction  cagi[34/96 r=0.354]  sat[278/389 r=0.715]  -> satisfaction
Set1 만족도/sat-p17.jpg  truth=satisfaction  cagi[16/81 r=0.198]  sat[237/359 r=0.660]  -> satisfaction
Set1 만족도/sat-p18.jpg  truth=satisfaction  cagi[25/82 r=0.305]  sat[227/346 r=0.656]  -> satisfaction
Set1 만족도/sat-p19.jpg  truth=satisfaction  cagi[19/75 r=0.253]  sat[144/269 r=0.535]  -> satisfaction
Set2 선별검사/cagi-p1.jpg  truth=cagi  cagi[299/362 r=0.826]  sat[34/98 r=0.347]  -> cagi
Set2 선별검사/cagi-p2.jpg  truth=cagi  cagi[248/332 r=0.747]  sat[45/112 r=0.402]  -> cagi
Set2 선별검사/cagi-p3.jpg  truth=cagi  cagi[283/376 r=0.753]  sat[36/88 r=0.409]  -> cagi
Set2 선별검사/cagi-p4.jpg  truth=cagi  cagi[141/191 r=0.738]  sat[27/69 r=0.391]  -> cagi
Set2 선별검사/cagi-p5.jpg  truth=cagi  cagi[187/243 r=0.769]  sat[30/83 r=0.361]  -> cagi
Set2 선별검사/cagi-p6.jpg  truth=cagi  cagi[180/273 r=0.659]  sat[22/73 r=0.301]  -> cagi
Set2 선별검사/cagi-p7.jpg  truth=cagi  cagi[311/374 r=0.832]  sat[40/98 r=0.408]  -> cagi
Set2 선별검사/cagi-p8.jpg  truth=cagi  cagi[334/405 r=0.825]  sat[40/103 r=0.388]  -> cagi
Set2 선별검사/cagi-p9.jpg  truth=cagi  cagi[199/261 r=0.762]  sat[27/80 r=0.338]  -> cagi
Set2 선별검사/cagi-p10.jpg  truth=cagi  cagi[263/400 r=0.657]  sat[38/109 r=0.349]  -> cagi
Set2 선별검사/cagi-p11.jpg  truth=cagi  cagi[221/334 r=0.662]  sat[32/87 r=0.368]  -> cagi
Set2 선별검사/cagi-p12.jpg  truth=cagi  cagi[235/335 r=0.702]  sat[34/79 r=0.430]  -> cagi
Set2 선별검사/cagi-p13.jpg  truth=cagi  cagi[219/275 r=0.796]  sat[32/84 r=0.381]  -> cagi
Set2 선별검사/cagi-p14.jpg  truth=cagi  cagi[173/279 r=0.620]  sat[29/83 r=0.349]  -> cagi
Set2 선별검사/cagi-p15.jpg  truth=cagi  cagi[317/434 r=0.730]  sat[36/96 r=0.375]  -> cagi
Set2 선별검사/cagi-p16.jpg  truth=cagi  cagi[229/361 r=0.634]  sat[37/102 r=0.363]  -> cagi
Set2 선별검사/cagi-p17.jpg  truth=cagi  cagi[130/213 r=0.610]  sat[14/46 r=0.304]  -> cagi
Set2 선별검사/cagi-p18.jpg  truth=cagi  cagi[192/269 r=0.714]  sat[46/93 r=0.495]  -> cagi
Set2 선별검사/cagi-p19.jpg  truth=cagi  cagi[144/236 r=0.610]  sat[35/91 r=0.385]  -> cagi
Set2 만족도/sat-p1.jpg  truth=satisfaction  cagi[31/93 r=0.333]  sat[214/359 r=0.596]  -> satisfaction
Set2 만족도/sat-p2.jpg  truth=satisfaction  cagi[41/104 r=0.394]  sat[235/357 r=0.658]  -> satisfaction
Set2 만족도/sat-p3.jpg  truth=satisfaction  cagi[19/59 r=0.322]  sat[99/194 r=0.510]  -> satisfaction
Set2 만족도/sat-p4.jpg  truth=satisfaction  cagi[23/63 r=0.365]  sat[100/187 r=0.535]  -> satisfaction
Set2 만족도/sat-p5.jpg  truth=satisfaction  cagi[40/98 r=0.408]  sat[331/437 r=0.757]  -> satisfaction
Set2 만족도/sat-p6.jpg  truth=satisfaction  cagi[33/91 r=0.363]  sat[248/360 r=0.689]  -> satisfaction
Set2 만족도/sat-p7.jpg  truth=satisfaction  cagi[41/102 r=0.402]  sat[259/361 r=0.718]  -> satisfaction
Set2 만족도/sat-p8.jpg  truth=satisfaction  cagi[26/71 r=0.366]  sat[117/228 r=0.513]  -> satisfaction
Set2 만족도/sat-p9.jpg  truth=satisfaction  cagi[15/52 r=0.288]  sat[95/156 r=0.609]  -> satisfaction
Set2 만족도/sat-p10.jpg  truth=satisfaction  cagi[49/108 r=0.454]  sat[249/330 r=0.754]  -> satisfaction
Set2 만족도/sat-p11.jpg  truth=satisfaction  cagi[42/112 r=0.375]  sat[324/415 r=0.781]  -> satisfaction
Set2 만족도/sat-p12.jpg  truth=satisfaction  cagi[36/92 r=0.391]  sat[240/389 r=0.617]  -> satisfaction
Set2 만족도/sat-p13.jpg  truth=satisfaction  cagi[43/114 r=0.377]  sat[299/405 r=0.738]  -> satisfaction
Set2 만족도/sat-p14.jpg  truth=satisfaction  cagi[47/110 r=0.427]  sat[274/444 r=0.617]  -> satisfaction
Set2 만족도/sat-p15.jpg  truth=satisfaction  cagi[26/91 r=0.286]  sat[224/364 r=0.615]  -> satisfaction
Set2 만족도/sat-p16.jpg  truth=satisfaction  cagi[23/81 r=0.284]  sat[147/269 r=0.546]  -> satisfaction
Set2 만족도/sat-p17.jpg  truth=satisfaction  cagi[37/105 r=0.352]  sat[234/321 r=0.729]  -> satisfaction
Set2 만족도/sat-p18.jpg  truth=satisfaction  cagi[32/74 r=0.432]  sat[205/284 r=0.722]  -> satisfaction
Set2 만족도/sat-p19.jpg  truth=satisfaction  cagi[36/89 r=0.405]  sat[157/261 r=0.602]  -> satisfaction
Set3 선별검사/cagi-p1.jpg  truth=cagi  cagi[144/202 r=0.713]  sat[13/46 r=0.283]  -> cagi
Set3 선별검사/cagi-p2.jpg  truth=cagi  cagi[129/218 r=0.592]  sat[10/46 r=0.217]  -> cagi
Set3 선별검사/cagi-p3.jpg  truth=cagi  cagi[239/292 r=0.819]  sat[22/73 r=0.301]  -> cagi
Set3 선별검사/cagi-p4.jpg  truth=cagi  cagi[264/323 r=0.817]  sat[29/84 r=0.345]  -> cagi
Set3 선별검사/cagi-p5.jpg  truth=cagi  cagi[228/302 r=0.755]  sat[15/57 r=0.263]  -> cagi
Set3 선별검사/cagi-p6.jpg  truth=cagi  cagi[200/286 r=0.699]  sat[22/53 r=0.415]  -> cagi
Set3 선별검사/cagi-p7.jpg  truth=cagi  cagi[325/439 r=0.740]  sat[40/105 r=0.381]  -> cagi
Set3 선별검사/cagi-p8.jpg  truth=cagi  cagi[231/330 r=0.700]  sat[30/70 r=0.429]  -> cagi
Set3 선별검사/cagi-p9.jpg  truth=cagi  cagi[115/185 r=0.622]  sat[5/41 r=0.122]  -> cagi
Set3 선별검사/cagi-p10.jpg  truth=cagi  cagi[153/220 r=0.696]  sat[10/53 r=0.189]  -> cagi
Set3 선별검사/cagi-p11.jpg  truth=cagi  cagi[324/403 r=0.804]  sat[36/97 r=0.371]  -> cagi
Set3 선별검사/cagi-p12.jpg  truth=cagi  cagi[158/255 r=0.620]  sat[9/30 r=0.300]  -> cagi
Set3 선별검사/cagi-p13.jpg  truth=cagi  cagi[237/330 r=0.718]  sat[34/87 r=0.391]  -> cagi
Set3 선별검사/cagi-p14.jpg  truth=cagi  cagi[205/287 r=0.714]  sat[19/68 r=0.279]  -> cagi
Set3 선별검사/cagi-p15.jpg  truth=cagi  cagi[194/265 r=0.732]  sat[21/65 r=0.323]  -> cagi
Set3 선별검사/cagi-p16.jpg  truth=cagi  cagi[193/316 r=0.611]  sat[34/80 r=0.425]  -> cagi
Set3 선별검사/cagi-p17.jpg  truth=cagi  cagi[364/431 r=0.845]  sat[28/87 r=0.322]  -> cagi
Set3 선별검사/cagi-p18.jpg  truth=cagi  cagi[224/339 r=0.661]  sat[18/62 r=0.290]  -> cagi
Set3 선별검사/cagi-p19.jpg  truth=cagi  cagi[300/396 r=0.758]  sat[26/71 r=0.366]  -> cagi
Set3 만족도/sat-p1.jpg  truth=satisfaction  cagi[27/87 r=0.310]  sat[219/337 r=0.650]  -> satisfaction
Set3 만족도/sat-p2.jpg  truth=satisfaction  cagi[24/79 r=0.304]  sat[256/451 r=0.568]  -> satisfaction
Set3 만족도/sat-p3.jpg  truth=satisfaction  cagi[21/86 r=0.244]  sat[325/444 r=0.732]  -> satisfaction
Set3 만족도/sat-p4.jpg  truth=satisfaction  cagi[22/81 r=0.272]  sat[242/348 r=0.695]  -> satisfaction
Set3 만족도/sat-p5.jpg  truth=satisfaction  cagi[21/77 r=0.273]  sat[232/351 r=0.661]  -> satisfaction
Set3 만족도/sat-p6.jpg  truth=satisfaction  cagi[23/87 r=0.264]  sat[287/460 r=0.624]  -> satisfaction
Set3 만족도/sat-p7.jpg  truth=satisfaction  cagi[22/81 r=0.272]  sat[237/376 r=0.630]  -> satisfaction
Set3 만족도/sat-p8.jpg  truth=satisfaction  cagi[21/67 r=0.313]  sat[210/333 r=0.631]  -> satisfaction
Set3 만족도/sat-p9.jpg  truth=satisfaction  cagi[22/75 r=0.293]  sat[300/468 r=0.641]  -> satisfaction
Set3 만족도/sat-p10.jpg  truth=satisfaction  cagi[19/94 r=0.202]  sat[316/426 r=0.742]  -> satisfaction
Set3 만족도/sat-p11.jpg  truth=satisfaction  cagi[20/88 r=0.227]  sat[208/355 r=0.586]  -> satisfaction
Set3 만족도/sat-p12.jpg  truth=satisfaction  cagi[20/76 r=0.263]  sat[217/311 r=0.698]  -> satisfaction
Set3 만족도/sat-p13.jpg  truth=satisfaction  cagi[16/68 r=0.235]  sat[128/213 r=0.601]  -> satisfaction
Set3 만족도/sat-p14.jpg  truth=satisfaction  cagi[8/66 r=0.121]  sat[123/225 r=0.547]  -> satisfaction
Set3 만족도/sat-p15.jpg  truth=satisfaction  cagi[25/93 r=0.269]  sat[222/372 r=0.597]  -> satisfaction
Set3 만족도/sat-p16.jpg  truth=satisfaction  cagi[16/82 r=0.195]  sat[234/362 r=0.646]  -> satisfaction
Set3 만족도/sat-p17.jpg  truth=satisfaction  cagi[25/97 r=0.258]  sat[230/409 r=0.562]  -> satisfaction
Set3 만족도/sat-p18.jpg  truth=satisfaction  cagi[13/71 r=0.183]  sat[183/318 r=0.576]  -> satisfaction
Set3 만족도/sat-p19.jpg  truth=satisfaction  cagi[24/92 r=0.261]  sat[166/239 r=0.695]  -> satisfaction

==============================================================================
SUMMARY  (primary score = ORB inlier count; predicted = template with more inliers)
==============================================================================

Confusion (rows = truth, cols = predicted)
set      truth            ->cagi    ->sat   ->uncl     n
Set1     cagi                 19        0        0    19
Set1     satisfaction          0       19        0    19
Set2     cagi                 19        0        0    19
Set2     satisfaction          0       19        0    19
Set3     cagi                 19        0        0    19
Set3     satisfaction          0       19        0    19
OVERALL  cagi                 57        0        0    57
OVERALL  satisfaction          0       57        0    57

Accuracy
set         correct   wrong   uncl     n
Set1             38       0      0    38
Set2             38       0      0    38
Set3             38       0      0    38
OVERALL         114       0      0   114

Margin = best/second-best inlier count (Inf when second-best is 0)
group                      n       min       p05    median
correct (all sets)       114      4.11      5.08      8.83
incorrect                  0       n/a       n/a       n/a
correct Set1              38      6.86      7.07      9.67
correct Set2              38      4.11      4.17      6.54
correct Set3              38      5.68      6.92     10.86

Inlier-ratio margin (recorded alternative, not the decision axis)
group                      n       min       p05    median
correct (all sets)       114      1.40      1.49      2.15
incorrect                  0       n/a       n/a       n/a
correct Set1              38      1.75      1.81      2.28
correct Set2              38      1.40      1.44      1.86
correct Set3              38      1.44      1.63      2.40

Raw score spread (winning vs losing template, all classified photos)
quantity                             min       p05    median
best inliers                      95.000   123.000   228.500
second-best inliers                5.000    13.000    25.000
winner inlier ratio                0.510     0.547     0.679
loser inlier ratio                 0.121     0.198     0.312
winner selfResidualPx              1.055     1.181     1.361

Misclassified or unclassified: 0

Timing
  median ms per alignToTemplate call (one photo, one template): 195
  median ms decode+detection-frame prep per photo:              288
  median ms per photo, both templates (prep + 2 aligns):        678
  photos: 114   align calls: 228

JSONL: C:Users
ightDesktop바이브코딩도박예방.tmporb-form-classify.jsonl. 114/114, 인라이어 여유 min 4.11 · p05 5.08 · 중앙값 8.83, 1위 인라이어 min 95, 장당 684ms(두 템플릿) | 계측기이므로 병합만 |  |
| W3-2 | 오퍼스 | (진행 중) | | | |

W3-1의 결정: 여유 2 미만 또는 1위 인라이어 50 미만이면 미결정(사용자가 앞/뒤 선택). 측정된 최솟값(4.11·95)의 절반 아래에 두는 안전 바닥이지 맞춘 값이 아니다.
