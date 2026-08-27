import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS_QUERY_PARAM,
  attachUploadResult,
  buildCaptureDiagnosticRecord,
  buildCaptureDiagnosticsExport,
  buildDiagnosticLines,
  isDiagnosticsEnabled,
  serializeCaptureDiagnostics,
  updateCaptureDiagnosticRecord,
  type CaptureDiagnosticRecord,
} from '../src/lib/documentScanner/captureDiagnostics';
import {
  LIVE_DYNAMIC_RANGE_WARN,
  LIVE_EXPOSURE_HINT_ENABLED,
  LIVE_EXPOSURE_MIN_SAMPLES,
  evaluateCaptureGuidance,
  type CaptureGuidanceStatus,
  type FrameExposureSample,
} from '../src/lib/documentScanner/captureGuidance';
import type { Point } from '../src/lib/documentScanner/perspectiveCorrect';

/**
 * The device-session diagnostic (CAPTURE_GUIDANCE §13.10).
 *
 * Everything a camera is needed for is out of reach here. What is not: the
 * gate that decides whether any of it appears, the record the shutter writes,
 * the join back to the stored image, and the JSON that leaves the phone. Those
 * are the parts that would silently produce an unusable log, which is the one
 * failure the sitting cannot recover from -- the paper will have been put away.
 */

const QUAD: Point[] = [
  { x: 44, y: 61 },
  { x: 356, y: 61 },
  { x: 356, y: 493 },
  { x: 44, y: 493 },
];

const EXPOSURE: FrameExposureSample = {
  p05: 118,
  p95: 205,
  dynamicRange: 87,
  region: 'quad',
  sampleCount: 11840,
  stride: 3,
};

function statusFor(exposure: FrameExposureSample | null): CaptureGuidanceStatus {
  return evaluateCaptureGuidance({
    quality: { points: QUAD, confidence: 0.9, edgeConsistency: 0.99, aspectRatio: 1.384 },
    rejection: null,
    frameWidth: 400,
    frameHeight: 554,
    exposure,
  });
}

function recordFor(status: CaptureGuidanceStatus | null, index = 1): CaptureDiagnosticRecord {
  return buildCaptureDiagnosticRecord({
    index,
    capturedAt: '2026-08-28T01:23:45.000Z',
    step: 'cagi',
    status,
    readyStreak: 3,
    frameWidth: 368,
    frameHeight: 480,
  });
}

// --- the gate ---------------------------------------------------------------

describe('isDiagnosticsEnabled', () => {
  it('is off for the ordinary URL', () => {
    for (const search of ['', '?', '?foo=1', '?diagnostics=1', null, undefined]) {
      expect(isDiagnosticsEnabled(search)).toBe(false);
    }
  });

  it('is on for the forms a person actually types', () => {
    for (const search of ['?diag=1', 'diag=1', '?diag', '?diag=', '?diag=true', '?diag=on', '?a=b&diag=1']) {
      expect(isDiagnosticsEnabled(search)).toBe(true);
    }
  });

  it('is off for an explicit negative, so a stale bookmark cannot leave it on', () => {
    for (const search of ['?diag=0', '?diag=false', '?diag=off', '?diag=no']) {
      expect(isDiagnosticsEnabled(search)).toBe(false);
    }
  });

  it('names the parameter it reads', () => {
    expect(DIAGNOSTICS_QUERY_PARAM).toBe('diag');
  });
});

// --- the record -------------------------------------------------------------

describe('buildCaptureDiagnosticRecord', () => {
  it('captures the reading the person was looking at when they pressed', () => {
    const record = recordFor(statusFor(EXPOSURE));

    expect(record.index).toBe(1);
    expect(record.step).toBe('cagi');
    expect(record.capturedAt).toBe('2026-08-28T01:23:45.000Z');
    expect(record.readyStreak).toBe(3);
    expect(record.frameWidth).toBe(368);
    expect(record.frameHeight).toBe(480);
    expect(record.exposure).toEqual(EXPOSURE);
    expect(record.code).toBe('ready');
    expect(record.level).toBe('ready');
  });

  it('records a shot taken before the first detection rather than dropping it', () => {
    const record = recordFor(null);

    expect(record.code).toBe('no-frame');
    expect(record.level).toBe('searching');
    expect(record.exposure).toBeNull();
    expect(record.geometry).toBeNull();
    // Still a numbered shot: the log's indices must match the shutter presses,
    // or every later index is off by the number of early frames.
    expect(record.index).toBe(1);
  });

  it('rounds the geometry to something a person can read', () => {
    const record = recordFor(statusFor(EXPOSURE));

    for (const value of Object.values(record.geometry!)) {
      expect(value).toBe(Math.round(value * 10000) / 10000);
    }
    expect(record.geometry!.aspectRatio).toBeCloseTo(432 / 312, 3);
  });

  it('starts unjoined -- the id does not exist yet at the shutter', () => {
    const record = recordFor(statusFor(EXPOSURE));

    expect(record.outcome).toBe('pending');
    expect(record.imageId).toBeNull();
    expect(record.filename).toBeNull();
    expect(record.uploadedAt).toBeNull();
  });
});

// --- the join ---------------------------------------------------------------

describe('attachUploadResult', () => {
  const records = [recordFor(statusFor(EXPOSURE), 1), recordFor(statusFor(null), 2)];

  it('joins a record to the id recognition will read the image by', () => {
    const joined = attachUploadResult(
      records,
      2,
      'jobs/j1/uploads/cagi/b1/001.jpg',
      'cagi_page_001.jpg',
      '2026-08-28T01:24:00.000Z',
    );

    expect(joined[1].outcome).toBe('uploaded');
    expect(joined[1].imageId).toBe('jobs/j1/uploads/cagi/b1/001.jpg');
    expect(joined[1].filename).toBe('cagi_page_001.jpg');
    expect(joined[1].uploadedAt).toBe('2026-08-28T01:24:00.000Z');
    // Untouched neighbour, and the input array is not mutated.
    expect(joined[0]).toEqual(records[0]);
    expect(records[1].imageId).toBeNull();
  });

  it('leaves the log alone for an index it does not have', () => {
    expect(attachUploadResult(records, 99, 'x', 'y', 'z')).toEqual(records);
  });

  it('marks a shot that never became an upload, and leaves it unjoined', () => {
    // A refused frame has a preview reading and no yield to join it to. That
    // is a fact about the sitting, not a hole in the log.
    const marked = updateCaptureDiagnosticRecord(records, 1, { outcome: 'retake-prompted' });

    expect(marked[0].outcome).toBe('retake-prompted');
    expect(marked[0].imageId).toBeNull();
    expect(marked[0].exposure).toEqual(EXPOSURE);
  });
});

// --- the export -------------------------------------------------------------

describe('serializeCaptureDiagnostics', () => {
  const records = [
    attachUploadResult(
      [recordFor(statusFor(EXPOSURE), 1)],
      1,
      'jobs/j1/uploads/cagi/b1/001.jpg',
      'cagi_page_001.jpg',
      '2026-08-28T01:24:00.000Z',
    )[0],
    recordFor(statusFor(null), 2),
  ];

  it('carries the thresholds the readings were taken under', () => {
    // Without these the log has to be dated against a git history to be read.
    const payload = buildCaptureDiagnosticsExport(records, '2026-08-28T02:00:00.000Z', 'UA/1.0');

    expect(payload.schema).toBe('kpga.capture-diagnostics.v1');
    expect(payload.hintEnabled).toBe(LIVE_EXPOSURE_HINT_ENABLED);
    expect(payload.hintEnabled).toBe(false);
    expect(payload.dynamicRangeWarn).toBe(LIVE_DYNAMIC_RANGE_WARN);
    expect(payload.minSamples).toBe(LIVE_EXPOSURE_MIN_SAMPLES);
    expect(payload.count).toBe(2);
    expect(payload.userAgent).toBe('UA/1.0');
  });

  it('round-trips through JSON with the join intact', () => {
    const json = serializeCaptureDiagnostics(records, '2026-08-28T02:00:00.000Z', null);
    const parsed = JSON.parse(json);

    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].imageId).toBe('jobs/j1/uploads/cagi/b1/001.jpg');
    expect(parsed.records[0].exposure.dynamicRange).toBe(87);
    expect(parsed.records[0].exposure.region).toBe('quad');
    expect(parsed.records[1].imageId).toBeNull();
    expect(parsed.userAgent).toBeNull();
    // Indented: the fallback path renders this into a <pre> for a human to
    // select, and one long line is unreadable there.
    expect(json).toContain('\n  ');
  });

  it('serialises an empty log without throwing', () => {
    expect(JSON.parse(serializeCaptureDiagnostics([], '2026-08-28T02:00:00.000Z', null)).count).toBe(0);
  });
});

// --- the readout ------------------------------------------------------------

describe('buildDiagnosticLines', () => {
  it('shows the numbers the session exists to collect', () => {
    const lines = buildDiagnosticLines(statusFor(EXPOSURE), 368, 480, 3);
    const byLabel = Object.fromEntries(lines.map((line) => [line.label, line.value]));

    expect(byLabel['영역']).toBe('quad');
    expect(byLabel['range']).toBe('87');
    expect(byLabel['p05 / p95']).toBe('118 / 205');
    expect(byLabel['표본']).toBe('11840 (stride 3)');
    expect(byLabel['상태']).toBe('ready / ready');
    expect(byLabel['streak']).toBe('3');
    expect(byLabel['프레임']).toBe('368x480');
    expect(byLabel['roll']).toBe('0.00°');
    expect(byLabel['keystone V/H']).toBe('0.000 / 0.000');
  });

  it('renders dashes rather than NaN before the first frame', () => {
    const lines = buildDiagnosticLines(null, 0, 0, 0);

    expect(lines.find((line) => line.label === '상태')!.value).toBe('대기');
    for (const label of ['영역', 'range', 'p05 / p95', '표본', 'roll', 'margin', '프레임']) {
      expect(lines.find((line) => line.label === label)!.value).toBe('-');
    }
  });

  it('says when the reading is the guide region, because then it is not the paper', () => {
    // §13.3: 14 of 19 frames fell here and the number ran backwards. Whoever
    // reads this screen has to be able to see which measurement they are
    // looking at.
    const guide: FrameExposureSample = { ...EXPOSURE, region: 'guide', dynamicRange: 143 };
    const lines = buildDiagnosticLines(statusFor(guide), 368, 480, 0);
    const byLabel = Object.fromEntries(lines.map((line) => [line.label, line.value]));

    expect(byLabel['영역']).toBe('guide');
    expect(byLabel['range']).toBe('143');
  });

  it('never changes what the guidance decided', () => {
    // The readout is a reader. A dark frame is still 'ready' with the hint off,
    // and building the lines does not alter the status it was given.
    const status = statusFor({ ...EXPOSURE, dynamicRange: 61 });
    const before = JSON.stringify(status);

    buildDiagnosticLines(status, 368, 480, 4);

    expect(JSON.stringify(status)).toBe(before);
    expect(status.code).toBe('ready');
  });
});
