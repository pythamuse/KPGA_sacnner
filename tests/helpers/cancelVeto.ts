import { afterEach, beforeEach } from 'vitest';

/**
 * Arming (or disarming) the cancelled-mark veto around one body.
 *
 * `MARK_CANCEL_VETO` and its two thresholds are read from `process.env` at call
 * time, exactly like `MARK_AFFINE_TONE` (see `./affineTone`) and the scorer's
 * noise-floor instruments (see `./scorerVariants`). The suite has to pass both
 * with `MARK_CANCEL_VETO=1` in the environment and without it -- that pair is
 * how the veto is measured -- so a suite that asserts what the shipped path
 * produces has to state which side of the flag it is on rather than inherit
 * whatever the shell had.
 *
 * `undefined` for a variable means "not set at all". Since the veto is default
 * on, unset is the ARMED configuration; `MARK_CANCEL_VETO: '0'` is the disabled
 * one. Either way the previous environment is restored faithfully.
 */
export type CancelVetoSettings = {
  MARK_CANCEL_VETO?: string;
  MARK_CANCEL_CROSSING?: string;
  MARK_CANCEL_FILL?: string;
};

const KEYS: Array<keyof CancelVetoSettings> = [
  'MARK_CANCEL_VETO',
  'MARK_CANCEL_CROSSING',
  'MARK_CANCEL_FILL',
];

export function withCancelVeto<T>(settings: CancelVetoSettings, body: () => T): T {
  const previous: CancelVetoSettings = {};
  for (const key of KEYS) {
    previous[key] = process.env[key];
    const next = settings[key];
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
 * Pins the calling suite to the pre-veto path (`MARK_CANCEL_VETO=0`).
 *
 * For suites whose fixtures are SYNTHETIC marks. `crossingScore` cannot
 * separate a crossing from a closed curve (`MarkShapeTrace`, and §2.1 of the
 * shape report): a drawn ring reads 1.00, and so does the ragged boundary of a
 * filled-in mark. A synthetic ring or blob drawn thick enough to clear
 * `inkBboxFill` therefore reads as cancelled, and a suite asserting that the
 * scorer fills such a box is asserting shipped behaviour, not the veto's.
 * Whether the veto is worth its cost is decided on real rasters, not here.
 */
export function pinCancelVetoOff(): void {
  let previous: CancelVetoSettings = {};
  beforeEach(() => {
    previous = {};
    for (const key of KEYS) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
    // The veto is default on, so disabling it takes the explicit value.
    process.env.MARK_CANCEL_VETO = '0';
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
