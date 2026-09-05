/**
 * Pure-TypeScript MNIST digit classifier.
 *
 * Zero dependencies, on purpose (Task/AGE_CLASSIFIER_BRIEF_2026-09-05.md #3,
 * #6): every serverless-bundling risk that ruled out `onnxruntime-node`,
 * `onnxruntime-web` and `@tensorflow/tfjs*` disappears if the ONNX Model Zoo
 * `mnist-12` graph is instead a few hundred lines of arithmetic over the
 * weights already decoded in `mnist12Weights.ts`. No `sharp`, no
 * `tesseract.js`, no image library -- the caller hands over raw grayscale
 * pixels and gets back a digit.
 *
 * The preprocessing below is deliberately literal against the pipeline
 * that produced the pilot numbers cited in the brief (MNIST-style ink
 * normalisation, bounding-box crop, aspect-preserving scale to a 20px
 * longest side, box-area-weighted downscale, centring, then a
 * centre-of-mass recentring by circular roll) -- changing the shape of any
 * step would invalidate that measurement.
 */

import { MNIST12_WEIGHTS } from './mnist12Weights';

const INK_THRESHOLD = 0.3;
const TARGET_LONGEST_SIDE = 20;
const CANVAS_SIZE = 28;
const CANVAS_CENTER = 14;

function decodeFloat32LE(base64: string): Float32Array {
  const buffer = Buffer.from(base64, 'base64');
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const count = buffer.byteLength / 4;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

// Decoded once at module load, per CLAUDE.md's "instrument before fixing"
// spirit applied here as "decode once, not per classification".
const conv1Weight = decodeFloat32LE(MNIST12_WEIGHTS.conv1Weight.base64); // [8,1,5,5]
const conv1Bias = decodeFloat32LE(MNIST12_WEIGHTS.conv1Bias.base64); // [8,1,1]
const conv2Weight = decodeFloat32LE(MNIST12_WEIGHTS.conv2Weight.base64); // [16,8,5,5]
const conv2Bias = decodeFloat32LE(MNIST12_WEIGHTS.conv2Bias.base64); // [16,1,1]
const denseWeight = decodeFloat32LE(MNIST12_WEIGHTS.denseWeight.base64); // [16,4,4,10] == [256,10]
const denseBias = decodeFloat32LE(MNIST12_WEIGHTS.denseBias.base64); // [1,10]

interface BoundingBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Bounding box of every pixel whose ink value exceeds `INK_THRESHOLD`, or null if none. */
function findInkBoundingBox(ink: Float32Array, width: number, height: number): BoundingBox | null {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (ink[rowOffset + x] > INK_THRESHOLD) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return right < left || bottom < top ? null : { left, right, top, bottom };
}

/**
 * Downscales (or upscales) `src` (h x w) to `nh` x `nw` by area-weighted box
 * averaging: each destination pixel is the ink-weighted mean of every source
 * pixel whose box overlaps its box, weighted by the overlap area.
 */
function boxAverageResize(src: Float32Array, h: number, w: number, nh: number, nw: number): Float32Array {
  const dst = new Float32Array(nh * nw);
  for (let iy = 0; iy < nh; iy++) {
    const y0 = (iy * h) / nh;
    const y1 = ((iy + 1) * h) / nh;
    const syStart = Math.max(0, Math.floor(y0));
    const syEnd = Math.min(h - 1, Math.ceil(y1) - 1);
    for (let ix = 0; ix < nw; ix++) {
      const x0 = (ix * w) / nw;
      const x1 = ((ix + 1) * w) / nw;
      const sxStart = Math.max(0, Math.floor(x0));
      const sxEnd = Math.min(w - 1, Math.ceil(x1) - 1);

      let weightedSum = 0;
      let areaSum = 0;
      for (let sy = syStart; sy <= syEnd; sy++) {
        const overlapY = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (overlapY <= 0) continue;
        for (let sx = sxStart; sx <= sxEnd; sx++) {
          const overlapX = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (overlapX <= 0) continue;
          const area = overlapY * overlapX;
          weightedSum += area * src[sy * w + sx];
          areaSum += area;
        }
      }
      dst[iy * nw + ix] = areaSum > 0 ? weightedSum / areaSum : 0;
    }
  }
  return dst;
}

/** `numpy.roll`-equivalent circular shift of a 2D array stored row-major. */
function circularRoll2D(data: Float32Array, h: number, w: number, dy: number, dx: number): Float32Array {
  const out = new Float32Array(h * w);
  const shiftY = ((dy % h) + h) % h;
  const shiftX = ((dx % w) + w) % w;
  for (let y = 0; y < h; y++) {
    const srcY = ((y - shiftY) % h + h) % h;
    for (let x = 0; x < w; x++) {
      const srcX = ((x - shiftX) % w + w) % w;
      out[y * w + x] = data[srcY * w + srcX];
    }
  }
  return out;
}

/**
 * The exact preprocessing pipeline from the order:
 *
 *   1. ink = (255 - gray) / 255
 *   2. bounding box of ink > 0.3 (null if empty)
 *   3. crop to that box
 *   4. scale so the longest side becomes 20
 *   5. box-area-weighted downscale to that size
 *   6. paste centred into a 28x28 zero canvas
 *   7. recentre by circular roll so the ink's centre of mass sits at (14,14)
 *
 * Returns a 28x28 row-major Float32Array, or null when there is no ink.
 */
export function preprocessDigitImage(
  gray: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array | null {
  if (width <= 0 || height <= 0 || gray.length < width * height) {
    return null;
  }

  const ink = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    ink[i] = (255 - gray[i]) / 255;
  }

  const box = findInkBoundingBox(ink, width, height);
  if (!box) {
    return null;
  }

  const h = box.bottom - box.top + 1;
  const w = box.right - box.left + 1;
  const crop = new Float32Array(h * w);
  for (let y = 0; y < h; y++) {
    const srcRow = (box.top + y) * width;
    for (let x = 0; x < w; x++) {
      crop[y * w + x] = ink[srcRow + box.left + x];
    }
  }

  const scale = TARGET_LONGEST_SIDE / Math.max(h, w);
  const nh = Math.max(1, Math.round(h * scale));
  const nw = Math.max(1, Math.round(w * scale));
  const resized = boxAverageResize(crop, h, w, nh, nw);

  const canvas = new Float32Array(CANVAS_SIZE * CANVAS_SIZE);
  const y0 = Math.floor((CANVAS_SIZE - nh) / 2);
  const x0 = Math.floor((CANVAS_SIZE - nw) / 2);
  for (let y = 0; y < nh; y++) {
    const dstRow = (y0 + y) * CANVAS_SIZE;
    const srcRow = y * nw;
    for (let x = 0; x < nw; x++) {
      canvas[dstRow + x0 + x] = resized[srcRow + x];
    }
  }

  let total = 0;
  let sumY = 0;
  let sumX = 0;
  for (let y = 0; y < CANVAS_SIZE; y++) {
    const rowOffset = y * CANVAS_SIZE;
    for (let x = 0; x < CANVAS_SIZE; x++) {
      const v = canvas[rowOffset + x];
      total += v;
      sumY += v * y;
      sumX += v * x;
    }
  }
  if (total <= 0) {
    return canvas;
  }

  const cy = sumY / total;
  const cx = sumX / total;
  const dy = Math.round(CANVAS_CENTER - cy);
  const dx = Math.round(CANVAS_CENTER - cx);
  return circularRoll2D(canvas, CANVAS_SIZE, CANVAS_SIZE, dy, dx);
}

/** 2D convolution, stride 1, `pad` zero-padding on every side, same spatial size when pad = (k-1)/2. */
function conv2dSamePad(
  input: Float32Array,
  inChannels: number,
  height: number,
  width: number,
  weight: Float32Array,
  bias: Float32Array,
  outChannels: number,
  kernel: number,
  pad: number,
): Float32Array {
  const out = new Float32Array(outChannels * height * width);
  for (let oc = 0; oc < outChannels; oc++) {
    const b = bias[oc];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = b;
        for (let ic = 0; ic < inChannels; ic++) {
          for (let ky = 0; ky < kernel; ky++) {
            const iy = y + ky - pad;
            if (iy < 0 || iy >= height) continue;
            for (let kx = 0; kx < kernel; kx++) {
              const ix = x + kx - pad;
              if (ix < 0 || ix >= width) continue;
              const wIndex = ((oc * inChannels + ic) * kernel + ky) * kernel + kx;
              const inIndex = (ic * height + iy) * width + ix;
              sum += weight[wIndex] * input[inIndex];
            }
          }
        }
        out[(oc * height + y) * width + x] = sum;
      }
    }
  }
  return out;
}

function reluInPlace(data: Float32Array): void {
  for (let i = 0; i < data.length; i++) {
    if (data[i] < 0) data[i] = 0;
  }
}

/** Max pooling, no padding. Output is channel-major, then row, then column -- same layout as the input. */
function maxPool2d(
  input: Float32Array,
  channels: number,
  height: number,
  width: number,
  pool: number,
  stride: number,
): { data: Float32Array; outHeight: number; outWidth: number } {
  const outHeight = Math.floor((height - pool) / stride) + 1;
  const outWidth = Math.floor((width - pool) / stride) + 1;
  const out = new Float32Array(channels * outHeight * outWidth);
  for (let c = 0; c < channels; c++) {
    for (let oy = 0; oy < outHeight; oy++) {
      for (let ox = 0; ox < outWidth; ox++) {
        let best = -Infinity;
        for (let py = 0; py < pool; py++) {
          const iy = oy * stride + py;
          for (let px = 0; px < pool; px++) {
            const ix = ox * stride + px;
            const v = input[(c * height + iy) * width + ix];
            if (v > best) best = v;
          }
        }
        out[(c * outHeight + oy) * outWidth + ox] = best;
      }
    }
  }
  return { data: out, outHeight, outWidth };
}

function softmax(logits: Float32Array): Float32Array {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > max) max = logits[i];
  }
  let sum = 0;
  const exp = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    const e = Math.exp(logits[i] - max);
    exp[i] = e;
    sum += e;
  }
  const out = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    out[i] = sum > 0 ? exp[i] / sum : 0;
  }
  return out;
}

/**
 * Runs the mnist-12 ONNX graph on an already-preprocessed 28x28 row-major
 * input (values in the model's own scale, i.e. exactly what
 * `preprocessDigitImage` returns). Exported separately from `classifyDigit`
 * so golden-parity tests can feed the fixture's tensor straight into the
 * network without going through image preprocessing again.
 *
 * Graph: Conv(5x5,8,pad2) -> ReLU -> MaxPool(2,stride2)
 *      -> Conv(5x5,16,pad2) -> ReLU -> MaxPool(3,stride3)
 *      -> flatten (C,H,W) -> Dense(256,10) -> Softmax.
 */
export function runMnist12Network(input: Float32Array): Float32Array {
  const c1 = conv2dSamePad(input, 1, 28, 28, conv1Weight, conv1Bias, 8, 5, 2);
  reluInPlace(c1);
  const p1 = maxPool2d(c1, 8, 28, 28, 2, 2); // 8x14x14

  const c2 = conv2dSamePad(p1.data, 8, p1.outHeight, p1.outWidth, conv2Weight, conv2Bias, 16, 5, 2);
  reluInPlace(c2);
  const p2 = maxPool2d(c2, 16, p1.outHeight, p1.outWidth, 3, 3); // 16x4x4

  // p2.data is already laid out (channel, row, col) row-major -- exactly the
  // flatten order the dense weight's original [16,4,4,10] shape assumes.
  const features = p2.data;
  const featureCount = features.length; // 256
  const outputs = denseBias.length; // 10
  const logits = new Float32Array(outputs);
  for (let o = 0; o < outputs; o++) {
    let sum = denseBias[o];
    for (let f = 0; f < featureCount; f++) {
      sum += features[f] * denseWeight[f * outputs + o];
    }
    logits[o] = sum;
  }

  return softmax(logits);
}

export interface DigitClassification {
  digit: number;
  confidence: number;
  margin: number;
}

/**
 * Classifies one handwritten digit from a grayscale bitmap (0 = ink, 255 =
 * paper, as `ocrTextLines.ts` renders its digit strokes). Returns null when
 * preprocessing found no ink to classify.
 */
export function classifyDigit(
  gray: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): DigitClassification | null {
  // The stroke bitmap must already be single-channel: width * height is a
  // structural fact about the buffer the caller decoded, not a heuristic, so
  // a mismatch can only mean a wiring bug upstream (e.g. an interleaved
  // multi-channel buffer passed through uninterpreted). That bug is silent
  // and expensive if swallowed here -- it reads as noisy misclassification
  // instead of a caught defect -- so this throws instead of returning null,
  // and callers must not catch it away.
  if (gray.length !== width * height) {
    throw new Error(
      `classifyDigit received a buffer of length ${gray.length}, but width * height = ${width} * ${height} = ${width * height} was expected. `
      + 'This buffer is not single-channel grayscale (a 3-channel RGB source, for example, would be width * height * 3).',
    );
  }

  const input = preprocessDigitImage(gray, width, height);
  if (!input) {
    return null;
  }

  const probabilities = runMnist12Network(input);
  let digit = 0;
  let best = probabilities[0];
  let second = -Infinity;
  for (let i = 1; i < probabilities.length; i++) {
    const p = probabilities[i];
    if (p > best) {
      second = best;
      digit = i;
      best = p;
    } else if (p > second) {
      second = p;
    }
  }
  if (second === -Infinity) second = 0;

  return { digit, confidence: best, margin: best - second };
}
