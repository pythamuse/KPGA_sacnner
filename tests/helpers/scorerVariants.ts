import { afterEach, beforeEach } from 'vitest';

/**
 * Arming (or disarming) the scorer's noise-floor instruments around one body.
 *
 * `MARK_BASELINE_DILATE` and `MARK_ALIGN_RADIUS` are read from `process.env` at
 * call time, exactly like `MARK_AFFINE_TONE` (see `./affineTone`), so a suite
 * that pins a number the scorer produced has to say which side of them it is
 * on rather than inherit whatever the shell had. The measurement round runs the
 * whole suite twice -- once with both unset, once with both set -- and that is
 * only meaningful if the fixture suites are pinned to the shipped path.
 *
 * `undefined` for a variable means "not set at all", which is the shipped
 * configuration and is restored faithfully.
 */
export type ScorerVariants = {
  MARK_BASELINE_DILATE?: string;
  MARK_ALIGN_RADIUS?: string;
};

const KEYS: Array<keyof ScorerVariants> = ['MARK_BASELINE_DILATE', 'MARK_ALIGN_RADIUS'];

export function withScorerVariants<T>(variants: ScorerVariants, body: () => T): T {
  const previous: ScorerVariants = {};
  for (const key of KEYS) {
    previous[key] = process.env[key];
    const next = variants[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  try {
    return body();
  } finally {
    for (const key of KEYS) {
      const restore = previous[key];
      if (restore === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = restore;
      }
    }
  }
}

/**
 * Pins every reading in the calling suite to the SHIPPED scorer.
 *
 * The two noise-floor instruments are measured by running this whole suite
 * twice, and a suite that asserts an exact score or an exact trace line is
 * asserting what the shipped path produces -- under `MARK_BASELINE_DILATE` or
 * `MARK_ALIGN_RADIUS` those digits are supposed to move, and a failure there
 * would be the instrument working, not a regression. Such suites call this so
 * the variant run still exercises them and still means something.
 *
 * Anything asserting behaviour rather than digits needs no pin and gets none:
 * those suites run under both settings and are the "it still works" half of
 * the variant run.
 */
export function pinShippedScorer(): void {
  let previous: ScorerVariants = {};
  beforeEach(() => {
    previous = {};
    for (const key of KEYS) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      const restore = previous[key];
      if (restore === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = restore;
      }
    }
  });
}

/** The shipped scorer: both instruments off, whatever the ambient shell says. */
export function withScorerDefaults<T>(body: () => T): T {
  return withScorerVariants({}, body);
}
