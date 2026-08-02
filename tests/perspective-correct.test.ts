import { describe, expect, it } from 'vitest';
import { orderQuadPoints, type Point } from '../src/lib/documentScanner/perspectiveCorrect';

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
