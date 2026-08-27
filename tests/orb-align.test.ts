/**
 * Pure-logic tests for the ORB alignment module. No OpenCV here -- importing
 * the 10MB emscripten bundle hangs vitest's transform pipeline indefinitely.
 * The cv-dependent round-trip check is scripts/check-orb-align.cjs (a
 * standalone Node script).
 */
import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  composeToFullRes,
  decideRegistration,
  decodeBase64ToBytes,
  measureResidualPx,
  multiplyHomographies,
  ORB_MIN_INLIERS,
  ORB_MIN_RATIO,
  QUAD_RESIDUAL_MAX_PX,
  type OrbAlignment,
  type OrbTemplate,
} from '../src/lib/documentScanner/orbAlign';
import cagiTemplateJson from '../src/lib/documentScanner/orbTemplate.cagi.json';
import satisfactionTemplateJson from '../src/lib/documentScanner/orbTemplate.satisfaction.json';

const IDENTITY: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe('composeToFullRes', () => {
  it('composes the identity with a pure downscale', () => {
    const composed = composeToFullRes(IDENTITY, 0.5, 0.25);

    // Elementwise: I . diag(0.5, 0.25, 1) = diag(0.5, 0.25, 1).
    expect(composed).toEqual([0.5, 0, 0, 0, 0.25, 0, 0, 0, 1]);

    // Behaviorally: a full-res point lands where its detection-frame twin
    // would under H (here the identity).
    expect(applyHomography(composed, 100, 200)).toEqual([50, 50]);
  });

  it('matches a hand-multiplied projective matrix', () => {
    // H . diag(0.25, 0.5, 1) multiplied out by hand: the first column scales
    // by 0.25, the second by 0.5, the third is unchanged.
    const homography = [1, 0.2, 3, 0.1, 1.1, 5, 0.0005, 0.0002, 1];
    const expected = [0.25, 0.1, 3, 0.025, 0.55, 5, 0.000125, 0.0001, 1];

    const composed = composeToFullRes(homography, 0.25, 0.5);

    composed.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index], 12);
    });
  });

  it('sends a full-res point where H sends the downscaled point', () => {
    const homography = [1.05, 0.03, -40, -0.02, 0.98, 25, 0.00012, -0.00008, 1];
    const scaleX = 1600 / 4032;
    const scaleY = 1200 / 3024;
    const composed = composeToFullRes(homography, scaleX, scaleY);

    for (const [x, y] of [[0, 0], [4032, 3024], [1234.5, 987.6]]) {
      const [expectedX, expectedY] = applyHomography(homography, x * scaleX, y * scaleY);
      const [actualX, actualY] = applyHomography(composed, x, y);
      expect(actualX).toBeCloseTo(expectedX, 9);
      expect(actualY).toBeCloseTo(expectedY, 9);
    }
  });
});

describe('multiplyHomographies', () => {
  it('applies the right operand first', () => {
    const scale = [2, 0, 0, 0, 3, 0, 0, 0, 1];
    const translate = [1, 0, 10, 0, 1, 20, 0, 0, 1];

    // (translate . scale)(1, 1) = translate(2, 3) = (12, 23)
    expect(applyHomography(multiplyHomographies(translate, scale), 1, 1)).toEqual([12, 23]);
    // (scale . translate)(1, 1) = scale(11, 21) = (22, 63)
    expect(applyHomography(multiplyHomographies(scale, translate), 1, 1)).toEqual([22, 63]);
  });
});

describe('measureResidualPx', () => {
  it('takes the median error under the identity, odd count', () => {
    const pairs: [number, number, number, number][] = [
      [0, 0, 0, 3],      // error 3
      [0, 0, 0, 1],      // error 1
      [10, 10, 10, 10],  // error 0
      [5, 5, 8, 9],      // error 5
      [2, 2, 2, 102],    // error 100
    ];

    expect(measureResidualPx(IDENTITY, pairs)).toBe(3);
  });

  it('averages the middle two for an even count', () => {
    const pairs: [number, number, number, number][] = [
      [0, 0, 0, 2],  // error 2
      [0, 0, 0, 4],  // error 4
    ];

    expect(measureResidualPx(IDENTITY, pairs)).toBe(3);
  });

  it('maps through the homography before measuring', () => {
    const doubling = [2, 0, 0, 0, 2, 0, 0, 0, 1];
    const pairs: [number, number, number, number][] = [
      [10, 20, 20, 40],  // exact under doubling: error 0
      [5, 5, 10, 13],    // maps to (10, 10): error 3
      [1, 1, 2, 6],      // maps to (2, 2): error 4
    ];

    expect(measureResidualPx(doubling, pairs)).toBe(3);
  });

  it('returns +Infinity for an empty pair list, so an unguarded caller fails verification', () => {
    expect(measureResidualPx(IDENTITY, [])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('decideRegistration', () => {
  const alignmentWith = (overrides: Partial<OrbAlignment>): OrbAlignment => ({
    homography: [...IDENTITY],
    inliers: ORB_MIN_INLIERS + 10,
    goodMatches: 80,
    inlierRatio: 0.75,
    inlierPairs: [],
    ...overrides,
  });

  /** Pairs whose photo->template offset under the identity quad-H is `offset` px. */
  const pairsWithError = (offset: number): [number, number, number, number][] => (
    [0, 1, 2, 3, 4].map((i): [number, number, number, number] => [i * 10, i * 10, i * 10 + offset, i * 10])
  );

  it('keeps a verified quad when the ORB residual is small', () => {
    const decision = decideRegistration({
      quadAccepted: true,
      quadHomographyToTemplate: [...IDENTITY],
      alignment: alignmentWith({ inlierPairs: pairsWithError(QUAD_RESIDUAL_MAX_PX - 15) }),
    });

    expect(decision.method).toBe('quad');
    expect(decision.verified).toBe(true);
    expect(decision.quadResidualPx).toBe(QUAD_RESIDUAL_MAX_PX - 15);
  });

  it('swaps to ORB when the quad residual exceeds the threshold and ORB is valid', () => {
    const decision = decideRegistration({
      quadAccepted: true,
      quadHomographyToTemplate: [...IDENTITY],
      alignment: alignmentWith({ inlierPairs: pairsWithError(QUAD_RESIDUAL_MAX_PX + 80) }),
    });

    expect(decision.method).toBe('orb');
    expect(decision.verified).toBe(true);
    expect(decision.quadResidualPx).toBe(QUAD_RESIDUAL_MAX_PX + 80);
  });

  it('keeps the quad unverified when the residual is high but ORB is too weak to replace it', () => {
    const decision = decideRegistration({
      quadAccepted: true,
      quadHomographyToTemplate: [...IDENTITY],
      alignment: alignmentWith({
        inliers: ORB_MIN_INLIERS - 20,
        inlierRatio: ORB_MIN_RATIO - 0.1,
        inlierPairs: pairsWithError(QUAD_RESIDUAL_MAX_PX + 80),
      }),
    });

    expect(decision.method).toBe('quad');
    expect(decision.verified).toBe(false);
  });

  it('keeps the quad unverified when there is nothing to verify against', () => {
    const decision = decideRegistration({
      quadAccepted: true,
      quadHomographyToTemplate: [...IDENTITY],
      alignment: null,
    });

    expect(decision.method).toBe('quad');
    expect(decision.verified).toBe(false);
    expect(decision.quadResidualPx).toBeNull();
  });

  it('falls back to a valid ORB registration when the quad was rejected', () => {
    const decision = decideRegistration({
      quadAccepted: false,
      quadHomographyToTemplate: null,
      alignment: alignmentWith({ inlierPairs: pairsWithError(2) }),
    });

    expect(decision.method).toBe('orb');
    expect(decision.verified).toBe(true);
    expect(decision.quadResidualPx).toBeNull();
  });

  it('reports none when the quad is rejected and ORB misses its gates', () => {
    for (const weak of [
      alignmentWith({ homography: null, inliers: 0, inlierRatio: 0 }),
      alignmentWith({ inliers: ORB_MIN_INLIERS - 1 }),
      alignmentWith({ inlierRatio: ORB_MIN_RATIO - 0.01 }),
      null,
    ]) {
      const decision = decideRegistration({
        quadAccepted: false,
        quadHomographyToTemplate: null,
        alignment: weak,
      });

      expect(decision.method).toBe('none');
      expect(decision.verified).toBe(false);
    }
  });
});

describe('committed ORB template JSONs', () => {
  const templates: [string, OrbTemplate][] = [
    ['cagi', cagiTemplateJson as unknown as OrbTemplate],
    ['satisfaction', satisfactionTemplateJson as unknown as OrbTemplate],
  ];

  it.each(templates)('%s template has the 1422x1968 frame and a consistent descriptor matrix', (_name, template) => {
    expect(template.width).toBe(1422);
    expect(template.height).toBe(1968);

    const bytes = decodeBase64ToBytes(template.descriptors);
    expect(bytes.length % 32).toBe(0);
    expect(bytes.length / 32).toBe(template.points.length);
    expect(template.points.length).toBeGreaterThan(0);

    for (const [x, y] of template.points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(template.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(template.height);
    }
  });

  it('decodes base64 identically to Node', () => {
    const sample = (cagiTemplateJson as unknown as OrbTemplate).descriptors;
    const decoded = decodeBase64ToBytes(sample);
    const reference = new Uint8Array(Buffer.from(sample, 'base64'));

    expect(decoded.length).toBe(reference.length);
    expect(Buffer.compare(Buffer.from(decoded), Buffer.from(reference))).toBe(0);
  });
});
