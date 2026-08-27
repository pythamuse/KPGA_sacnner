import {
  LIVE_DYNAMIC_RANGE_WARN,
  LIVE_EXPOSURE_HINT_ENABLED,
  LIVE_EXPOSURE_MIN_SAMPLES,
  type CaptureGuidanceCode,
  type CaptureGuidanceLevel,
  type CaptureGuidanceStatus,
  type FrameExposureSample,
  type QuadGeometry,
} from './captureGuidance';

/**
 * The device session's readout and its log (CAPTURE_GUIDANCE §13.10).
 *
 * WHY THIS EXISTS
 * ---------------
 * §13 closed one explanation -- preview `dynamicRange` scores at chance on
 * DOWNSCALED STILLS -- and left exactly one way to reopen it: a measurement
 * showing a real device's preview raster behaves differently from a downscale
 * (§13.6). Nobody can take that measurement, because the number never reaches
 * the screen. `exposure` rides all the way into `CaptureGuidanceStatus` and
 * stops there: the phone that is the only instrument able to answer the
 * question displays none of it.
 *
 * So this is a diagnostic surface, and it is OFF unless the URL asks for it.
 *
 * A LIVE NUMBER IS NOT DATA. A person reading 87 off a phone screen has an
 * anecdote. What makes the sitting worth its time is the LOG: one record per
 * shutter press, joinable afterwards to whether that exact photo yielded cells
 * against the answer key. The join is `imageId` -- see `attachUploadResult`.
 *
 * NOTHING HERE DECIDES ANYTHING. It reads `CaptureGuidanceStatus` and writes
 * records. `LIVE_EXPOSURE_HINT_ENABLED` stays false and no guidance decision
 * consults this file.
 */

// --- the gate ---------------------------------------------------------------

/**
 * `?diag=1`.
 *
 * A query parameter and not an env var or a build flag, because of who turns it
 * on and how: someone standing over a stack of paper with a phone, typing a URL.
 * They cannot rebuild, and they should not have to -- and the same phone must be
 * able to get back to the ordinary screen by deleting five characters.
 */
export const DIAGNOSTICS_QUERY_PARAM = 'diag';

/**
 * True only for an explicit affirmative. `?diag=0` and `?diag=false` are off,
 * so a stale bookmark cannot leave the readout on by accident, and a bare
 * `?diag` is on because that is what a person types.
 */
export function isDiagnosticsEnabled(search: string | null | undefined): boolean {
  if (!search) return false;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return false;
  }

  const value = params.get(DIAGNOSTICS_QUERY_PARAM);
  if (value === null) return false;
  return value === '' || value === '1' || value === 'true' || value === 'on';
}

// --- the record -------------------------------------------------------------

export type CaptureDiagnosticOutcome = 'pending' | 'uploaded' | 'retake-prompted' | 'error';

export interface CaptureDiagnosticRecord {
  /** Monotonic, 1-based, per camera session. The fallback join key. */
  index: number;
  capturedAt: string;
  step: 'cagi' | 'satisfaction';
  /** Guidance as it stood on the last tick before the shutter. */
  code: CaptureGuidanceCode;
  level: CaptureGuidanceLevel;
  /** What `nextReadyStreak` had counted -- the shutter-emphasis input. */
  readyStreak: number;
  frameWidth: number;
  frameHeight: number;
  exposure: FrameExposureSample | null;
  geometry: QuadGeometry | null;
  outcome: CaptureDiagnosticOutcome;
  /**
   * THE JOIN. `stored.pathname` from the upload response -- the same identifier
   * recognition later reads the image by, so a record and a scored sheet meet
   * without anything being stamped into a file or a header.
   *
   * Null until the upload resolves, and null forever for a shot that was
   * refused or never confirmed. That is information too: those are the frames
   * whose preview readings have no yield to be joined to.
   */
  imageId: string | null;
  filename: string | null;
  uploadedAt: string | null;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Long float tails make the log unreadable and carry nothing at these scales. */
function roundGeometry(geometry: QuadGeometry | null): QuadGeometry | null {
  if (!geometry) return null;
  return {
    rollDeg: round4(geometry.rollDeg),
    keystoneV: round4(geometry.keystoneV),
    keystoneH: round4(geometry.keystoneH),
    coverageW: round4(geometry.coverageW),
    coverageH: round4(geometry.coverageH),
    marginMin: round4(geometry.marginMin),
    aspectRatio: round4(geometry.aspectRatio),
  };
}

export interface CaptureDiagnosticInput {
  index: number;
  capturedAt: string;
  step: 'cagi' | 'satisfaction';
  status: CaptureGuidanceStatus | null;
  readyStreak: number;
  frameWidth: number;
  frameHeight: number;
}

/**
 * One shutter press.
 *
 * A null `status` is recorded rather than dropped: it means the shutter was
 * pressed before the first detection came back, and a shot with no reading is
 * a fact about the sitting.
 */
export function buildCaptureDiagnosticRecord(
  input: CaptureDiagnosticInput,
): CaptureDiagnosticRecord {
  return {
    index: input.index,
    capturedAt: input.capturedAt,
    step: input.step,
    code: input.status?.code ?? 'no-frame',
    level: input.status?.level ?? 'searching',
    readyStreak: input.readyStreak,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    exposure: input.status?.exposure ?? null,
    geometry: roundGeometry(input.status?.geometry ?? null),
    outcome: 'pending',
    imageId: null,
    filename: null,
    uploadedAt: null,
  };
}

/** Immutable update by index; an unknown index leaves the log untouched. */
export function updateCaptureDiagnosticRecord(
  records: CaptureDiagnosticRecord[],
  index: number,
  patch: Partial<Omit<CaptureDiagnosticRecord, 'index'>>,
): CaptureDiagnosticRecord[] {
  return records.map((record) => (record.index === index ? { ...record, ...patch } : record));
}

/**
 * Closes the join once the server has named the stored page.
 *
 * Deliberately NOT done by stamping the index into the filename or the
 * registration meta. The upload route discards the client filename entirely and
 * regenerates it (`${type}_page_NNN.jpg`), so a stamp there would never reach
 * storage; and `registration` is read by the recognition and verdict path,
 * which this round must not touch. `imageId` is already the exact identifier
 * both sides share, and recording it costs nothing anywhere else.
 */
export function attachUploadResult(
  records: CaptureDiagnosticRecord[],
  index: number,
  imageId: string,
  filename: string,
  uploadedAt: string,
): CaptureDiagnosticRecord[] {
  return updateCaptureDiagnosticRecord(records, index, {
    outcome: 'uploaded',
    imageId,
    filename,
    uploadedAt,
  });
}

// --- the export -------------------------------------------------------------

export interface CaptureDiagnosticsExport {
  schema: 'kpga.capture-diagnostics.v1';
  exportedAt: string;
  userAgent: string | null;
  /**
   * The constants the readings were taken under, carried with the readings.
   * A log that does not say which thresholds were in force when it was written
   * is a log that has to be dated against a git history to be read at all.
   */
  hintEnabled: boolean;
  dynamicRangeWarn: number;
  minSamples: number;
  count: number;
  records: CaptureDiagnosticRecord[];
}

export function buildCaptureDiagnosticsExport(
  records: CaptureDiagnosticRecord[],
  exportedAt: string,
  userAgent: string | null,
): CaptureDiagnosticsExport {
  return {
    schema: 'kpga.capture-diagnostics.v1',
    exportedAt,
    userAgent,
    hintEnabled: LIVE_EXPOSURE_HINT_ENABLED,
    dynamicRangeWarn: LIVE_DYNAMIC_RANGE_WARN,
    minSamples: LIVE_EXPOSURE_MIN_SAMPLES,
    count: records.length,
    records,
  };
}

export function serializeCaptureDiagnostics(
  records: CaptureDiagnosticRecord[],
  exportedAt: string,
  userAgent: string | null,
): string {
  return JSON.stringify(buildCaptureDiagnosticsExport(records, exportedAt, userAgent), null, 2);
}

// --- the readout ------------------------------------------------------------

export interface DiagnosticLine {
  label: string;
  value: string;
}

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

/**
 * The live block, as label/value pairs so the JSX stays dumb and this stays
 * testable without a camera.
 *
 * Terse and numeric on purpose -- it is read at arm's length between shots, not
 * studied. `region` leads because §13.3 is the reason a reading can be
 * meaningless: 14 of 19 frames fell to the guide region, where the number is
 * not the paper's exposure and ran backwards.
 */
export function buildDiagnosticLines(
  status: CaptureGuidanceStatus | null,
  frameWidth: number,
  frameHeight: number,
  readyStreak: number,
): DiagnosticLine[] {
  const exposure = status?.exposure ?? null;
  const geometry = status?.geometry ?? null;

  return [
    { label: '상태', value: status ? `${status.code} / ${status.level}` : '대기' },
    { label: '영역', value: exposure ? exposure.region : '-' },
    { label: 'range', value: exposure ? String(exposure.dynamicRange) : '-' },
    { label: 'p05 / p95', value: exposure ? `${exposure.p05} / ${exposure.p95}` : '-' },
    {
      label: '표본',
      value: exposure ? `${exposure.sampleCount} (stride ${exposure.stride})` : '-',
    },
    { label: 'roll', value: geometry ? `${fixed(geometry.rollDeg, 2)}°` : '-' },
    {
      label: 'keystone V/H',
      value: geometry ? `${fixed(geometry.keystoneV, 3)} / ${fixed(geometry.keystoneH, 3)}` : '-',
    },
    {
      label: 'coverage W/H',
      value: geometry ? `${fixed(geometry.coverageW, 3)} / ${fixed(geometry.coverageH, 3)}` : '-',
    },
    { label: 'margin', value: geometry ? fixed(geometry.marginMin, 3) : '-' },
    { label: 'aspect', value: geometry ? fixed(geometry.aspectRatio, 3) : '-' },
    { label: 'streak', value: String(readyStreak) },
    { label: '프레임', value: frameWidth > 0 ? `${frameWidth}x${frameHeight}` : '-' },
  ];
}
