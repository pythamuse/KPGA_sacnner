# 인식 정확도 개선: 동적 표 행(row) 검출 도입

> 이 문서는 기존 `Docs/26_RECOGNITION_ARCHITECTURE_REDESIGN_OPTIONS.md`,
> `Docs/33_ACCURATE_FIELD_RECOGNITION_METHOD_PROPOSAL.md`,
> `Docs/34_TABLE_ROW_DETECTION_WORK_ORDER.md`,
> `Docs/35_TABLE_ROW_DETECTION_REVIEW_AND_VALIDATION.md`를 통합한 문서입니다.

## 배경

CAGI/만족도 인식은 `roiTemplates.ts`에 고정된 정규화 좌표(0~1 비율)로 각 문항·보기 위치를 하드코딩해두고, `markDensity.ts`의 `detectContentBounds`/`detectFrameBounds`로 추정한 종이 경계 안에서 그 좌표의 어두운 픽셀 비율만으로 체크 여부를 판정한다. 이 방식은 (1) 종이 경계 추정이 틀리면 좌표 전체가 밀려 엉뚱한 곳을 찍고, (2) 경계가 맞아도 인쇄된 원문자 위에 옅게 겹쳐 그린 체크 표시처럼 신호가 약한 필기 스타일에서는 후보 간 점수 차이가 거의 없어진다는 두 실패 지점이 있다.

## 작업 내용

### 1. 1차 탐색 (2026-08-03 초, 실제 오정렬 증거 확보 전)

사용자 제안: "OCR 등 비전인식 모델을 활용해 항목별 아웃라인을 파악하고 작은 이미지로 쪼개 계층적으로 인식하는 방식"을 검토해달라는 요청에 따라 검토한 방식:

- **A. 고전 CV 기반 동적 구조 검출(자체 처리)**: OpenCV(이미 원근보정에 도입됨, [[MOBILE_CAPTURE_PERSPECTIVE_CORRECTION]])의 선/윤곽선 검출로 실제 표 격자선을 찾아 행·열 경계 계산 후 셀 크롭. 장점: 외부 API 비용 없음, **학생 개인정보(도박문제 선별검사 응답 포함)가 외부로 전혀 나가지 않음** — PRD 10장의 개인정보 요구사항과 정합. 단점: 표 격자선 안정 검출 자체가 고전 CV 난제, 반복적인 실데이터 검증 필요.
- **B. 비전 언어 모델(Claude/GPT 비전 API) 활용**: 필기 스타일 편차·약한 신호·기울어짐에 강건할 가능성 높음. **단점(정책 판단 필요)**: 만14세 미만 포함 가능한 아동·청소년의 도박문제 선별검사 응답·성별·나이·학교 정보를 외부 상업 API로 전송하는 것은 PRD가 전제하는 "자체 처리 후 삭제" 모델을 벗어나는 새로운 데이터 흐름. 법적 근거·기관 정책은 사용자/기관이 결정해야 할 영역.
- **C. A+B 하이브리드**: 저신뢰 항목만 B로 보조 — "일부만 외부로 보낸다"도 정책적으로는 "외부로 보낸다"와 동일한 결정이 필요해 B의 정책 이슈가 그대로 남음.

권장: **A(자체 처리)** — 개인정보 이슈 없이 프로젝트의 기존 자체-완결적 설계 원칙과 일치. 사용자가 **"자체 처리(권장)"**를 선택. 다만 이 시점에는 정확한 실패 지점(좌표 오정렬 vs 신호 약함)이 픽셀 단위로 확정되지 않아, 실제 ROI 디버그 스크린샷 확보 후 구체적 설계를 이어가기로 함.

### 2. 실제 근본 원인 확인 및 방법 재검토 (2026-08-03, 실 ROI 스크린샷 확보 후)

[[MOBILE_CAPTURE_PERSPECTIVE_CORRECTION]] 3절에서 확인된 대로, 문제는 "신호 약함"이 아니라 **페이지 경계 추정 실패로 인한 좌표 전체 밀림**임이 확인됨. 이 root cause를 반영해 방법을 재검토:

클라이언트 측 OpenCV/Worker 접근(원근 보정)은 이번 세션에서만 두 차례 심각한 사고([[MOBILE_CAPTURE_PERSPECTIVE_CORRECTION]]의 프리징 사고 포함)를 낸 만큼, 이미 신뢰할 수 있는 `sharp` 기반 서버 파이프라인 안에서 처리할 수 있는 대안을 우선 검토: **서버 측 동적 표 행(row) 구조 검출**. 실제 이미지에서 가로 분리선(row separator)을 감지해 `roiTemplates.ts`가 이미 갖고 있는 문항 간 상대 간격 패턴과 매칭하고, 확신 있는 매칭이 나오면 그 문항 행의 Y-크롭 범위를 감지된 픽셀 위치로 덮어쓴다. 매칭이 불확실하면 항상 기존 동작으로 안전하게 폴백.

이 방식을 채택한 이유: 순수 Node.js/`sharp` 픽셀 버퍼 기반 로직이라 브라우저 API·OpenCV·Worker에 전혀 의존하지 않아, 이번 세션에서 반복적으로 문제를 일으킨 클라이언트 WASM/Worker 복잡도 계열과 완전히 분리된다.

### 3. 작업지시서(`Docs/34_TABLE_ROW_DETECTION_WORK_ORDER.md`, 이관 전 작성) 및 Codex 구현

핵심 요구사항(코덱스에 위임 시 명시):

1. CAGI 9행의 "예상 상대 간격" 배열은 `roiTemplates.ts`의 기존 `cagiQuestionYs`/`cagiLateQuestionYs`(그리고 만족도의 `satisfactionBinaryYs`/`satisfactionScaleYs`)에서 **직접 계산**(첫 간격=1 기준 비율)하고, 별도로 하드코딩하지 않는다(데이터 drift 방지). `satisfaction.q01`은 단일 행이라 매칭 대상에서 제외.
2. `calculateDarkPixelDensity`의 신규 `yOverride`는 **Y축에만** 영향, X축은 기존 `contentBounds` 기반 계산에서 변경 없음(Docs/27의 실증거가 "잘못된 행 선택" 문제였지 "행 내 잘못된 열 위치" 문제가 아니었으므로).
3. 매칭이 불확실하면 항상 빈 객체 `{}`를 반환하고 기존 동작 그대로 사용 — 이번 세션 두 번의 심각한 사고(프리징 등)를 낸 "방어적이지 않은 신기능"의 재발을 막기 위한 하드 요구사항.
4. 순수 Node.js/TypeScript, 브라우저 API·OpenCV·Worker 사용 금지.

구현 결과물: `src/lib/recognition/tableRowDetection.ts`(신규 — `detectHorizontalLines`, `matchRowPattern`, `buildCagiRowOverrides`, `buildSatisfactionRowOverrides`), `markDensity.ts`(`yOverride` 파라미터 추가), `detectCheckmarks.ts`(오버라이드 적용 배선), `roiTemplates.ts`(Y좌표 배열 export), `tests/table-row-detection.test.ts`(신규 6개 테스트).

### 4. 내 자체 코드 리뷰 및 설계 리스크 발견

전반적으로 작업지시서 요구사항을 충실히 따랐음을 확인. 다만 리뷰 중 리스크 발견: `buildCagiRowOverrides`/`buildSatisfactionGroupOverrides`가 감지한 가로선을 `roiTemplates.ts`의 문항 **행 중심(row-center)** Y좌표에서 유도한 간격 패턴과 매칭하는데, 실제 촬영된 설문지에서 안정적으로 감지 가능한 가로선은 대개 표의 **행 경계(구분선)**이지 행 중심이 아닐 가능성이 높다는 것.

### 5. 실증 검증 (synthetic 이미지 기반)

실제 촬영 이미지를 파일로 확보할 수 없어(채팅 스크린샷만 존재), synthetic 이미지로 두 가지를 검증:

1. **완전 경계선 케이스**: 9개 문항의 행 경계(연속 두 문항 중심의 정확한 중점)에 가로선을 그리고 각 문항 중심에 마킹을 그린 이미지로 `buildCagiRowOverrides` 실행.
2. **민감도 스캔**: 가로선을 행 중심에서 다음 행 쪽으로 0~50%까지 5% 간격으로 이동시키며 `matchRowPattern` 매칭 성공 임계값 측정.

**결과**:
- 완전 경계선 케이스: `buildCagiRowOverrides`가 빈 객체 `{}`를 반환(매칭 실패 → 오버라이드 없음 → 기존 동작 유지). 오답 오버라이드가 적용되는 일은 없었다 — 안전 요구사항이 실제로 지켜짐을 확인.
- 민감도 스캔: offset 0~20%(행 간격 대비)까지는 매칭 성공, 25% 이상부터는 매칭 실패(폴백)로 전환. 즉 감지된 선이 템플릿 행-중심 위치에서 최대 약 20% 이내로 근접할 때만 오버라이드가 적용되고, 그 이상(완전한 행 경계선 포함) 벗어나면 항상 안전하게 아무 것도 하지 않는다.

**조치**: 방어적 완화로 `buildOverridesFromRowCenters`의 크롭 여백 배수를 `interval * 0.3` → `interval * 0.45`로 확대(매칭 성공 시 중심에서 다소 벗어난 실제 마크 위치까지 크롭 범위 포함). `tests/table-row-detection.test.ts`의 하드코딩 기대값 3개(`cagi.q01`/`q08`/`q09`) 갱신.

`matchRowPattern`의 `toleranceRatio`(0.35) 자체는 의도적으로 건드리지 않았다 — 완화하면 20~50% 오프셋에서도 매칭이 "성공"하게 만들 수 있지만, 실제로 심각하게 잘못 정렬된 사진에서도 거짓 매칭을 유발할 위험이 있어 "애매하면 무조건 아무 것도 하지 않는다" 원칙에 반한다.

## 테스트 결과

- `npm test`: 11개 파일, 43개 테스트 전부 통과(신규 `table-row-detection.test.ts` 6개 포함).
- `npm run build`: 정상 컴파일/타입체크/정적 생성 완료, 에러 없음.
- 배포: `git push origin main` → Vercel Production 배포 성공(commit `567bf54`, GitHub 커밋 상태 체크 `success` 확인), 프로덕션 URL 200 응답 확인.

## 다음 작업을 위한 피드백

- **안전성은 실증됨**: 매칭이 불확실한 경우 항상 폴백하며, 잘못된 오버라이드가 적용되는 사례를 재현하지 못했다.
- **효과(실제 정확도 개선 여부)는 미검증**: 실제 설문지 사진에서 안정적으로 감지되는 가로선이 문항 행 중심에서 20% 이내에 위치하는지는 실제 이미지 없이는 확인할 수 없다. 만약 실제 양식의 구분선이 행 경계에 가깝다면, 이 기능은 (안전하게) 거의 활성화되지 않고 기존의 미해결 오정렬 문제가 여전히 남을 수 있다.
- **다음 단계**: 실제 사용자의 촬영/업로드 이미지로 재검증 필요. 가능하다면 오정렬이 확인됐던 실제 ROI 사례(2절 근거 이미지)로 `buildCagiRowOverrides`가 오버라이드를 실제로 생성하는지, 생성한다면 올바른 위치인지 직접 확인하는 것이 가장 확실한 검증 방법.
- B안(비전 API)의 정책 이슈는 여전히 미결 상태로 남아있다 — A안(이번 작업)으로 충분한 개선이 확인되지 않으면 다시 검토 대상이 될 수 있다.
