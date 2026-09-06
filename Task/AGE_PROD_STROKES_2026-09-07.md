# 배포본에서만 나이가 전부 비었다 — 원인과 수정 (2026-09-07)

사용자 보고: 새 회색조 샘플 9명을 배포본에 올렸더니 **나이 9칸 전부 빈칸**. 같은 샘플이 노드에서는 4/9였다.

## 사이클 1 — 어디서 갈리는가

| 경로 | 나이 |
|---|---|
| 노드 하네스 | 4/9 |
| 로컬 dev 브라우저 | **4/9** |
| 배포본 | **0/9** |

먼저 의심한 **렌더 사다리 가설은 죽었다**: 브라우저는 JPEG이 `MAX_UPLOAD_IMAGE_BYTES`(3.8MB)를 넘으면 배율을
한 단 내리는데, 회색조 페이지는 264KB, 1비트는 292KB로 둘 다 근처도 아니다. 같은 배율(1.5)을 쓴다.
래스터도 회색조도 아니고 **배포 환경 고유**로 좁혀졌다.

## 사이클 2 — 배포본이 스스로 말한 진단

원본에서 3쪽을 떼어 배포본에 직접 올렸다(첨부 상한 10MB). `recognitionDecisionTrace['basic.age']`:

```
p1: Age OCR did not finish within the allowed time.
p2: Age OCR was skipped because the per-student deadline had expired.
p3: Age OCR was skipped because the per-student deadline had expired.
```

첫 학생이 서버리스 콜드 스타트를 치르며 `DIGIT_OCR_TOTAL_TIMEOUT_MS`를 넘기고, 그 과정에서 학생별 마감 예산을
다 쓴다. 이후 전원이 만료된 마감을 만난다.

**그런데 분류기는 이것에 걸릴 이유가 없다.** 순수 TypeScript, 의존성 0, 실행 1ms. 문제는 획 비트맵이
`readDigitStrokes` 안, `await getDigitWorker()` **뒤**에서 채워졌다는 것이다. tesseract를 건너뛰는 모든 갈래가
비트맵도 함께 withhold했다. **워커를 대신하려고 만든 폴백이 그 워커 뒤에 갇혀 있었다.**

## 사이클 3 — 수정

획 캡처를 게이트 앞으로 옮겼다([ocrTextLines.ts](../src/lib/recognition/ocrTextLines.ts)):

- `captureStrokeBitmaps`를 `readDigitStrokes`에서 분리. `buildDigitStrokes`·`renderStrokesForOcr`는 sharp만 쓴다.
- `strokeSink`를 `try` 바깥으로 — `catch`(배포본 첫 학생이 실제로 탄 가지)에서도 획을 붙인다.
- 미리 만든 획을 `prepared`로 tesseract 경로에 넘겨 **중복 계산 없음**. 마감이 만료된 상태에서 새 비용을 더하면 안 된다.
- 비트맵은 같은 `renderStrokesForOcr` 호출에서 나오므로 리더 경로와 바이트 동일.

## 판정

**회귀 없음**(노드·dev는 이 실패를 재현하지 못하는 환경이므로 동일해야 정상이고, 동일했다):

```
단위 568 통과 · 스캔 360/4/73 · 348/7/82 · 353/2/82 · 308/7/122 · 사진 61/0 · 36/0 · 44/0 · 34/0
dev 브라우저 새 샘플 4/9 (변화 없음)
```

**배포본 판정 — 9명, 3명씩 세 묶음(묶음마다 콜드 스타트를 새로 치른다):**

| 학생 | 나이 | 진단 |
|---|---|---|
| s1 | – | 시간 초과 + 범위 없음 |
| **s2** | **14** ✓ | `gate=digit-classifier` |
| **s3** | **13** ✓ | `gate=digit-classifier` |
| s4·s5·s6 | – | 마감 만료 + 범위 없음 |
| **s7** | **15** ✓ | `gate=digit-classifier` |
| **s8** | **13** ✓ | `gate=digit-classifier` |
| s9 | – | 마감 만료 + 범위 없음 |

**0/9 → 4/9, 오답 0.** 네 칸 모두 정답표와 일치하고 넷 다 분류기가 채웠다. 배포본이 노드·dev와 같아졌다.

## 남은 것

빈 5칸은 나이 문제가 아니다. 학년·학교유형이 자동 확정되지 않아 분류기가 `12+N±1` 범위를 만들지 못하는
자리이고, 그 기본정보 축은 같은 날 계측으로 닫혔다([BASIC_BOX_GRAYSCALE_2026-09-07](BASIC_BOX_GRAYSCALE_2026-09-07.md)).

**tesseract는 배포본에서 여전히 나이를 한 칸도 읽지 못한다.** 이번 수정은 그것을 고치지 않았고, 분류기가 그
공백을 메우게 했을 뿐이다. 콜드 스타트 예산을 다시 볼 가치는 있지만, 이제 나이 정확도가 거기에 걸려 있지 않다.
