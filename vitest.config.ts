import { defineConfig } from 'vitest/config';

/**
 * Agent worktrees live under `.claude/worktrees/`, inside the repository, and
 * each carries a full copy of `tests/`. Without this exclusion vitest picks up
 * those copies too, so a single measurement runs several times against several
 * different working states and prints several totals. That is exactly the kind
 * of instrument confusion this project has already been burned by, so keep the
 * runner pointed at this checkout only.
 */
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.claude/**',
      '**/tmp/**',
    ],
  },
});
