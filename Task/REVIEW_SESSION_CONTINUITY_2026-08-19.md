# 검수 작업 연속성 — 취소·새로고침에도 돌아오기 (2026-08-19~)

검수 도중 `검수 취소`를 잘못 누르거나 새로고침되면 그때까지의 작업이 전부 사라진다. 19명 배치는 업로드·인식에만 수 분이 걸리고 수기 수정값은 재현할 수 없으므로, **원래 작업으로 돌아올 수 있어야 한다.**

상위 문서: [Docs/00_PRD.md §10-2](../Docs/00_PRD.md)

---

## 1. 현재 구조와 소실 지점

앱 상태는 전부 `src/app/page.tsx`의 React state에 있고 **어디에도 보존되지 않는다.**

```ts
const [jobId, setJobId] = useState<string | null>(null);
const [students, setStudents] = useState<StudentData[]>([]);   // 저장 완료 학생
const [drafts, setDrafts] = useState<RecognitionDraft[] | null>(null);  // 검수 대기 학생
const [currentDraftIndex, setCurrentDraftIndex] = useState<number>(0);
```

**소실 지점 두 개.**

1. **`resetDraft()`** (`검수 취소` 버튼) — `setDrafts(null)`로 남은 학생 전체를 버린다. `students`는 남지만 아직 검수하지 않은 인원이 통째로 사라진다. 되돌릴 방법이 없고 확인 절차도 없다.
2. **새로고침·탭 종료·네트워크 끊김** — 모든 state가 초기화된다. `students`까지 사라져 저장 완료분도 잃는다.

## 2. 저장 범위 결정 — 실측

학생 1명을 실제로 인식해 직렬화 크기를 쟀다.

| 대상 | 용량 |
|---|---:|
| draft 전체(썸네일 2장 + crop 23개 × 2벌) | **1,602KB** |
| └ 썸네일 2장 | 271KB |
| └ crop 깨끗 23개 | 370KB |
| └ crop 오버레이 23개 | 930KB |
| **값 + 신뢰도 + 후보점수 + 진단** | **3KB** |

19명 환산: 전체 **30MB** vs 값만 **61KB**. localStorage 실효 한도(약 5MB)를 기준으로 **이미지는 저장 대상에서 제외**한다. 이는 PRD §10 "이미지 임시 저장 최소화"와도 일치한다.

## 3. 이미지를 다시 받아올 수 있는가 — 확인 결과

`/api/uploads/crop`은 `hasJobSession(jobId)`을 요구하고 `getJobDir()`의 **인스턴스 로컬 파일시스템**을 읽는다. 새로고침 뒤 다른 서버리스 인스턴스로 라우팅되면 존재하지 않는다. 반면 업로드 원본은 `uploadStore.ts`가 **Vercel Blob**에 넣으므로 살아 있다.

즉 **crop 재생성 경로를 Blob 기반으로 바꾸면 새로고침 후 이미지 복구도 가능하다.** 다만 이번 범위에 넣지 않는다 — 값 복구가 핵심이고, crop 경로 변경은 별도 작업이다([[STATELESS_ARCHITECTURE_MIGRATION]] 계열).

## 4. 설계 — 두 층으로 나눈다

두 실패 방식은 성격이 다르므로 하나의 메커니즘으로 묶지 않는다.

| 실패 | 복구 층 | 보존 범위 | 근거 |
|---|---|---|---|
| `검수 취소` 오조작 | **메모리 스냅샷**(`useRef`) | 이미지 포함 **완전 복구** | 페이지가 살아 있으므로 이미지가 메모리에 그대로 있다 |
| 새로고침·끊김·탭 종료 | **localStorage** | 값·신뢰도·진행 위치 | 이미지는 용량·개인정보상 저장하지 않는다 |

### 4.1 localStorage 스냅샷 형식

```ts
{
  version: 1,
  savedAt: number,
  jobId: string,
  uploadMode: 'sequential' | 'batch',
  students: StudentData[],        // 저장 완료 (학생당 약 0.3KB)
  drafts: SlimDraft[],            // 이미지 제거한 검수 대기분
  currentDraftIndex: number,
}
```

`SlimDraft`는 `draft.source`에서 `cagiImageDataUrl`·`satisfactionImageDataUrl`·`cropDataUrls`·`cropDebugDataUrls`를 제거한 것이다. 나머지(`recognitionCropSource`, `recognitionCropDiagnostic`, `recognitionDecisionTrace`, `recognitionRegistration`)는 크기가 작고 검수 판단에 필요하므로 유지한다.

### 4.2 저장·복구 규칙

- **저장 시점**: `jobId`·`students`·`drafts`·`currentDraftIndex`가 바뀔 때마다 덮어쓴다.
- **`검수 취소`는 스냅샷을 지우지 않는다.** 지우면 오조작 복구가 불가능해진다.
- **`새로 작성`만 스냅샷을 삭제한다**(PRD C4).
- **자동 복구하지 않는다.** 시작 화면에 안내를 띄우고 사용자가 `이어서 하기`를 눌러야 복원한다(PRD C3).
- localStorage 접근은 전부 `try/catch`로 감싼다. 사파리 프라이빗 모드 등에서 예외가 나도 앱이 죽으면 안 된다.

### 4.3 복구 후 이미지 부재 처리

`RecognitionReview`의 `renderFieldCropPreview`는 URL이 없으면 `null`을 반환하므로 자연히 축소된다. 복구된 검수 화면에는 **"이어서 하기로 복원한 값입니다. 원본 이미지는 복원되지 않으므로 원본 대조가 필요하면 해당 학생을 다시 올려주세요."** 안내를 표시한다.

---

## 5. 구현 계획

| 단계 | 내용 | 파일 |
|---|---|---|
| 1 | 스냅샷 직렬화 유틸(`stripDraftImages`, 저장/로드/삭제) | `src/lib/session/reviewSnapshot.ts` (신규) |
| 2 | `page.tsx`에 저장 effect, 메모리 스냅샷 ref, 복구 상태 추가 | `src/app/page.tsx` |
| 3 | `검수 취소` → 되돌리기 배너 | `src/app/page.tsx` |
| 4 | 시작 화면 `이어서 하기` 배너 | `src/app/page.tsx` |
| 5 | 복구본 안내 문구 | `src/components/RecognitionReview.tsx` |
| 6 | 단위 테스트 — 이미지 제거 확인, 용량, 라운드트립 | `tests/review-snapshot.test.ts` (신규) |

### 합격 기준

1. 검수 중 `검수 취소` → `되돌리기`로 취소 직전 상태(현재 학생 위치 포함) 복귀
2. 검수 중 새로고침 → `이어서 하기`로 `students`와 값 복원
3. `새로 작성` 후 이전 복구 지점이 남지 않음
4. 스냅샷 JSON에 `data:image` 문자열이 하나도 없음 (테스트가 강제)
5. `npm test`·`npm run build` 통과

---

## 6. 사이클 기록

### 사이클 1 — 구현 및 브라우저 실측 (2026-08-19, 클로드 코드)

**변경 파일**

- `src/lib/session/reviewSnapshot.ts` (신규) — `stripDraftImages`, `buildReviewSnapshot`, 저장/로드/삭제, `describeSnapshot`. localStorage 접근은 전부 `try/catch`.
- `src/app/page.tsx` — 저장 effect, `discardedDraftsRef` 메모리 스냅샷, `resetDraft(captureUndo)`, `undoDiscard`, `restorePreviousSession`, `dismissRestorable`, 배너 2종.
- `tests/review-snapshot.test.ts` (신규) — 5개.

`handleStartNewJob`은 `resetDraft(false)`로 호출해 새 작업 시작이 되돌리기 지점을 만들지 않도록 했다.

**브라우저 실측 (로컬 dev, 실제 클릭)**

PDF 배치 없이도 검증 가능하도록 스냅샷을 localStorage에 직접 넣고 확인했다.

| # | 시나리오 | 결과 |
|---|---|---|
| 1 | 새로고침 후 복구 배너 | **표시됨** — `저장 완료 2명 · 검수 대기 3명 중 2번째` |
| 2 | `이어서 하기` | **복원됨** — 성별 `여`, 학교유형 `중학교`, 학년 `2학년`, CAGI01 `0`, 연령 `14`, 저장 완료 2명, 위치 `2 / 3번째`, 복원 안내 문구 표시 |
| 3 | `검수 취소` → `되돌리기` | **완전 복귀** — 검수 화면, 값, **위치 `2 / 3번째`까지 그대로**. 취소 배너 사라짐 |
| 4 | `삭제하고 새로 시작` | **삭제됨** — `localStorage` `null`, 배너 사라지고 시작 화면 |

**자동 테스트**: `npm test` **106 passed, 1 skipped**(신규 5개 포함), `npm run build` 통과, `npx tsc --noEmit` 신규 오류 없음.

**합격 기준 대조**

| # | 기준 | 결과 |
|---|---|---|
| 1 | 취소 후 되돌리기로 직전 상태 복귀 | 통과 (시나리오 3) |
| 2 | 새로고침 후 이어서 하기로 값 복원 | 통과 (시나리오 1·2) |
| 3 | 새로 작성 후 복구 지점 없음 | 통과 (시나리오 4 + `handleStartNewJob`의 `clearReviewSnapshot`) |
| 4 | 스냅샷에 `data:image` 없음 | 통과 (테스트가 강제) |
| 5 | `npm test`·`npm run build` | 통과 |

**다음 작업을 위한 피드백**

- 새로고침 복구본에는 이미지가 없다. `/api/uploads/crop`이 인스턴스 로컬 파일시스템을 읽기 때문인데, 업로드 원본은 Blob에 있으므로 **crop 경로를 Blob 기반으로 바꾸면 이미지까지 복구할 수 있다.** 별도 작업으로 남긴다.
- 스냅샷은 브라우저 1대에 묶인다. 기기를 바꾸면 복구되지 않는다 — 현재 무상태 설계에서는 의도된 한계다.
- 저장 시점이 상태 변경마다이므로 19명 배치에서 쓰기가 잦다. 실측 1KB 수준이라 문제 없으나, 값이 커지면 디바운스를 검토한다.
