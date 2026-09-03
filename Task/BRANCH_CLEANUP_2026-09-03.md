# 브랜치·워크트리 일괄 정리 (2026-09-03, 사용자 지시)

## 기준
- `git branch --merged main` + `git cherry`(패치 내용)로 병합 여부를 확인했다. 두 기준 모두 main에 들어간 브랜치는 **삭제**(37개: `codex-*` 병합 라운드,
  `worktree-agent-*`·`worktree-wf_*`(08-27 사진 경로 워크플로), `fix/*`, `round7/8-*`, `feat/label-export`, `loop/c1-preview`, `initial-project-setup`,
  `photo-path-correction-measurement`, `master`(초기 커밋 내용은 main에 있음)).
- main에 없는 커밋이 있는 브랜치 7개는 **`archive/<이름>` 태그로 보존하고 브랜치만 지웠다** — 객체가 유지되므로 `git checkout -b <이름> archive/<이름>`으로
  복구된다. 판정 기록: topology 라운드는 08-29에 사망 판정(`36db6e8`), grid-threshold는 09-02 사이클 1(`c4edcec`), 나머지는 아래 표의 커밋 제목이 내용이다.

| 태그 | 해시 | main에 없는 커밋 | 마지막 커밋 | 제목 |
|---|---|---|---|---|
| `archive/codex-crossing-topology` | dc70e49 | 1 | 2026-08-29 | Add residual crossing topology measurements |
| `archive/codex-glyph-anchor` | e9d42bb | 5 | 2026-09-02 | Anchor grid adoption to printed glyphs |
| `archive/codex-grid-threshold` | 9bf3302 | 2 | 2026-09-02 | Merge branch 'main' into codex-grid-threshold |
| `archive/codex-scorer-evidence` | 6a5f0da | 1 | 2026-08-20 | Weight mark residuals toward cell centres |
| `archive/feature/adult-cpgi-track` | 8dfb07e | 2 | 2026-08-01 | Add Vercel preview deployment QA feedback |
| `archive/worktree-agent-a07fd8d26120d2d5b` | da9c5af | 2 | 2026-08-20 | Keep ink depth as evidence and add coverage beside it |
| `archive/worktree-agent-a5539771543c0f604` | e59bd1a | 2 | 2026-08-20 | Report which gate rejected the age and what the readers actually read |

- 유지: `main`, `stateless-recognize`(ef15353, 무상태 라운드 A 통과 — 사용자 시험용, 워크트리 `scratchpad/wt-stateless`).

## 워크트리
- 제거: 이 세션·이전 세션 스크래치패드의 `wt-*` 14개, `.claude/worktrees/*` 23개. 남은 것은 메인 체크아웃과 `wt-stateless`뿐.
- 주의: 스크래치 워크트리의 `node_modules`는 메인 `node_modules`로의 접합점(junction)이었다. 제거 뒤 메인 `node_modules`(215 항목, next/sharp/vitest/
  tesseract.js/pdfjs-dist/canvas 존재)·`tsc`·격자 시험 29 통과를 확인했다. 앞으로 워크트리를 지울 때는 **접합점을 먼저 `rmdir`로 끊고** `git worktree remove`.
- 경로 길이 초과("Filename too long")로 디렉터리가 남은 옛 워크트리(wt-grid·wt-scorer·wt-badge·wt-bounds·wt-glyph·wt-grid-th·wt-topology)는 git 등록만
  해제됐고 디렉터리는 별도로 지웠다(아래 결과 참조).

## 결과
- 브랜치: `main`, `stateless-recognize`만 남음. `loop/c1-preview`·`photo-path-correction-measurement`는 `--merged main`에는 들었지만 `-d`가 거부해 `-D`로 지웠다.
- 워크트리: 메인 체크아웃과 `wt-stateless`만 남음. 스크래치패드의 빈 `wt-*` 껍데기 8개는 남아 있던 `node_modules` 접합점을 PowerShell로 끊은 뒤 지웠고,
  경로 길이로 남았던 옛 7개는 실제 디렉터리(부분 복사본)임을 확인하고 `rm -rf`로 지웠다.
- 건강 확인: 메인 `node_modules` 218 항목(숨김 포함), `npx tsc --noEmit` 통과, 전체 `npx vitest run` 통과(아래 줄).

  ` Test Files 49 passed | 18 skipped (67) Tests 483 passed | 18 skipped (501) `
