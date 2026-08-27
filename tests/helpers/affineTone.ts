/**
 * Arming `MARK_AFFINE_TONE` around one measurement.
 *
 * Two rules in `markDensity.ts` are scoped to the affine tone map -- the
 * total-ink guard and the two-candidate photo refusal -- and both read
 * `affineToneEnabled()`, which reads `process.env` at call time. A suite that
 * asserts either behaviour has to state which side of the flag it is on rather
 * than inherit the ambient value, because the suite has to pass both with
 * `MARK_AFFINE_TONE=1` in the environment and without it (that pair is how the
 * flag is measured: FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27 §13.1).
 *
 * Restores whatever it found, including "not set at all", so cases that arm the
 * flag cannot leak it into cases that pin the shipped path.
 */
export function withAffineTone<T>(armed: boolean, body: () => T): T {
  const previous = process.env.MARK_AFFINE_TONE;
  if (armed) {
    process.env.MARK_AFFINE_TONE = '1';
  } else {
    delete process.env.MARK_AFFINE_TONE;
  }
  try {
    return body();
  } finally {
    if (previous === undefined) {
      delete process.env.MARK_AFFINE_TONE;
    } else {
      process.env.MARK_AFFINE_TONE = previous;
    }
  }
}
