import { describe, expect, it } from 'vitest';
import { evaluateQuad, orderQuadPoints, type Point } from '../src/lib/documentScanner/perspectiveCorrect';

describe('orderQuadPoints', () => {
  it('orders a scrambled rectangle as top-left, top-right, bottom-right, bottom-left', () => {
    const points: Point[] = [
      { x: 100, y: 200 },
      { x: 300, y: 50 },
      { x: 300, y: 200 },
      { x: 100, y: 50 },
    ];

    expect(orderQuadPoints(points)).toEqual([
      { x: 100, y: 50 },
      { x: 300, y: 50 },
      { x: 300, y: 200 },
      { x: 100, y: 200 },
    ]);
  });

  it('orders a skewed quadrilateral from arbitrary point order', () => {
    const points: Point[] = [
      { x: 115, y: 410 },
      { x: 390, y: 370 },
      { x: 80, y: 90 },
      { x: 420, y: 120 },
    ];

    expect(orderQuadPoints(points)).toEqual([
      { x: 80, y: 90 },
      { x: 420, y: 120 },
      { x: 390, y: 370 },
      { x: 115, y: 410 },
    ]);
  });

  it('orders points that are already in a rotated sequence', () => {
    const points: Point[] = [
      { x: 250, y: 260 },
      { x: 60, y: 240 },
      { x: 50, y: 40 },
      { x: 270, y: 50 },
    ];

    const [topLeft, topRight, bottomRight, bottomLeft] = orderQuadPoints(points);

    expect(topLeft.x).toBeLessThan(topRight.x);
    expect(topLeft.y).toBeLessThan(bottomLeft.y);
    expect(bottomRight.x).toBeGreaterThan(bottomLeft.x);
    expect(bottomRight.y).toBeGreaterThan(topRight.y);
    expect([topLeft, topRight, bottomRight, bottomLeft]).toEqual([
      { x: 50, y: 40 },
      { x: 270, y: 50 },
      { x: 250, y: 260 },
      { x: 60, y: 240 },
    ]);
  });
});

describe('evaluateQuad', () => {
  it('scores a large portrait page higher than a small inner table rectangle', () => {
    const page = evaluateQuad(
      [
        { x: 80, y: 40 },
        { x: 520, y: 55 },
        { x: 500, y: 760 },
        { x: 60, y: 745 },
      ],
      600,
      800,
      656 / 474,
    );
    const innerTable = evaluateQuad(
      [
        { x: 160, y: 280 },
        { x: 440, y: 290 },
        { x: 430, y: 500 },
        { x: 170, y: 490 },
      ],
      600,
      800,
      656 / 474,
    );

    expect(page).not.toBeNull();
    expect(innerTable).toBeNull();
  });

  it('rejects a page-sized candidate that does not reach the left page edge', () => {
    const shiftedTable = evaluateQuad(
      [
        { x: 150, y: 40 },
        { x: 590, y: 40 },
        { x: 590, y: 760 },
        { x: 150, y: 760 },
      ],
      600,
      800,
      656 / 474,
    );

    expect(shiftedTable).toBeNull();
  });

  it('rejects a degenerate four-point candidate', () => {
    expect(evaluateQuad(
      [
        { x: 40, y: 40 },
        { x: 560, y: 40 },
        { x: 40, y: 760 },
        { x: 40, y: 760 },
      ],
      600,
      800,
      656 / 474,
    )).toBeNull();
  });
});
