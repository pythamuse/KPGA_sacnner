import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  classifyDigit,
  preprocessDigitImage,
  runMnist12Network,
} from '../src/lib/recognition/mnist12';

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'mnist12', 'golden.json');

describe('runMnist12Network golden parity', () => {
  it('matches the reference softmax output within 1e-5 per element', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as {
      inputBase64: string;
      probabilities: number[];
    };

    const buffer = Buffer.from(golden.inputBase64, 'base64');
    expect(buffer.byteLength).toBe(28 * 28 * 4);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const input = new Float32Array(28 * 28);
    for (let i = 0; i < input.length; i++) {
      input[i] = view.getFloat32(i * 4, true);
    }

    const probabilities = runMnist12Network(input);
    expect(probabilities.length).toBe(golden.probabilities.length);

    let maxError = 0;
    for (let i = 0; i < probabilities.length; i++) {
      const error = Math.abs(probabilities[i] - golden.probabilities[i]);
      maxError = Math.max(maxError, error);
      expect(error).toBeLessThanOrEqual(1e-5);
    }
    // eslint-disable-next-line no-console
    console.info(`[mnist12] golden max element error = ${maxError.toExponential(3)}`);
  });
});

/** Builds a flat grayscale bitmap (255 = paper) with a filled rectangle of ink (0 = ink). */
function makeRectImage(width: number, height: number, rect: { left: number; top: number; right: number; bottom: number }): Uint8Array {
  const data = new Uint8Array(width * height).fill(255);
  for (let y = rect.top; y <= rect.bottom; y++) {
    for (let x = rect.left; x <= rect.right; x++) {
      data[y * width + x] = 0;
    }
  }
  return data;
}

describe('preprocessDigitImage', () => {
  it('returns null when the image carries no ink', () => {
    const blank = new Uint8Array(40 * 40).fill(255);
    expect(preprocessDigitImage(blank, 40, 40)).toBeNull();
  });

  it('centres a small ink rectangle regardless of where it sits in the source', () => {
    // A small square in the bottom-right corner of a big blank canvas.
    const width = 60;
    const height = 60;
    const image = makeRectImage(width, height, { left: 45, top: 45, right: 55, bottom: 55 });

    const result = preprocessDigitImage(image, width, height);
    expect(result).not.toBeNull();
    const canvas = result!;
    expect(canvas.length).toBe(28 * 28);

    // Mass should sit near the centre of the 28x28 canvas, not in a corner.
    let total = 0;
    let sumY = 0;
    let sumX = 0;
    for (let y = 0; y < 28; y++) {
      for (let x = 0; x < 28; x++) {
        const v = canvas[y * 28 + x];
        total += v;
        sumY += v * y;
        sumX += v * x;
      }
    }
    expect(total).toBeGreaterThan(0);
    const cy = sumY / total;
    const cx = sumX / total;
    expect(cy).toBeGreaterThan(11);
    expect(cy).toBeLessThan(17);
    expect(cx).toBeGreaterThan(11);
    expect(cx).toBeLessThan(17);
  });

  it('scales a crop whose longest side is height so the output height is 20px worth of mass', () => {
    // Tall thin rectangle: height 40, width 10 -> longest side is height.
    const width = 50;
    const height = 50;
    const image = makeRectImage(width, height, { left: 5, top: 5, right: 14, bottom: 44 });
    const result = preprocessDigitImage(image, width, height);
    expect(result).not.toBeNull();
    // Non-zero ink should appear across a vertical extent of about 20 rows
    // (allowing for centring/rounding), not the full 28.
    let minY = 28;
    let maxY = -1;
    const canvas = result!;
    for (let y = 0; y < 28; y++) {
      for (let x = 0; x < 28; x++) {
        if (canvas[y * 28 + x] > 0.01) {
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const span = maxY - minY + 1;
    expect(span).toBeGreaterThanOrEqual(18);
    expect(span).toBeLessThanOrEqual(22);
  });

  it('rejects malformed input dimensions', () => {
    expect(preprocessDigitImage(new Uint8Array(10), 5, 5)).toBeNull();
    expect(preprocessDigitImage(new Uint8Array(100), 0, 10)).toBeNull();
  });
});

describe('classifyDigit', () => {
  it('returns a digit 0-9 with confidence in [0,1] for a plausible stroke', () => {
    const width = 40;
    const height = 60;
    const image = makeRectImage(width, height, { left: 10, top: 10, right: 30, bottom: 50 });
    const result = classifyDigit(image, width, height);
    expect(result).not.toBeNull();
    expect(result!.digit).toBeGreaterThanOrEqual(0);
    expect(result!.digit).toBeLessThanOrEqual(9);
    expect(result!.confidence).toBeGreaterThanOrEqual(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
    expect(result!.margin).toBeGreaterThanOrEqual(0);
    expect(result!.margin).toBeLessThanOrEqual(1);
  });

  it('returns null for a blank image', () => {
    const blank = new Uint8Array(40 * 40).fill(255);
    expect(classifyDigit(blank, 40, 40)).toBeNull();
  });
});
