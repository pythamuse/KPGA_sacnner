import sharp from 'sharp';
import type { ImageAnalysisData } from './markDensity';

/**
 * Illumination flattening for the *geometry* stream only.
 *
 * A phone photo of a sheet carries the room's lighting: one corner of the
 * paper is two hundred grey levels darker than the other. Table rules are
 * found by counting pixels below a fixed dark threshold
 * (`DEFAULT_DARK_THRESHOLD = 200` in tableGridDetection), so on the shaded
 * side the paper itself falls under the threshold and the rule pattern
 * disappears into a uniform dark field. Dividing the image by a heavily
 * blurred copy of itself removes that low-frequency term and leaves the
 * print.
 *
 * ## What this is not allowed to touch
 *
 * The flattened buffer is geometry input and nothing else. Central
 * measurement ran the scorer on flattened pixels and `CORRECT` collapsed to
 * about 1 — the normalisation destroys exactly the small ink/paper
 * differences the mark scorer measures against the blank-form baseline. This
 * module therefore returns a *copy*; the caller keeps the raw buffer and
 * every ink measurement continues to read it
 * (Task/EXTERNAL_ADOPTION_PLAN_2026-08-27.md §3.4,
 * Task/FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27.md §9.2 row V-C).
 *
 * Server-only, like `markDensity`: it uses `sharp`.
 */

/**
 * Background scale: sigma = round(min(width, height) / 16).
 *
 * Provenance — central measurement, not measured here. On the 19
 * ORB-registered photo sheets this divisor gave 131 detected grid fields
 * against 102 on the raw pixels, and the total was reported robust across
 * divisors from /8 to /32 (Task/EXTERNAL_ADOPTION_PLAN_2026-08-27.md §3.4).
 * The scale has to stay well above the printed structure — at a 1422px page
 * width, /16 is a ~89px radius, an order of magnitude larger than the row
 * pitch — so that the blur estimates the lighting and not the table.
 */
export const FLATTEN_SIGMA_DIVISOR = 16;

/**
 * Paper is mapped to 235, not 255.
 *
 * Provenance — the same measurement run as the divisor above; the two
 * constants were measured together and only the pair has evidence behind it.
 * The headroom matters for the same reason the divisor does: at 255 every
 * pixel at or above its local background saturates to white, and the faint
 * printed rules that sit only a few levels below their background — which are
 * precisely the ones the raw stream is losing — saturate with it. At 235 they
 * survive as values under the detector's dark threshold.
 */
export const FLATTEN_TARGET_PAPER_LEVEL = 235;

/** `sharp`'s smallest accepted blur sigma. */
const MIN_BLUR_SIGMA = 0.3;

export type FlattenSourceImage = Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>;

export function resolveFlattenSigma(width: number, height: number): number {
  return Math.max(MIN_BLUR_SIGMA, Math.round(Math.min(width, height) / FLATTEN_SIGMA_DIVISOR));
}

/**
 * Returns a new grayscale buffer; the input buffer is never written to.
 */
export async function flattenIllumination(image: FlattenSourceImage): Promise<Buffer> {
  const { width, height, pixels } = image;
  const pixelCount = width * height;

  if (width <= 0 || height <= 0 || pixels.length < pixelCount) {
    throw new Error('평탄화할 이미지 픽셀 수가 크기와 맞지 않습니다.');
  }

  const gray = pixels.length === pixelCount ? pixels : pixels.subarray(0, pixelCount);
  // `toColourspace('b-w')` is load-bearing, not tidiness. Without it sharp
  // hands back a three-channel sRGB buffer for a one-channel raw input
  // (measured: 460800 bytes for a 320x480 page), and reading that as
  // grayscale silently samples the wrong pixel for every position -- the
  // background then keeps most of the lighting it was supposed to remove.
  const background = await sharp(gray, { raw: { width, height, channels: 1 } })
    .blur(resolveFlattenSigma(width, height))
    .toColourspace('b-w')
    .raw()
    .toBuffer();

  if (background.length !== pixelCount) {
    throw new Error(`배경 추정 결과가 1채널이 아닙니다(${background.length}/${pixelCount}).`);
  }

  const flattened = Buffer.allocUnsafe(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    // max(background, 1): the divisor is a blurred value, so it only reaches 0
    // where a whole neighbourhood is black. Clamping to 1 keeps that region
    // black instead of turning it into NaN/Infinity.
    const value = Math.round((gray[index] / Math.max(background[index], 1)) * FLATTEN_TARGET_PAPER_LEVEL);
    flattened[index] = value < 0 ? 0 : value > 255 ? 255 : value;
  }

  return flattened;
}

/**
 * The same image with flattened pixels swapped in.
 *
 * Everything except `pixels` is carried over by reference, deliberately:
 * `contentBounds`, `pageBounds` and the registration verdict were derived from
 * the raw pixels and are already proven by the F1 measurement. Re-deriving
 * them from a normalised copy would put the geometry stream on a different
 * coordinate system than the scorer, which is the one thing the two-stream
 * design must not do.
 */
export async function buildFlattenedGeometryImage(image: ImageAnalysisData): Promise<ImageAnalysisData> {
  return { ...image, pixels: await flattenIllumination(image) };
}
