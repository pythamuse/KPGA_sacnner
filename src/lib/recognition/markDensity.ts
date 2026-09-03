import sharp from 'sharp';
import { ChoiceGroup, NormalizedRect } from './roiTemplates';
import {
  BASELINE_ALIGNMENT_RADIUS,
  HIGH_ABSOLUTE_SIGNAL,
  HIGH_RELATIVE_CONTRAST,
  PHOTO_BINARY_FLOOR,
  STRUCTURED_MARK_MIN_COMPONENT,
  STRUCTURED_MARK_MIN_COMPONENT_RATIO,
  STRUCTURED_MARK_MIN_DIAGONAL_RATIO,
} from './markDensityConstants';

export type ContentBoundsSource = 'frame' | 'paper' | 'template' | 'dark';

export interface ImageAnalysisData {
  /**
   * Why the template registration frame was not applied, when it was not.
   *
   * The blank asset resolves its content bounds through the template path and
   * the uploads resolve theirs through the paper path, so the subtraction
   * normalises the two images through frames measured two different ways. Both
   * go through `applyTemplateRegistrationFrame`, so on the uploads it is
   * declining, and it used to decline silently. This names the guard that
   * refused and the numbers it refused on.
   */
  contentBoundsRejection?: string;
  width: number;
  height: number;
  pixels: Buffer;
  contentBounds?: PixelBounds;
  contentBoundsSource?: ContentBoundsSource;
  pageBounds?: PixelBounds;
  /** Brightness threshold selected from this image for paper detection. */
  paperBoundsThreshold?: number;
  contentBoundsConfident: boolean;
  /** Whole-page quality measurements kept for the offline training export. */
  pageInkRatio?: number;
  pageIsBinarySource?: boolean;
}

export interface PixelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PixelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CandidateScore {
  value: number | string;
  score: number;
}

/**
 * Candidate-level measurements used by the offline label exporter.
 *
 * These are observations made after the existing scoring calculation. They
 * are deliberately separate from CandidateScore so the review response keeps
 * its existing small candidate shape.
 */
export interface CandidateMeasurement {
  candidateIndex: number;
  score: number;
  actualInk: number | null;
  baselineInk: number | null;
  brightnessOffset: number | null;
  alignX: number | null;
  alignY: number | null;
  largestComponentSize: number | null;
  largestComponentRatio: number | null;
  diagonalRatio: number | null;
}

export interface DecisionEvidence {
  outcome: 'auto' | 'refused' | 'contested';
  winner?: { index: number; label?: string; score: number };
  runnerUp?: { index: number; score: number };
  gap?: number;
  relativeContrast?: number;
  /**
   * Present on the scorer result with the exact thresholds used by the gate.
   * Review-session transport may omit the JSON key to keep each field below
   * the storage budget; `src/lib/review/evidence.ts` uses the same shared
   * constants then.
   */
  thresholds: { score: number; gap: number; contrast: number };
  /** Present only when the opt-in grayscale-scan calibration was applied. */
  inputClass?: InputClass;
  gain?: number;
  margin?: number;
  ratio?: number;
  refused: string[];
  offset?: { x: number; y: number };
  shape?: { componentRatio: number; diagonalRatio: number };
  contested: boolean;
}

export interface ChoiceGroupResult {
  field: string;
  value?: number | string;
  confidence: 'high' | 'medium' | 'low';
  contested: boolean;
  candidates: CandidateScore[];
  /** Internal measurement outlet; removed before the API response is built. */
  candidateMeasurements?: CandidateMeasurement[];
  evidence?: DecisionEvidence;
  /**
   * Which box the two independent rankings both put first, on a group that is
   * being left for review. Never a value: see `selectReviewSuggestion`.
   */
  suggestion?: ReviewSuggestion;
  /**
   * Why this group landed where it did, as numbers and fixed labels only. See
   * `describeDecision`. Nothing in this string comes from the scanned page
   * except scores, so a student's answers cannot travel through it.
   */
  decision: string;
}

/** 근거: FIELD_TEST §29 (2026-08-29). 세 세트 1,053칸에서 배지 137개로 오답 12/18
 * 커버(무작위 p99=6). 취소 X 오답 10/10 포함. 값·신뢰도·빈칸 수는 절대 바꾸지 않는다. */
export const CONTESTED_RUNNERUP_MSCORE = 0.01;

/**
 * A contested badge is possible only for a confirmed high-confidence group
 * with an actual runner-up score. Missing and non-finite measurements are
 * treated as no signal.
 */
export function isContestedRunnerUp(
  confidence: ChoiceGroupResult['confidence'],
  matchedScore: number | undefined,
  hasRunnerUp: boolean,
): boolean {
  return confidence === 'high'
    && hasRunnerUp
    && matchedScore !== undefined
    && Number.isFinite(matchedScore)
    && matchedScore >= CONTESTED_RUNNERUP_MSCORE;
}

/** Which box to offer the reviewer as a default. Never a value. */
export interface ReviewSuggestion {
  candidateIndex: number;
  value: number | string;
}

/**
 * One candidate's two ranking features, as the rule reads them.
 *
 * `matchedScore` is whatever `calculateMatchedScore` returned for this box —
 * the same helper the contested badge and the trace share. There is no second
 * definition of it anywhere, which is the property §29.5 records as the reason
 * the badge's offline prediction transferred to production unchanged.
 */
export interface ReviewSuggestionFeatures {
  candidateIndex: number;
  value: number | string;
  /** `actualInk - baselineInk`: how much darker this box is than the blank form. */
  pageMinusBlank: number | undefined;
  matchedScore: number | undefined;
}

export type InputClass = 'bilevel-scan' | 'grayscale-scan' | 'photo';

/** The page-level calibration used by the opt-in grayscale residual path. */
export interface PageInkCalibration {
  inputClass: 'grayscale-scan';
  ratio: number;
  gain: number;
  margin: number;
}

/** Set 1's measured page/blank median, used as the bilevel reference. */
export const R_BILEVEL = 0.73;
// Pages whose printed structure is at least this fraction of the blank asset's
// are treated as bilevel scans (set 1 measured 0.73; grayscale device 0.41-0.57).
const GRAY_CLASS_MAX_RATIO = 0.62;
const GRAY_GAIN_MIN = 0.3;
const GRAY_GAIN_MAX = 1.0;
const GRAY_MARGIN_MIN = 0.03;
const GRAY_MARGIN_MAX = 0.08;

/**
 * The reviewer's default on a group the scorer refused.
 *
 * 근거: FIELD_TEST §31 (2026-09-02) + 중앙 측정. 세 세트 거절 192그룹(우연 32%)에서
 * `pageMinusBlank` 단독 1위 적중 76.6%, `matchedScore` 단독 1위 76.8%. 두 특징이
 * **서로 독립적으로 같은 상자를** 1위로 꼽은 159그룹에서 83.0%
 * (세트별 76.7% / 90.7% / 80.6%).
 *
 * 83%는 자동 입력 기준에 **미달이다** — §31.3이 정확히 그것을 기각했다. 17%는
 * 사람이 확인한 것처럼 저장되는 오답이 되고 `WRONG = 0`이 그것을 금지한다. 그래서
 * 이 함수의 결과는 값이 아니라 **검수자가 확인하는 기본 선택지**로만 흐른다:
 * 값·신뢰도·빈칸 수 어느 것도 이것을 읽지 않는다.
 *
 * Silence is the default. Where either ranking has a tie at the top, where the
 * two rankings disagree, or where any box is missing either feature, there is
 * no suggestion at all — the measured 83% is a property of the agreement, and a
 * guess made without it is not the thing that was measured.
 */
export function selectReviewSuggestion(
  features: ReviewSuggestionFeatures[],
): ReviewSuggestion | undefined {
  // A one-box group has nothing to rank: whichever box exists is trivially
  // first on both features, and "both agree" would mean nothing.
  if (features.length < 2) return undefined;
  const byInk = strictlyFirstBy(features, (feature) => feature.pageMinusBlank);
  if (!byInk) return undefined;
  const byMatchedScore = strictlyFirstBy(features, (feature) => feature.matchedScore);
  if (!byMatchedScore) return undefined;
  if (byInk.candidateIndex !== byMatchedScore.candidateIndex) return undefined;
  return { candidateIndex: byInk.candidateIndex, value: byInk.value };
}

/**
 * The single highest candidate on one feature, or nothing.
 *
 * Returns undefined on a tie at the top and on any missing or non-finite
 * reading, so a ranking is either complete and strict or it does not exist.
 */
function strictlyFirstBy(
  features: ReviewSuggestionFeatures[],
  read: (feature: ReviewSuggestionFeatures) => number | undefined,
): ReviewSuggestionFeatures | undefined {
  let leader: ReviewSuggestionFeatures | undefined;
  let leadingValue = Number.NEGATIVE_INFINITY;
  let tiedAtTop = false;
  for (const feature of features) {
    const value = read(feature);
    if (value === undefined || !Number.isFinite(value)) return undefined;
    if (value > leadingValue) {
      leadingValue = value;
      leader = feature;
      tiedAtTop = false;
    } else if (value === leadingValue) {
      tiedAtTop = true;
    }
  }
  return tiedAtTop ? undefined : leader;
}

export interface ChoiceGroupBaseline {
  image: ImageAnalysisData;
  candidatePixelOverrides: PixelRect[];
  /** Shared by every group on a page; absent for legacy/direct callers. */
  pageCalibration?: PageInkCalibration;
}

interface TemplateInkShape {
  largestComponentSize: number;
  largestComponentRatio: number;
  diagonalRatio: number;
}

interface ResidualEdges {
  /** Share of the disagreement carried by samples sitting on a printed edge. */
  edgeShare: number;
  /** Share of samples that are on a printed edge. */
  edgeFraction: number;
}

interface TemplateInkFeatures extends TemplateInkShape {
  /**
   * The differential score this cell is decided on, after the total-ink
   * invariant. Equal to `residualScore` unless `inkInvariantZeroed`, in which
   * case it is 0. See `TEMPLATE_INK_INVARIANT_EPSILON`.
   */
  score: number;
  /**
   * The mean clipped residual as it was summed, before the invariant. Kept
   * because the invariant must be able to remove a value without widening any
   * other candidate's margin: `analyzeChoiceGroup` ranks and computes `gap`
   * and `relativeContrast` off this, so zeroing one box can only ever lower a
   * threshold's input, never raise one.
   */
  residualScore: number;
  /**
   * True when the invariant applied, i.e. this box's aggregate page ink did
   * not exceed the blank form's. Vacuously true for a box whose residual was
   * already 0.
   */
  inkInvariantZeroed: boolean;
  /** Mean darkness of the uploaded cell, after brightness normalisation. */
  actualInk: number;
  /** Mean darkness of the same cell on the blank form. */
  baselineInk: number;
  brightnessOffset: number;
  /**
   * Which tonal correction this cell was measured through, as `ToneCorrection`
   * labelled it. `linear(...)` is the shift every sheet had before 2026-08-27
   * and is still what every scan takes; `affine(...)` is the photo-only
   * two-point map. Carried per cell rather than per group even though the map
   * is a group decision, because that is what makes "every box of this group
   * was measured the same way" a readable fact rather than an assumption.
   */
  tone: string;
  alignX: number;
  alignY: number;
  /**
   * Source pixels per sample, for the page and for the blank form. The
   * alignment search moves in whole samples, so these say how far it can
   * physically reach: a cell whose pitch is below 1 cannot have a
   * one-pixel registration error corrected at all.
   */
  pagePitchX: number;
  pagePitchY: number;
  blankPitchX: number;
  blankPitchY: number;
  /** The reach the search was actually given for this cell, per axis. */
  radiusX: number;
  radiusY: number;
  /** Steps per sample the offset was resolved to, per axis. */
  stepsX: number;
  stepsY: number;
  /** Mean disagreement per sample once the baseline was placed. */
  fit: number;
  /**
   * Where the leftover disagreement sits, measured on every cell rather than
   * only while tracing.
   *
   * `analyzeResidualComposition` has computed this for a while behind the trace
   * flag and nothing read it back. Measured over three scans of one stack it
   * carries what the four thresholds are missing: leave-one-student-out, a rule
   * over these two and the runner-up's fit recovers cells the gate refuses
   * without admitting a wrong value, where the gate's own features recover none
   * (§35, §36). This is the cheap half of that function -- no softening, no
   * matched score -- so it can run on every cell.
   */
  edges: ResidualEdges;
  /** Brightness-reference alternatives, measured only while tracing. */
  brightnessProbe?: BrightnessReferenceProbe;
  /** The inset 8x8 residual used by the direct checkbox gate, measured only while tracing. */
  insetSignal?: number;
  /** Where a much wider search would have gone. Only measured while tracing. */
  probe?: { x: number; y: number; fit: number; chosenFit: number; radius: number };
  /** What the leftover disagreement is made of. Only measured while tracing. */
  composition?: ResidualComposition;
  /**
   * Lazy input for the one runner-up matched-score measurement. Keeping the
   * input here lets ranking finish before this expensive signal is requested,
   * while the trace and badge still share the same calculation helper.
   */
  matchedScoreInput?: MatchedScoreInput;
  /**
   * Where the *printed* ink sits inside this cell on the blank form. Only
   * measured while tracing.
   *
   * This is the property that separates the two ways these forms are marked,
   * without naming a field. A basic-info checkbox is an empty printed square,
   * so its ink is all perimeter and a hand check lands in the middle. A CAGI
   * or satisfaction cell holds a printed glyph, so its ink is central and the
   * hand circle is drawn around the outside. Weighting the centre helps the
   * first and actively hurts the second, which is how a centre-weighted score
   * once turned CORRECT 108 into 101 with three wrong answers.
   */
  blankGeometry?: BlankInkGeometry;
}

interface BrightnessReferenceProbe {
  actualP82: number;
  blankP82: number;
  actualP95: number;
  blankP95: number;
  offset95: number;
  score95: number;
}

interface ScoredCandidate extends CandidateScore {
  /**
   * `score` before the total-ink invariant zeroed it, and identical to `score`
   * for every box the invariant did not touch -- including every box on the
   * raw-density path, which has no baseline and therefore no invariant.
   *
   * Ranking and the two margin tests read this rather than `score` so that
   * removing one box's signal cannot hand another box a wider gap than it
   * earned. See `TEMPLATE_INK_INVARIANT_EPSILON`.
   */
  residualScore: number;
  shape?: TemplateInkFeatures;
  candidateIndex: number;
  /** Position in the group as the template lists it, 1-based, before sorting. */
  position: number;
  /**
   * Where the cell sits across the content envelope, 0 at the left edge and 1
   * at the right. A normalisation that disagrees about the page's width puts
   * the baseline further out of place the further from the anchored edge a
   * cell sits, so a fit that worsens with this is that error showing.
   */
  atX: number;
}

/**
 * How far the best option must outscore the runner-up, as a multiple, before a
 * baseline-backed group may be confirmed automatically. See `analyzeChoiceGroup`
 * for why an absolute gap cannot carry this decision.
 */
export { HIGH_RELATIVE_CONTRAST };

/**
 * Minimum residual ink a baseline-backed option must carry before it may be
 * confirmed at all. Chosen as the lowest value that removes the measured wrong
 * answer (its winning score was 0.0200) while costing the fewest correct ones:
 * 0.021 gives CORRECT 102 WRONG 0, where 0.023 drops to 99 and 0.026 to 97.
 */
export { HIGH_ABSOLUTE_SIGNAL };

/**
 * PROVISIONAL, and cut through a mixed distribution. The same minimum for a
 * two-candidate group on a sheet that came in as a photo.
 *
 * `Task/FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27.md` §9.1(b) read every
 * automatic acceptance the binary questions (q02-q06) produced over the 19
 * photo sheets. There were six, and their winning scores interleave:
 *
 *     CORRECT: 0.029 / 0.035 / 0.067
 *     WRONG:   0.025 / 0.027 / 0.032
 *
 * There is no clean cut. 0.042 buys all three wrong values -- 1.3x clear of the
 * highest of them -- at the price of the 0.029 and 0.035 correct ones, keeping
 * only 0.067. `WRONG = 0` outranking correct count is what justifies that
 * trade, not the separation, because there is none.
 *
 * n = 6. That is too few to fit a threshold on and this one is not fitted; it
 * is placed between the highest wrong reading and the surviving correct one.
 * Re-examine it on the next sample (M6) rather than treating it as settled.
 *
 * Photo sheets only, and two candidates only: a binary question has no third
 * option to be outscored, so the relative-contrast test that carries the
 * multi-choice groups has the least to work with exactly here.
 *
 * SUPERSEDED, NOT REMOVED (2026-08-27, spec §14.1). The outright refusal below
 * (`photoBinaryRefusalEnabled`) covers exactly the same set -- photo
 * provenance, two candidates -- and returns before any route that can produce
 * a value, so this floor no longer decides anything while the refusal is on.
 * It is kept for two reasons: `PHOTO_BINARY_REFUSAL=0` puts it straight back
 * in charge for a measurement run, and if the refusal is ever narrowed (to one
 * template, to one field, to the affine tone map only) the groups it stops
 * covering land back on this floor rather than on the base one. The floor
 * still prints in the decision trace -- `floor=`/`med-floor=` are cut against
 * it and `photo-binary-floor` is still named when it would have refused -- so
 * a trace run can still read what it was costing.
 */
export { PHOTO_BINARY_FLOOR };

/**
 * Whether a two-candidate group on a photo sheet is refused outright.
 *
 * Default ON. This is a tightening: it can only remove values, never add one,
 * so the safe state is enabled and the flag exists to take it away, which is
 * the opposite polarity from `MARK_AFFINE_TONE` (a signal change, default off
 * until it is shown to pay). Set `PHOTO_BINARY_REFUSAL=0` (or `false`/`off`)
 * to measure with the binary questions auto-filling as they do today; anything
 * else, including unset, leaves the refusal armed.
 *
 * Central measurement wants the pair: the refusal's cost is the binary cells
 * it gives up, and that number is only readable by running both ways over the
 * same sheets. Where `process` does not exist at all the refusal is on --
 * a missing environment is not a reason to loosen a gate.
 */
function photoBinaryRefusalEnabled(): boolean {
  if (typeof process === 'undefined') return true;
  const raw = process.env?.PHOTO_BINARY_REFUSAL;
  if (typeof raw !== 'string') return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === '0' || normalized === 'false' || normalized === 'off');
}

function grayClassEnabled(): boolean {
  // Default on since 2026-09-03 (Task/GRAYSCALE_CLASS_2026-09-03.md §5);
  // GRAY_CLASS=0 restores the uncalibrated subtraction for comparison runs.
  return typeof process === 'undefined' || process.env?.GRAY_CLASS !== '0';
}

function classifyInputClass(
  image: Pick<ImageAnalysisData, 'pageIsBinarySource'>,
  photoProvenance: boolean,
): InputClass {
  if (photoProvenance) return 'photo';
  return image.pageIsBinarySource === false ? 'grayscale-scan' : 'bilevel-scan';
}

/**
 * The shape a residual has to have before it counts as a pen mark rather than
 * leftover print. Hoisted from `hasStructuredTemplateMark` so the decision
 * trace can report each sub-test against the value it was actually compared
 * with; the values are unchanged.
 */
export {
  STRUCTURED_MARK_MIN_COMPONENT,
  STRUCTURED_MARK_MIN_COMPONENT_RATIO,
  STRUCTURED_MARK_MIN_DIAGONAL_RATIO,
};

export async function loadImageAnalysisData(filePath: string): Promise<ImageAnalysisData> {
  const { data: pixels, info } = await sharp(filePath)
    .rotate()
    .flatten({ background: '#ffffff' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  if (width <= 0 || height <= 0) {
    throw new Error('이미지 크기를 읽을 수 없습니다.');
  }

  const image = { width, height, pixels };
  const paperDetection = detectPaperBoundsWithDiagnostics(image);
  const pageBounds = paperDetection.bounds;
  // A dark printed border can split an otherwise white scan into separate
  // bright components. In that case the largest bright component is the
  // *inside* of the form, and searching only inside it hides the actual outer
  // frame. Retry against the full bitmap before falling back to dark-pixel
  // bounds. The frame validator still rejects internal response tables.
  const frameBounds = detectFrameBounds(image, pageBounds || undefined)
    || (pageBounds ? detectFrameBounds(image) : null);
  const paperContentBounds = pageBounds
    ? detectPaperContentBounds(image, pageBounds)
    : null;
  const darkBounds = detectDarkPixelBounds(image);

  // A form can contain several large internal tables. The whole printed
  // envelope inside the detected sheet is the stable template coordinate
  // system; an internal table frame is only a fallback when that envelope
  // cannot be measured.
  const contentBounds = paperContentBounds || frameBounds || darkBounds;
  const contentBoundsSource: ContentBoundsSource = paperContentBounds
    ? 'paper'
    : frameBounds
      ? 'frame'
      : 'dark';
  const pageQuality = calculatePageQuality(pixels);

  return {
    width,
    height,
    pixels,
    contentBounds,
    contentBoundsSource,
    pageBounds: pageBounds || undefined,
    paperBoundsThreshold: paperDetection.threshold,
    contentBoundsConfident: paperContentBounds !== null || frameBounds !== null,
    ...pageQuality,
  };
}

/**
 * Measures the submitted raster without changing any recognition input.
 * `sharp` has already flattened and grayscaled the source here, so the
 * intermediate-pixel ratio is the quality signal available to the server for
 * deciding whether the source was effectively bilevel.
 */
function calculatePageQuality(pixels: Buffer): {
  pageInkRatio: number;
  pageIsBinarySource: boolean;
} {
  if (pixels.length === 0) {
    return { pageInkRatio: 0, pageIsBinarySource: true };
  }

  let inkPixels = 0;
  let intermediatePixels = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    const pixel = pixels[index];
    if (pixel < 200) inkPixels += 1;
    if (pixel !== 0 && pixel !== 255) intermediatePixels += 1;
  }

  const intermediateRatio = intermediatePixels / pixels.length;
  return {
    pageInkRatio: inkPixels / pixels.length,
    // A small amount of anti-aliasing/compression residue is still compatible
    // with a scanned 1-bit source. The ratio, rather than a single pixel,
    // keeps the quality flag stable on real uploaded pages.
    pageIsBinarySource: intermediateRatio <= 0.01,
  };
}

/**
 * Registers a known form to the measured printed-content frame of its blank
 * template. The raw dark-pixel envelope remains useful for diagnostics, but
 * phone-photo shadows and objects on the sheet must not redefine the
 * coordinate system used by a known form.
 */
export function applyTemplateRegistrationFrame(
  image: ImageAnalysisData,
  registrationFrame?: NormalizedRect,
): ImageAnalysisData {
  if (!registrationFrame) {
    return { ...image, contentBoundsRejection: 'no-registration-frame' };
  }
  if (!image.pageBounds) {
    return { ...image, contentBoundsRejection: 'no-page-bounds' };
  }
  if (!isPlausiblePaperBounds(image, image.pageBounds)) {
    const page = image.pageBounds;
    const pw = (page.right - page.left) / image.width;
    const ph = (page.bottom - page.top) / image.height;
    const ar = (page.bottom - page.top) / Math.max(page.right - page.left, 1);
    return {
      ...image,
      contentBoundsRejection: `implausible-page(w=${pw.toFixed(3)}/0.550`
        + ` h=${ph.toFixed(3)}/0.620 ar=${ar.toFixed(3)}/[1.05,1.90])`,
    };
  }

  const page = image.pageBounds;
  const pageWidth = page.right - page.left;
  const pageHeight = page.bottom - page.top;
  const contentBounds: PixelBounds = {
    left: clamp(Math.round(page.left + registrationFrame.x * pageWidth), 0, image.width - 1),
    top: clamp(Math.round(page.top + registrationFrame.y * pageHeight), 0, image.height - 1),
    right: clamp(Math.round(page.left + (registrationFrame.x + registrationFrame.width) * pageWidth), 1, image.width),
    bottom: clamp(Math.round(page.top + (registrationFrame.y + registrationFrame.height) * pageHeight), 1, image.height),
  };

  if (contentBounds.right <= contentBounds.left + 1 || contentBounds.bottom <= contentBounds.top + 1) {
    return { ...image, contentBoundsRejection: 'degenerate-frame' };
  }
  if (!isPlausibleTemplateContentBounds(page, contentBounds)) {
    const cw = (contentBounds.right - contentBounds.left) / Math.max(page.right - page.left, 1);
    const ch = (contentBounds.bottom - contentBounds.top) / Math.max(page.bottom - page.top, 1);
    const ar = (contentBounds.bottom - contentBounds.top)
      / Math.max(contentBounds.right - contentBounds.left, 1);
    const inside = contentBounds.left >= page.left && contentBounds.top >= page.top
      && contentBounds.right <= page.right && contentBounds.bottom <= page.bottom;
    return {
      ...image,
      contentBoundsRejection: `implausible-frame(inside=${inside ? 1 : 0}`
        + ` w=${cw.toFixed(3)}/0.550 h=${ch.toFixed(3)}/0.550`
        + ` ar=${ar.toFixed(3)}/[1.05,1.95])`,
    };
  }

  return {
    ...image,
    contentBounds,
    contentBoundsSource: 'template',
    contentBoundsConfident: true,
    contentBoundsRejection: undefined,
  };
}

export function calculateDarkPixelDensity(
  image: ImageAnalysisData,
  normalizedRect: NormalizedRect,
  darkThreshold = 150,
  yOverride?: { top: number; bottom: number },
  pixelOverride?: PixelRect,
): number {
  const bounds = getRegistrationBounds(image);
  const baseWidth = bounds.right - bounds.left;
  const baseHeight = bounds.bottom - bounds.top;
  const left = clamp(
    Math.floor(pixelOverride ? pixelOverride.left : bounds.left + normalizedRect.x * baseWidth),
    0,
    image.width - 1,
  );
  const top = clamp(
    Math.floor(pixelOverride ? pixelOverride.top : yOverride ? yOverride.top : bounds.top + normalizedRect.y * baseHeight),
    0,
    image.height - 1,
  );
  const right = clamp(
    Math.ceil(pixelOverride ? pixelOverride.right : bounds.left + (normalizedRect.x + normalizedRect.width) * baseWidth),
    left + 1,
    image.width,
  );
  const bottom = clamp(
    Math.ceil(pixelOverride ? pixelOverride.bottom : yOverride ? yOverride.bottom : bounds.top + (normalizedRect.y + normalizedRect.height) * baseHeight),
    top + 1,
    image.height,
  );

  let darkPixels = 0;
  let totalPixels = 0;

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const value = image.pixels[y * image.width + x];
      if (value < darkThreshold) {
        darkPixels++;
      }
      totalPixels++;
    }
  }

  return totalPixels === 0 ? 0 : darkPixels / totalPixels;
}

export function detectContentBounds(image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>): PixelBounds {
  const pageBounds = detectPaperBounds(image);
  const paperContentBounds = pageBounds
    ? detectPaperContentBounds(image, pageBounds)
    : null;
  if (paperContentBounds) {
    return paperContentBounds;
  }

  const frameBounds = detectFrameBounds(image, pageBounds || undefined);
  if (frameBounds) {
    return frameBounds;
  }

  return detectDarkPixelBounds(image);
}

const PAPER_BOUNDS_SCAN_THRESHOLD = 195;
const PAPER_BOUNDS_BINARY_INTERMEDIATE_RATIO = 0.01;
const PAPER_BOUNDS_MIN_GROUP_SEPARATION = 8;

interface PaperBoundsSampling {
  sampleWidth: number;
  sampleHeight: number;
  stepX: number;
  stepY: number;
}

interface PaperBoundsDetection {
  bounds: PixelBounds | null;
  threshold: number;
}

/**
 * Chooses the paper mask threshold from the observed luminance distribution.
 *
 * Otsu's split identifies the two populated sides of the histogram. The mask
 * threshold is the midpoint of those sides' means rather than Otsu's split
 * itself: for two narrow modes this puts the boundary between the desk and
 * paper even when the paper mode is below the old absolute 170 cutoff.
 *
 * A nearly binary white image is the scan path. Its threshold is deliberately
 * pinned to the old 195 value, because changing it cannot improve a 0/255
 * mask and could change which antialiased edge pixels are included.
 */
export function derivePaperBoundsThreshold(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
): number {
  const sampling = getPaperBoundsSampling(image);
  return derivePaperBoundsThresholdFromHistogram(buildPaperBoundsHistogram(image, sampling));
}

function detectPaperBoundsWithDiagnostics(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
): PaperBoundsDetection {
  const sampling = getPaperBoundsSampling(image);
  const threshold = derivePaperBoundsThresholdFromHistogram(buildPaperBoundsHistogram(image, sampling));
  const { sampleWidth, sampleHeight, stepX, stepY } = sampling;

  let bestCandidate: PixelBounds | null = null;

  const component = findLargestBrightComponent(
    image,
    sampleWidth,
    sampleHeight,
    stepX,
    stepY,
    threshold,
  );
  if (component) {
    const bounds = {
      left: clamp(Math.floor(component.left * stepX), 0, image.width - 1),
      top: clamp(Math.floor(component.top * stepY), 0, image.height - 1),
      right: clamp(Math.ceil(component.right * stepX), 1, image.width),
      bottom: clamp(Math.ceil(component.bottom * stepY), 1, image.height),
    };

    if (isPlausiblePaperBounds(image, bounds)) {
      bestCandidate = bounds;
    }
  }

  return { bounds: bestCandidate, threshold };
}

/**
 * Finds the bright sheet before looking for printed ink. Phone photos often
 * include a dark desk, cable, or shadow that must never become part of the
 * normalized document coordinate system.
 */
export function detectPaperBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
): PixelBounds | null {
  return detectPaperBoundsWithDiagnostics(image).bounds;
}

function getPaperBoundsSampling(
  image: Pick<ImageAnalysisData, 'width' | 'height'>,
): PaperBoundsSampling {
  const sampleWidth = Math.min(360, Math.max(1, Math.ceil(image.width / 8)));
  const sampleHeight = Math.min(520, Math.max(1, Math.ceil(image.height / 8)));
  return {
    sampleWidth,
    sampleHeight,
    stepX: image.width / sampleWidth,
    stepY: image.height / sampleHeight,
  };
}

function buildPaperBoundsHistogram(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  sampling: PaperBoundsSampling,
): Uint32Array {
  const histogram = new Uint32Array(256);
  for (let sampleY = 0; sampleY < sampling.sampleHeight; sampleY++) {
    const pixelY = Math.min(image.height - 1, Math.floor((sampleY + 0.5) * sampling.stepY));
    for (let sampleX = 0; sampleX < sampling.sampleWidth; sampleX++) {
      const pixelX = Math.min(image.width - 1, Math.floor((sampleX + 0.5) * sampling.stepX));
      histogram[image.pixels[pixelY * image.width + pixelX]] += 1;
    }
  }
  return histogram;
}

function derivePaperBoundsThresholdFromHistogram(histogram: Uint32Array): number {
  let total = 0;
  let intermediate = 0;
  for (let value = 0; value < histogram.length; value++) {
    total += histogram[value];
    if (value !== 0 && value !== 255) {
      intermediate += histogram[value];
    }
  }

  if (
    total === 0
    || (histogram[255] > 0 && intermediate / total <= PAPER_BOUNDS_BINARY_INTERMEDIATE_RATIO)
  ) {
    return PAPER_BOUNDS_SCAN_THRESHOLD;
  }

  const otsuThreshold = findOtsuThreshold(histogram, total);
  if (otsuThreshold === null) {
    return PAPER_BOUNDS_SCAN_THRESHOLD;
  }

  let darkCount = 0;
  let brightCount = 0;
  let darkSum = 0;
  let brightSum = 0;
  for (let value = 0; value <= otsuThreshold; value++) {
    darkCount += histogram[value];
    darkSum += value * histogram[value];
  }
  for (let value = otsuThreshold + 1; value < histogram.length; value++) {
    brightCount += histogram[value];
    brightSum += value * histogram[value];
  }

  if (darkCount === 0 || brightCount === 0) {
    return PAPER_BOUNDS_SCAN_THRESHOLD;
  }

  const darkMean = darkSum / darkCount;
  const brightMean = brightSum / brightCount;
  if (brightMean - darkMean < PAPER_BOUNDS_MIN_GROUP_SEPARATION) {
    return PAPER_BOUNDS_SCAN_THRESHOLD;
  }

  return clamp(Math.round((darkMean + brightMean) / 2), 1, PAPER_BOUNDS_SCAN_THRESHOLD);
}

function findOtsuThreshold(histogram: Uint32Array, total: number): number | null {
  let totalSum = 0;
  for (let value = 0; value < histogram.length; value++) {
    totalSum += value * histogram[value];
  }

  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let bestThreshold: number | null = null;

  for (let threshold = 0; threshold < 255; threshold++) {
    backgroundWeight += histogram[threshold];
    backgroundSum += threshold * histogram[threshold];
    const foregroundWeight = total - backgroundWeight;
    if (backgroundWeight === 0 || foregroundWeight === 0) {
      continue;
    }

    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (totalSum - backgroundSum) / foregroundWeight;
    const betweenClassVariance = backgroundWeight * foregroundWeight
      * (backgroundMean - foregroundMean) ** 2;
    if (betweenClassVariance > bestVariance) {
      bestVariance = betweenClassVariance;
      bestThreshold = threshold;
    }
  }

  return bestThreshold;
}

function findLargestBrightComponent(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  sampleWidth: number,
  sampleHeight: number,
  stepX: number,
  stepY: number,
  threshold: number,
): { left: number; top: number; right: number; bottom: number; area: number } | null {
  const sampleCount = sampleWidth * sampleHeight;
  const bright = new Uint8Array(sampleCount);
  const visited = new Uint8Array(sampleCount);

  for (let sampleY = 0; sampleY < sampleHeight; sampleY++) {
    const pixelY = Math.min(image.height - 1, Math.floor((sampleY + 0.5) * stepY));
    for (let sampleX = 0; sampleX < sampleWidth; sampleX++) {
      const pixelX = Math.min(image.width - 1, Math.floor((sampleX + 0.5) * stepX));
      const index = sampleY * sampleWidth + sampleX;
      bright[index] = image.pixels[pixelY * image.width + pixelX] >= threshold ? 1 : 0;
    }
  }

  let largest: { left: number; top: number; right: number; bottom: number; area: number } | null = null;
  const queue: number[] = [];

  for (let start = 0; start < sampleCount; start++) {
    if (bright[start] === 0 || visited[start] !== 0) {
      continue;
    }

    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    let area = 0;
    let left = sampleWidth;
    let right = 0;
    let top = sampleHeight;
    let bottom = 0;

    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor];
      const sampleX = index % sampleWidth;
      const sampleY = Math.floor(index / sampleWidth);
      area++;
      left = Math.min(left, sampleX);
      right = Math.max(right, sampleX + 1);
      top = Math.min(top, sampleY);
      bottom = Math.max(bottom, sampleY + 1);

      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = sampleX + offsetX;
          const nextY = sampleY + offsetY;
          if (nextX < 0 || nextY < 0 || nextX >= sampleWidth || nextY >= sampleHeight) continue;
          const next = nextY * sampleWidth + nextX;
          if (bright[next] === 0 || visited[next] !== 0) continue;
          visited[next] = 1;
          queue.push(next);
        }
      }
    }

    if (!largest || area > largest.area) {
      largest = { left, top, right, bottom, area };
    }
  }

  return largest;
}

function detectPaperContentBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  pageBounds: PixelBounds,
): PixelBounds | null {
  const bounds = detectDarkPixelBounds(image, pageBounds);
  const pageWidth = pageBounds.right - pageBounds.left;
  const pageHeight = pageBounds.bottom - pageBounds.top;
  const contentWidth = bounds.right - bounds.left;
  const contentHeight = bounds.bottom - bounds.top;
  const aspectRatio = contentHeight / contentWidth;

  if (
    contentWidth < pageWidth * 0.55
    || contentHeight < pageHeight * 0.6
    || aspectRatio < 1.05
    || aspectRatio > 1.9
  ) {
    return null;
  }

  return bounds;
}

function detectDarkPixelBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  searchBounds?: PixelBounds,
): PixelBounds {
  const darkThreshold = 220;
  const frame = searchBounds || { left: 0, top: 0, right: image.width, bottom: image.height };
  const frameWidth = frame.right - frame.left;
  const frameHeight = frame.bottom - frame.top;
  const minX = clamp(Math.floor(frame.left + frameWidth * 0.02), 0, image.width - 1);
  const maxX = clamp(Math.ceil(frame.right - frameWidth * 0.02), minX + 1, image.width);
  const minY = clamp(Math.floor(frame.top + frameHeight * 0.03), 0, image.height - 1);
  const maxY = clamp(Math.ceil(frame.bottom - frameHeight * 0.02), minY + 1, image.height);

  let left = maxX;
  let right = minX;
  let top = maxY;
  let bottom = minY;

  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const value = image.pixels[y * image.width + x];
      if (value < darkThreshold) {
        left = Math.min(left, x);
        right = Math.max(right, x + 1);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y + 1);
      }
    }
  }

  if (left >= right || top >= bottom) {
    return {
      left: frame.left,
      top: frame.top,
      right: frame.right,
      bottom: frame.bottom,
    };
  }

  const paddingX = Math.round((right - left) * 0.005);
  const paddingY = Math.round((bottom - top) * 0.005);

  return {
    left: clamp(left - paddingX, 0, image.width - 1),
    top: clamp(top - paddingY, 0, image.height - 1),
    right: clamp(right + paddingX, 1, image.width),
    bottom: clamp(bottom + paddingY, 1, image.height),
  };
}

function detectFrameBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  pageBounds?: PixelBounds,
): PixelBounds | null {
  const darkThreshold = 220;
  const reference = pageBounds || { left: 0, top: 0, right: image.width, bottom: image.height };
  const referenceWidth = reference.right - reference.left;
  const referenceHeight = reference.bottom - reference.top;
  const minX = clamp(Math.floor(reference.left + referenceWidth * 0.05), 0, image.width - 1);
  const maxX = clamp(Math.ceil(reference.right - referenceWidth * 0.05), minX + 1, image.width);
  const minY = clamp(Math.floor(reference.top + referenceHeight * 0.07), 0, image.height - 1);
  const maxY = clamp(Math.ceil(reference.bottom - referenceHeight * 0.05), minY + 1, image.height);
  const horizontalRows: number[] = [];

  for (let y = minY; y < maxY; y++) {
    let darkCount = 0;
    for (let x = minX; x < maxX; x++) {
      if (image.pixels[y * image.width + x] < darkThreshold) {
        darkCount++;
      }
    }

    if (darkCount >= (maxX - minX) * 0.35) {
      horizontalRows.push(y);
    }
  }

  if (horizontalRows.length < 2) {
    return null;
  }

  const top = horizontalRows[0];
  const bottom = horizontalRows[horizontalRows.length - 1] + 1;
  const minVerticalDarkPixels = Math.max(80, (bottom - top) * 0.12);
  const verticalCols: number[] = [];

  for (let x = minX; x < maxX; x++) {
    let darkCount = 0;
    for (let y = top; y < bottom; y++) {
      if (image.pixels[y * image.width + x] < darkThreshold) {
        darkCount++;
      }
    }

    if (darkCount >= minVerticalDarkPixels) {
      verticalCols.push(x);
    }
  }

  if (verticalCols.length < 2) {
    return null;
  }

  const left = verticalCols[0];
  const right = verticalCols[verticalCols.length - 1] + 1;

  if ((right - left) < referenceWidth * 0.58 || (bottom - top) < referenceHeight * 0.62) {
    return null;
  }

  const bounds = { left, top, right, bottom };
  if (!isPlausibleFrameBounds(image, bounds, reference)) {
    return null;
  }

  // Long table rules can satisfy the initial row/column density thresholds.
  // Require all four detected edges to remain sufficiently continuous so an
  // internal form table is not promoted to the page frame.
  if (!hasContinuousFrameEdges(image, bounds)) {
    return null;
  }

  return bounds;
}

/**
 * All coordinate consumers use this one registration frame. A raw dark-pixel
 * envelope may still be shown for manual review, but it is never trusted for
 * automatic answers unless page or frame registration succeeded.
 */
export function getRegistrationBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
): PixelBounds {
  return image.contentBounds || {
    left: 0,
    top: 0,
    right: image.width,
    bottom: image.height,
  };
}

export function hasUsableFormBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds' | 'contentBoundsSource' | 'pageBounds'>,
): boolean {
  return resolveFormBoundsStatus(image).usable;
}

/** Review-side check: a sheet is present, whether or not values may be produced. */
export function hasReviewableFormBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds' | 'contentBoundsSource' | 'pageBounds'>,
): boolean {
  return resolveFormBoundsStatus(image, { strict: false }).usable;
}

/**
 * The safety precondition, with the clause that decided it.
 *
 * `hasUsableFormBounds` returns this verdict and nothing else, so the reason
 * reported can never drift from the reason applied -- there is one evaluation,
 * not an explanation written alongside it.
 *
 * This matters because the caller ands this together with grid verification
 * before handing the result to `analyzeChoiceGroup`, which sees only the
 * conjunction. A group refused on the combined precondition cannot say which
 * half refused it unless this one is re-checked, and the two halves live in
 * different files and want different fixes.
 */
export function resolveFormBoundsStatus(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds' | 'contentBoundsSource' | 'pageBounds'>,
  options: { strict?: boolean } = {},
): { usable: boolean; reason: string } {
  // strict (default): the automatic-value gate. Non-strict: "is there a sheet
  // here at all" for review-side signals such as the privacy alert, which
  // must keep working on frame/legacy bounds that may not produce values.
  const strict = options.strict !== false;
  if (image.contentBoundsSource === 'dark') {
    return { usable: false, reason: 'dark-bounds-only' };
  }
  // Frame bounds are a fallback for the registration step, not evidence that
  // the template sits where the frame says. Measured 2026-09-03 (audit B-1):
  // the fallback never fired on 152 scanned sheets, fired on 13 sunlit photo
  // sheets, and the one automatic value it produced wrongly (p3 cagi.q01 -> 3)
  // was the photo path's last remaining wrong. It may still register the
  // sheet for review; it may not produce automatic values.
  if (strict && image.contentBoundsSource === 'frame') {
    return { usable: false, reason: 'frame-bounds-only' };
  }

  const bounds = image.contentBounds;
  if (!bounds) {
    return { usable: false, reason: 'no-content-bounds' };
  }

  const documentBounds = image.pageBounds || bounds;
  if (!isPlausiblePaperBounds(image, documentBounds)) {
    const w = (documentBounds.right - documentBounds.left) / image.width;
    const h = (documentBounds.bottom - documentBounds.top) / image.height;
    const ar = (documentBounds.bottom - documentBounds.top)
      / Math.max(documentBounds.right - documentBounds.left, 1);
    return {
      usable: false,
      reason: `implausible-paper(w=${w.toFixed(3)}/0.550 h=${h.toFixed(3)}/0.620`
        + ` ar=${ar.toFixed(3)}/[1.05,1.90])`,
    };
  }

  // For a detected page, the content frame is intentionally inset from all
  // four sheet edges. Judge registration confidence using the outer paper
  // bounds, then ensure the inner template frame remains plausibly large and
  // contained. Older callers without a page keep the legacy edge checks.
  if (image.pageBounds) {
    const page = image.pageBounds;
    if (isPlausibleTemplateContentBounds(page, bounds)) {
      return { usable: true, reason: 'ok' };
    }
    const cw = (bounds.right - bounds.left) / Math.max(page.right - page.left, 1);
    const ch = (bounds.bottom - bounds.top) / Math.max(page.bottom - page.top, 1);
    const ar = (bounds.bottom - bounds.top) / Math.max(bounds.right - bounds.left, 1);
    const inside = bounds.left >= page.left && bounds.top >= page.top
      && bounds.right <= page.right && bounds.bottom <= page.bottom;
    return {
      usable: false,
      reason: `implausible-content(inside=${inside ? 1 : 0} w=${cw.toFixed(3)}/0.550`
        + ` h=${ch.toFixed(3)}/0.550 ar=${ar.toFixed(3)}/[1.05,1.95])`,
    };
  }

  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const aspectRatio = height / width;

  const usable = width >= image.width * 0.72
    && height >= image.height * 0.78
    && bounds.left <= image.width * 0.16
    && bounds.right >= image.width * 0.84
    && bounds.top <= image.height * 0.16
    && bounds.bottom >= image.height * 0.84
    && aspectRatio >= 1.05
    && aspectRatio <= 1.9;

  // Without page bounds the edge checks above cannot tell a sheet from a
  // desk-plus-sheet; the verdict is recorded for diagnostics but no longer
  // unlocks automatic values (audit B-1, same measurement as above).
  return {
    usable: usable && !strict,
    reason: usable
      ? (strict ? 'legacy-edges-unverified' : 'ok-legacy')
      : `legacy-edges(w=${(width / image.width).toFixed(3)}/0.720`
        + ` h=${(height / image.height).toFixed(3)}/0.780`
        + ` l=${(bounds.left / image.width).toFixed(3)}/0.160`
        + ` r=${(bounds.right / image.width).toFixed(3)}/0.840`
        + ` t=${(bounds.top / image.height).toFixed(3)}/0.160`
        + ` b=${(bounds.bottom / image.height).toFixed(3)}/0.840`
        + ` ar=${aspectRatio.toFixed(3)}/[1.05,1.90])`,
  };
}

function isPlausibleTemplateContentBounds(pageBounds: PixelBounds, contentBounds: PixelBounds): boolean {
  const pageWidth = pageBounds.right - pageBounds.left;
  const pageHeight = pageBounds.bottom - pageBounds.top;
  const contentWidth = contentBounds.right - contentBounds.left;
  const contentHeight = contentBounds.bottom - contentBounds.top;

  return (
    contentBounds.left >= pageBounds.left
    && contentBounds.top >= pageBounds.top
    && contentBounds.right <= pageBounds.right
    && contentBounds.bottom <= pageBounds.bottom
    && contentWidth >= pageWidth * 0.55
    && contentHeight >= pageHeight * 0.55
    && contentHeight / contentWidth >= 1.05
    && contentHeight / contentWidth <= 1.95
  );
}

function isPlausiblePaperBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height'>,
  bounds: PixelBounds,
): boolean {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const aspectRatio = height / width;

  return (
    width >= image.width * 0.55
    && height >= image.height * 0.62
    && aspectRatio >= 1.05
    && aspectRatio <= 1.9
  );
}

interface DecisionTraceContext {
  field: string;
  boundsSource: ContentBoundsSource | 'none';
  boundsWidth: number;
  paperBoundsThreshold?: number;
  boundsRejection?: string;
  usesBaseline: boolean;
  usesGridCells: boolean;
  scores: number[];
  ranked: ScoredCandidate[];
  best?: ScoredCandidate;
  gap: number;
  relativeContrast: number;
  highScoreThreshold: number;
  highGapThreshold: number;
  mediumScoreThreshold: number;
  mediumGapThreshold: number;
  requireHighVisualConfidence: boolean;
  pageCalibration?: PageInkCalibration;
  /**
   * Set only when `detectOffRowBand` refused the group, so a decision that this
   * check never touched reads exactly as it did before.
   */
  band?: { nonVoid: number; empty: number; minNonVoid: number; inks: number[] };
  published?: DecisionEvidence;
}

/**
 * Every test `analyzeChoiceGroup` applied, what it was given, and by how much
 * it missed.
 *
 * Seventeen cells sit at `src=grid conf=low` with verified coordinates and a
 * mark that is really on the page, and `conf=low` alone cannot say whether a
 * test missed by two percent or by tenfold. Those are different problems and
 * four attempts have already been spent tuning this file without knowing which
 * one was being tuned.
 *
 * Each failing test is named the way the age reader names its gates, and each
 * carries `have/need(ratio)` so the distance is readable at a glance. A ratio
 * just under 1 is a threshold problem; a ratio near zero is a signal problem.
 *
 * Only numbers and fixed labels are emitted. Candidate scores are listed in
 * rank order without their values, so the row shows the shape of the decision
 * without restating which option a student chose.
 */
/**
 * A second route to high confidence, over measurements the four thresholds
 * never read.
 *
 * Three scans of one stack, scored against the key, say the gate refuses 145
 * cell-readings whose top candidate was right. Its own features cannot pick
 * those out: leave-one-student-out, a fitted boundary over floor, gap,
 * contrast and shape recovers none of them without admitting a wrong value.
 * The numbers `analyzeResidualComposition` and the alignment already produce,
 * and nothing reads, recover 44 -- shuffling the labels drops that to about 7,
 * which is what the search over feature subsets is worth on noise alone.
 *
 * What it says, in the order the weights rank it:
 *
 *  - the runner-up's `fit` is the strongest term and it is negative. A runner-up
 *    that agrees with the blank form is empty paper, so the winner is alone in
 *    the group and the mark is real. A runner-up that disagrees means ink in two
 *    places and a genuinely ambiguous cell.
 *  - `edgeShare` is negative: disagreement concentrated on the printed rules is
 *    registration residue, not a pen stroke.
 *  - `edgeFraction` is positive and mostly normalises the one above, since a
 *    cell that is mostly printed edge will carry more of its mass there.
 *
 * Fitted on 19 students, which is the sample this project has; the honest
 * out-of-sample figure is the leave-one-out one, not what it scores here.
 * §36 carries the full accounting, including the permutation controls.
 */
const RESCUE_EDGE_FRACTION_WEIGHT = 6.136;
const RESCUE_EDGE_SHARE_WEIGHT = -4.3472;
const RESCUE_SECOND_FIT_WEIGHT = -20.8018;
const RESCUE_BIAS = 4.2005;

/**
 * Chosen well clear of the boundary rather than at it. At 1.40 the rule still
 * admits no wrong value on this sample and takes 48 cells, but the nearest
 * wrong one sits 0.031 away; at 1.80 it takes 23 and the nearest sits 0.431
 * away, spread over 14 of the 19 students. On a sample this size the margin is
 * worth more than the cells.
 */
const RESCUE_THRESHOLD = 1.8;

function rescueConfidence(
  best: TemplateInkFeatures | undefined,
  second: TemplateInkFeatures | undefined,
): number | null {
  if (!best?.edges || !second || second.fit === undefined) {
    return null;
  }
  return RESCUE_EDGE_FRACTION_WEIGHT * best.edges.edgeFraction
    + RESCUE_EDGE_SHARE_WEIGHT * best.edges.edgeShare
    + RESCUE_SECOND_FIT_WEIGHT * second.fit
    + RESCUE_BIAS;
}

function describeDecision(
  evidence: DecisionTraceContext,
  outcome: string,
  refused: string[],
  contested = false,
  suggestion?: ReviewSuggestion,
): string {
  const {
    field, usesBaseline, usesGridCells, scores, best, gap, relativeContrast,
    highScoreThreshold, highGapThreshold, mediumScoreThreshold, mediumGapThreshold,
  } = evidence;

  // Build the review-facing record from the exact variables immediately used
  // by the trace below. This is a recording outlet only: no gate reads it.
  evidence.published = {
    outcome: contested ? 'contested' : outcome === 'high' ? 'auto' : 'refused',
    ...(best ? {
      winner: {
        index: best.candidateIndex,
        score: best.score,
      },
    } : {}),
    ...(evidence.ranked[1] ? {
      runnerUp: {
        index: evidence.ranked[1].candidateIndex,
        score: evidence.ranked[1].score,
      },
    } : {}),
    ...(best ? { gap, relativeContrast } : {}),
    thresholds: {
      score: highScoreThreshold,
      gap: highGapThreshold,
      contrast: HIGH_RELATIVE_CONTRAST,
    },
    ...(evidence.pageCalibration ? {
      inputClass: evidence.pageCalibration.inputClass,
      gain: evidence.pageCalibration.gain,
      margin: evidence.pageCalibration.margin,
      ratio: evidence.pageCalibration.ratio,
    } : {}),
    refused: [...refused],
    ...(best?.shape ? {
      offset: { x: best.shape.alignX, y: best.shape.alignY },
      shape: {
        componentRatio: best.shape.largestComponentRatio,
        diagonalRatio: best.shape.diagonalRatio,
      },
    } : {}),
    contested,
  };

  const parts = [
    `field=${field}`,
    `outcome=${outcome}`,
    `bounds=${evidence.boundsSource}`
      + `/${evidence.boundsWidth.toFixed(4)}`
      + (evidence.paperBoundsThreshold !== undefined
        ? `/paper-threshold=${evidence.paperBoundsThreshold}`
        : '')
      + `${evidence.boundsRejection ? `/${evidence.boundsRejection}` : ''}`,
    refused.length > 0 ? `refused=${refused.join(',')}` : 'refused=none',
    `base=${usesBaseline ? 1 : 0} cells=${usesGridCells ? 1 : 0} n=${scores.length}`,
    `scores=${scores.map((score) => score.toFixed(3)).join('/')}`,
  ];

  if (evidence.pageCalibration) {
    parts.push(
      `class=${evidence.pageCalibration.inputClass}`
        + ` gain=${evidence.pageCalibration.gain.toFixed(2)}`
        + ` margin=${evidence.pageCalibration.margin.toFixed(3)}`
        + ` r=${evidence.pageCalibration.ratio.toFixed(3)}`,
    );
  }

  if (contested) {
    parts.push('contested=1');
  }

  // The box the two rankings agreed on, by its position in the template's
  // candidate list -- the same index `boxes=[...]` below is ordered by score,
  // not position, so the two are read together deliberately.
  if (suggestion) {
    parts.push(`suggest=${suggestion.candidateIndex}`);
  }

  if (best) {
    parts.push(`floor=${ratioOf(best.score, highScoreThreshold)}`);
    parts.push(`gap=${ratioOf(gap, highGapThreshold)}`);
    if (usesBaseline) {
      parts.push(`contrast=${ratioOf(relativeContrast, HIGH_RELATIVE_CONTRAST)}`);
    }
    parts.push(`med-floor=${ratioOf(best.score, mediumScoreThreshold)}`);
    parts.push(`med-gap=${ratioOf(gap, mediumGapThreshold)}`);
  }

  // Only present when the band check refused, and it carries the ink readings
  // the refusal was made on so the box list below does not have to be parsed
  // to see why.
  if (evidence.band) {
    parts.push(
      `band=refused(nonvoid=${evidence.band.nonVoid},empty=${evidence.band.empty}`
      + `,min=${ratioOf(evidence.band.minNonVoid, BAND_INK_ALL_MIN)}`
      + `,void=${BAND_INK_EMPTY.toFixed(3)}`
      + `,ink=${evidence.band.inks.map((ink) => ink.toFixed(3)).join('/')})`,
    );
  }

  const shape = best?.shape;
  if (usesBaseline && shape) {
    parts.push(
      `shape=[size=${ratioOf(shape.largestComponentSize, STRUCTURED_MARK_MIN_COMPONENT)}`
      + ` compact=${ratioOf(shape.largestComponentRatio, STRUCTURED_MARK_MIN_COMPONENT_RATIO)}`
      + ` diag=${ratioOf(shape.diagonalRatio, STRUCTURED_MARK_MIN_DIAGONAL_RATIO)}]`,
    );
  }

  // Every box, not just the winner. When the scorer names a box the checkbox
  // gate reports as empty, the question is what the named box has that the
  // inked one does not -- and that cannot be read from the winner alone. Each
  // entry is the box's position in the group as the template lists it, so a
  // row here lines up with the box the gate names.
  const ink = best?.shape as TemplateInkFeatures | undefined;
  if (usesBaseline && ink && ink.actualInk !== undefined) {
    const rows = evidence.ranked.slice(0, 6).map((candidate) => {
      const features = candidate.shape as TemplateInkFeatures | undefined;
      if (!features) return `${candidate.position}@${candidate.atX.toFixed(2)}:scr=${candidate.score.toFixed(3)}`;
      // An offset sitting on the edge of the search means the search ran out
      // of room rather than finding the best fit.
      const pinned = Math.abs(features.alignX) >= features.radiusX
        || Math.abs(features.alignY) >= features.radiusY;
      // Where a wider search wanted to go, and whether going there would have
      // fitted materially better. `want` pinned at its own radius, or a gain
      // near zero, both mean translation is not what is missing.
      const probe = features.probe;
      const wanted = probe
        ? ` want=${probe.x},${probe.y}`
          + `${Math.abs(probe.x) >= probe.radius || Math.abs(probe.y) >= probe.radius ? '!' : ''}`
          + `/${probe.radius} gain=${(probe.chosenFit - probe.fit).toFixed(4)}`
        : '';
      // What the leftover disagreement is made of, when it was measured.
      const c = features.composition;
      const made = c
        ? ` edge=${c.edgeShare.toFixed(2)}/${c.edgeFraction.toFixed(2)}`
          + ` bal=${c.edgeBalance.toFixed(2)}`
          + ` sharp=${c.pageSharpness.toFixed(3)},${c.blankSharpness.toFixed(3)}`
          + ` soft=${c.fitSoftBlank.toFixed(4)},${c.fitSoftBoth.toFixed(4)}`
          + ` mscore=${c.matchedScore.toFixed(4)}`
        : '';
      return `${candidate.position}@${candidate.atX.toFixed(2)}:scr=${candidate.score.toFixed(3)}`
        + ` page=${features.actualInk.toFixed(3)} blank=${features.baselineInk.toFixed(3)}`
        // Only where the invariant actually took something away. It is
        // vacuously true of every empty box on the page, and a marker that
        // fires on all of them would bury the one that mattered; `scr0` is the
        // residual it removed, so the row still shows the size of the removal.
        + (features.inkInvariantZeroed && features.residualScore > 0
          ? ` inkInvariant=zeroed(page<=blank,scr0=${features.residualScore.toFixed(4)})`
          : '')
        + ` shift=${features.brightnessOffset.toFixed(0)}`
        // Which correction the box was actually measured through. `shift=`
        // alone stopped being the answer once a photographed box could be
        // mapped rather than moved, and a correction that cannot be read back
        // from the trace is not diagnosable.
        + ` tone=${features.tone}`
        + (features.brightnessProbe
          ? ` ref82=${features.brightnessProbe.actualP82.toFixed(0)},${features.brightnessProbe.blankP82.toFixed(0)}`
            + ` ref95=${features.brightnessProbe.actualP95.toFixed(0)},${features.brightnessProbe.blankP95.toFixed(0)}`
            + ` alt95=${features.brightnessProbe.offset95.toFixed(0)},${features.brightnessProbe.score95.toFixed(4)}`
          : '')
        + (features.insetSignal !== undefined
          ? ` inner=${features.insetSignal.toFixed(3)}`
          : '')
        + (features.blankGeometry
          ? ` bcore=${features.blankGeometry.coreConcentration.toFixed(2)}`
            + `/${features.blankGeometry.fill.toFixed(3)}`
          : '')
        + ` align=${features.alignX.toFixed(2)},${features.alignY.toFixed(2)}${pinned ? '!' : ''}`
        + ` steps=${features.stepsX},${features.stepsY}`
        + ` fit=${features.fit.toFixed(4)}${wanted}${made}`;
    });
    parts.push(`boxes=[${rows.join(' | ')}]`);
    // How far the alignment search can physically reach. It moves in whole
    // samples, so a pitch below 1 means it cannot correct a one-pixel
    // registration error no matter what the offsets say.
    parts.push(
      `pitch=[page=${ink.pagePitchX.toFixed(2)},${ink.pagePitchY.toFixed(2)}`
      + ` blank=${ink.blankPitchX.toFixed(2)},${ink.blankPitchY.toFixed(2)}`
      + ` reach=${ink.radiusX},${ink.radiusY}]`,
    );
  }

  const trace = `[marks ${parts.join(' ')}]`;
  emitDecisionTrace(trace);
  return trace;
}

/**
 * The trace's second outlet.
 *
 * `analyzeChoiceGroup` returns the trace on its result, but the caller that
 * puts field text on the reviewer's screen lives in another file and does not
 * forward it yet. Until it does, this makes the same string readable from a
 * measurement run without any other file changing. It is off unless
 * `MARK_DECISION_TRACE` is set, so nothing is written in a normal request.
 */
function isTracing(): boolean {
  return typeof process !== 'undefined' && Boolean(process.env?.MARK_DECISION_TRACE);
}

/**
 * One candidate's structural score, from the one definition of it.
 *
 * Traced groups already carry the exact value from `analyzeResidualComposition`;
 * normal production groups use the lazy input and calculate it once here. Both
 * routes end in `calculateMatchedScoreFromSoftened`, so the trace, the
 * contested badge and the review suggestion are all reading the same number —
 * §29.5 records that this sharing is why the badge's offline prediction
 * transferred to production unchanged, and the suggestion rule was calibrated
 * against the same trace field.
 *
 * The two callers differ only in when they are willing to pay for it: the badge
 * asks for the runner-up of a group that already reached high confidence, the
 * suggestion asks for every box of a group that reached no value at all.
 */
function getCandidateMatchedScore(candidate: ScoredCandidate | undefined): number | undefined {
  const tracedScore = candidate?.shape?.composition?.matchedScore;
  if (typeof tracedScore === 'number') {
    return tracedScore;
  }
  const input = candidate?.shape?.matchedScoreInput;
  return input ? calculateMatchedScore(input) : undefined;
}

function isContestedHighConfidenceRunnerUp(candidate: ScoredCandidate | undefined): boolean {
  return isContestedRunnerUp(
    'high',
    getCandidateMatchedScore(candidate),
    Boolean(candidate),
  );
}

/**
 * Reads both ranking features off a refused group's boxes and applies the rule.
 *
 * Only called from the two returns that leave a group for review with its
 * geometry trusted. It reads nothing that any threshold reads and writes
 * nothing back onto the candidates, so a group's value, confidence and blank
 * status are identical whether or not this ever runs.
 *
 * `usesBaseline` is a precondition rather than a filter: without the blank form
 * there is no `actualInk`/`baselineInk` pair and no `matchedScoreInput`, so the
 * raw-density path has neither feature and this would return undefined anyway.
 * Checking it up front just avoids walking the boxes to find that out.
 */
function buildReviewSuggestion(
  scoredCandidates: ScoredCandidate[],
  usesBaseline: boolean,
): ReviewSuggestion | undefined {
  if (!usesBaseline || scoredCandidates.length < 2) return undefined;
  return selectReviewSuggestion(scoredCandidates.map((candidate) => ({
    candidateIndex: candidate.candidateIndex,
    value: candidate.value,
    pageMinusBlank: candidate.shape
      ? candidate.shape.actualInk - candidate.shape.baselineInk
      : undefined,
    matchedScore: getCandidateMatchedScore(candidate),
  })));
}

function emitDecisionTrace(trace: string): void {
  if (!isTracing()) {
    return;
  }
  // eslint-disable-next-line no-console
  console.info(trace);
}

function isGridTracing(): boolean {
  return typeof process !== 'undefined' && process.env?.GRID_TRACE === '1';
}

function normalizedCandidateCenter(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
  rect: PixelRect,
): { x: number; y: number } {
  const bounds = getRegistrationBounds(image);
  return {
    x: ((rect.left + rect.right) / 2 - bounds.left) / Math.max(bounds.right - bounds.left, 1),
    y: ((rect.top + rect.bottom) / 2 - bounds.top) / Math.max(bounds.bottom - bounds.top, 1),
  };
}

function minimumCenterSpacing(points: Array<{ x: number; y: number }>): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      minimum = Math.min(
        minimum,
        Math.hypot(points[first].x - points[second].x, points[first].y - points[second].y),
      );
    }
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

/**
 * Reports the existing positional i↔i pairing without making it a gate. Page
 * and baseline centres are normalised against their own content frames so a
 * different raster size does not masquerade as a displacement.
 */
function emitBaselinePairTrace(
  field: string,
  image: ImageAnalysisData,
  pageRects: PixelRect[],
  baseline: ImageAnalysisData,
  baselineRects: PixelRect[],
): void {
  if (!isGridTracing()) return;

  const pageCenters = pageRects.map((rect) => normalizedCandidateCenter(image, rect));
  const baselineCenters = baselineRects.map((rect) => normalizedCandidateCenter(baseline, rect));
  const count = Math.min(pageCenters.length, baselineCenters.length);
  let maxDeviation = 0;
  for (let index = 0; index < count; index += 1) {
    maxDeviation = Math.max(
      maxDeviation,
      Math.hypot(
        pageCenters[index].x - baselineCenters[index].x,
        pageCenters[index].y - baselineCenters[index].y,
      ),
    );
  }
  const pitchMin = Math.min(
    minimumCenterSpacing(pageCenters),
    minimumCenterSpacing(baselineCenters),
  );
  const ok = maxDeviation <= 0.5 * pitchMin;
  // eslint-disable-next-line no-console
  console.info(
    `[baseline-pair] field=${field} maxDev=${maxDeviation.toFixed(4)}`
      + ` pitchMin=${pitchMin.toFixed(3)} ok=${ok ? 1 : 0}`,
  );
}

/** `have/need(ratio)`, so a near miss and a rout read differently. */
function ratioOf(have: number, need: number): string {
  const ratio = need > 0 ? have / need : Number.POSITIVE_INFINITY;
  const shown = Number.isFinite(ratio) ? `${ratio.toFixed(2)}x` : 'inf';
  const value = Number.isFinite(have) ? have.toFixed(3) : 'inf';
  return `${value}/${need.toFixed(3)}(${shown})`;
}

/**
 * PROVISIONAL. The signature comes from
 * `Task/FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27.md` §9.1(a), which re-measured
 * the draft rule §8 row A' had proposed and replaced it.
 *
 * The two photo sheets that read `satisfaction.q10` as 2 instead of 4 show one
 * arrangement in the ranked boxes: the box the student actually marked carries
 * `actualInk 0.000` while every other box carries ink, every alignment pinned
 * at its search radius, and the gate then confirms a wrong column on margins
 * that look healthy. Horizontal positions match the template; the band is
 * displaced vertically onto the printed text line below the table's last row,
 * so letter ink lands evenly across the boxes and only the position past the
 * table's right edge stays blank.
 *
 * The draft rule (>=3 boxes at >=0.10, plus >=1 void) covered the first sheet
 * and missed the second, whose inks are `0.103/0.077/0.070/0.046/0.000` -- the
 * same arrangement at a lower level. §9.1(a) re-measured the alternative over
 * all fifteen accepted multi-choice photo rows:
 *
 *     signature fires on a legitimate row at t=0.030: 1   t=0.040: 1
 *                                             t=0.045: 1   t=0.060: 0
 *     (the one at t<=0.045 is p5 q10 itself, i.e. a wrong value, not a cost)
 *     highest minNonVoid over the legitimate rows: 0.017 (p1 q07)
 *
 * So `>=1 void AND every non-void box >= 0.040` fires on exactly the two
 * off-row bands and on none of the legitimate rows, with 2.3x of margin
 * (0.040 / 0.017) against the closest one.
 *
 * Sample size is fifteen rows. That is small, and 0.040 is a cut through it,
 * not a boundary the paper knows about; the central checkout is what measures
 * this and may retune or reject it.
 *
 * One consequence worth stating, because the sample cannot speak to it: with
 * the inked-count condition gone, this rule can now also fire on 2- and
 * 3-candidate groups, which the fifteen measured rows do not include. It only
 * ever removes a value, so it cannot create a wrong answer, but it may cost a
 * correct one somewhere the measurement did not look.
 */
const BAND_INK_EMPTY = 0.005;
const BAND_INK_ALL_MIN = 0.040;

/**
 * Whether a group's per-box template ink reads as a displaced band rather than
 * an answer row.
 *
 * A real mark adds ink to ONE box against a baseline every box shares, so the
 * boxes differ by the mark and agree elsewhere. Ink in every box but one, with
 * that one perfectly void, is the opposite arrangement, and it is what a band
 * lying on a printed text line that ends mid-row produces.
 *
 * `inks` is in the order the decision ranks them and `winnerIndex` points at
 * the box that would be confirmed; the winner has to be one of the non-void
 * ones, because a void winner is a different (and already refused) situation.
 *
 * Returns what the refusal was made on -- how many boxes carried ink, how many
 * were void, and the smallest of the inked readings, which is the number the
 * rule actually turns on -- so it can be read back from the trace, and `null`
 * otherwise. It decides nothing on its own: the caller only ever turns a `null`
 * return into "carry on".
 */
export function detectOffRowBand(
  inks: number[],
  winnerIndex: number,
): { nonVoid: number; empty: number; minNonVoid: number } | null {
  const winner = inks[winnerIndex];
  // A void winner, or one that cannot be read, is not this rule's case.
  if (typeof winner !== 'number' || !Number.isFinite(winner) || winner <= BAND_INK_EMPTY) {
    return null;
  }
  let nonVoid = 0;
  let empty = 0;
  let minNonVoid = Number.POSITIVE_INFINITY;
  for (const ink of inks) {
    // An unreadable box says nothing either way, so it is skipped rather than
    // counted as void or as ink.
    if (typeof ink !== 'number' || !Number.isFinite(ink)) {
      continue;
    }
    if (ink <= BAND_INK_EMPTY) {
      empty += 1;
      continue;
    }
    nonVoid += 1;
    minNonVoid = Math.min(minNonVoid, ink);
  }
  if (empty < 1 || minNonVoid < BAND_INK_ALL_MIN) {
    return null;
  }
  return { nonVoid, empty, minNonVoid };
}

/**
 * Calculates the page-wide scale used by the opt-in grayscale residual path.
 * A marked box is allowed to be an outlier; the median of all valid box
 * ratios is the page's print-reproduction estimate.
 */
export function createPageInkCalibration(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels' | 'contentBounds' | 'pageIsBinarySource'>,
  candidateRects: PixelRect[],
  baseline: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  baselineRects: PixelRect[],
  photoProvenance = false,
): PageInkCalibration | undefined {
  if (!grayClassEnabled() || photoProvenance) return undefined;
  if (candidateRects.length === 0 || candidateRects.length !== baselineRects.length) return undefined;

  const features = candidateRects.map((rect, index) => calculateTemplateInkFeatures(
    image,
    rect,
    baseline,
    baselineRects[index],
  ));
  const ratios = features
    .filter((feature) => feature.baselineInk > 0 && Number.isFinite(feature.actualInk))
    .map((feature) => feature.actualInk / feature.baselineInk)
    .filter((ratio) => Number.isFinite(ratio));
  if (ratios.length === 0) return undefined;

  const ratio = percentile(ratios, 0.5);
  // The class is decided by the page's own printed structure, not by
  // `pageIsBinarySource`: after the upload JPEG a 1-bit scan carries more
  // than 1% intermediate pixels and would be misfiled as grayscale (measured
  // 2026-09-03: set 1 pages moved with the flag on). Set 1 sits at r ~ 0.73,
  // the grayscale device at 0.41-0.57.
  if (!(ratio < GRAY_CLASS_MAX_RATIO)) return undefined;
  const inputClass: InputClass = 'grayscale-scan';
  const gain = clamp(ratio / R_BILEVEL, GRAY_GAIN_MIN, GRAY_GAIN_MAX);
  const deltas = features
    .map((feature) => feature.actualInk - feature.baselineInk * gain)
    .filter((delta) => Number.isFinite(delta));
  const center = percentile(deltas, 0.5);
  const mad = percentile(deltas.map((delta) => Math.abs(delta - center)), 0.5);
  // Measurement switch (GRAY_MARGIN=fixed|scaled|derived): which margin rule
  // the grayscale class uses. Decided on the real sets, see
  // Task/GRAYSCALE_CLASS_2026-09-03.md.
  // 'scaled' won on set 4 (307/11 against 290/12 fixed and 317/13 derived).
  const marginRule = process.env?.GRAY_MARGIN ?? 'scaled';
  const margin = marginRule === 'fixed'
    ? GRAY_MARGIN_MAX
    : marginRule === 'scaled'
      ? clamp(GRAY_MARGIN_MAX * gain, GRAY_MARGIN_MIN, GRAY_MARGIN_MAX)
      : clamp(center + 2 * mad, GRAY_MARGIN_MIN, GRAY_MARGIN_MAX);

  return { inputClass, ratio, gain, margin };
}

export function analyzeChoiceGroup(
  image: ImageAnalysisData,
  group: ChoiceGroup,
  yOverride?: { top: number; bottom: number },
  allowAutoValue = true,
  candidatePixelOverrides?: PixelRect[],
  requireHighVisualConfidence = false,
  baseline?: ChoiceGroupBaseline,
  // Photo provenance: the sheet went through F1 capture correction (its
  // registration meta was stored with the upload). Photo-only refusals hang
  // off this — measured 2026-08-27: the band-structure check removed a wrong
  // value on the photo set but cost the scan set 4 correct cells (node 355->
  // 351, WRONG 7 unchanged), so it must not run where the failure mode it
  // detects cannot occur.
  //
  // Three refusals read it now: the band-structure check below, the outright
  // refusal of two-candidate groups (spec §14.1, which supersedes the floor on
  // the sheets it covers), and the raised floor those groups otherwise answer
  // to (`PHOTO_BINARY_FLOOR`). All three were measured on photo sheets alone
  // and none may touch a scan, which is what keeps the scan baseline
  // byte-identical.
  photoProvenance = false,
): ChoiceGroupResult {
  const usesGridCells = candidatePixelOverrides?.length === group.candidates.length;
  const usesBaseline = baseline?.candidatePixelOverrides.length === group.candidates.length;
  const candidateRects = group.candidates.map((candidate, index) => (usesGridCells
    ? candidatePixelOverrides![index]
    : toPixelRect(image, candidate.rect, yOverride)));
  if (usesBaseline) {
    emitBaselinePairTrace(
      group.field,
      image,
      candidateRects,
      baseline!.image,
      baseline!.candidatePixelOverrides,
    );
  }
  const inputClass = classifyInputClass(image, photoProvenance);
  const pageCalibration = usesBaseline && grayClassEnabled() && inputClass === 'grayscale-scan'
    ? baseline?.pageCalibration || createPageInkCalibration(
      image,
      candidateRects,
      baseline!.image,
      baseline!.candidatePixelOverrides,
      photoProvenance,
    )
    : undefined;
  // A third photo-only behaviour, alongside the band check and the binary
  // floor: which tonal correction the cells are measured through. It is
  // resolved once for the whole group, because every rule below compares the
  // boxes with each other and two boxes on different scales is a wrong value
  // waiting to happen. A scan gets `undefined` here before any anchor is even
  // computed, and each of its cells then takes the shift it always took.
  const groupTone = usesBaseline
    ? createGroupToneCorrection(
      image,
      candidateRects,
      baseline!.image,
      baseline!.candidatePixelOverrides,
      photoProvenance,
    )
    : undefined;
  const scoredCandidates: ScoredCandidate[] = group.candidates
    .map((candidate, index) => {
      const templateEvidence = usesBaseline
        ? calculateTemplateInkFeatures(
          image,
          candidateRects[index],
          baseline!.image,
          baseline!.candidatePixelOverrides[index],
          groupTone,
          pageCalibration,
        )
        : undefined;

      const rect = candidateRects[index];
      // Falls back to the whole bitmap when no envelope was resolved, which is
      // the same frame the rest of this file uses in that case.
      const contentLeft = image.contentBounds?.left ?? 0;
      const contentWidth = Math.max((image.contentBounds?.right ?? image.width) - contentLeft, 1);

      // What the measurement produced. On the raw-density path this is the
      // density, and there is no baseline to hold it to an invariant.
      const residualScore = roundScore(
        templateEvidence?.residualScore ?? calculateDarkPixelDensity(
          image,
          candidate.rect,
          150,
          yOverride,
          usesGridCells ? candidatePixelOverrides[index] : undefined,
        ),
      );

      return {
        position: index + 1,
        candidateIndex: index,
        atX: ((rect.left + rect.right) / 2 - contentLeft) / contentWidth,
        value: candidate.value,
        // The total-ink guard, applied where both quantities exist and only on
        // photo sheets -- see the scoping note at `bestInkInvariantZeroed`: on
        // scans the aggregate comparison is confounded by how the two rasters
        // render the printed circle, and enforcing it there cost 21 correct
        // cells.
        score: affineToneEnabled() && photoProvenance && templateEvidence?.inkInvariantZeroed
          ? 0
          : residualScore,
        residualScore,
        shape: templateEvidence,
      };
    })
    // Ranked on the pre-invariant score, so the invariant never promotes a
    // box: the order here is the order this file has always produced, and a
    // zeroed winner stays the winner and is refused below rather than handing
    // its group to the runner-up. Promotion is a decision about the other box
    // and this invariant says nothing about the other box.
    .sort((a, b) => b.residualScore - a.residualScore);
  const candidates: CandidateScore[] = scoredCandidates.map(({ value, score }) => ({ value, score }));
  const candidateMeasurements: CandidateMeasurement[] = scoredCandidates.map((candidate) => ({
    candidateIndex: candidate.candidateIndex,
    score: candidate.score,
    actualInk: candidate.shape?.actualInk ?? null,
    baselineInk: candidate.shape?.baselineInk ?? null,
    brightnessOffset: candidate.shape?.brightnessOffset ?? null,
    alignX: candidate.shape?.alignX ?? null,
    alignY: candidate.shape?.alignY ?? null,
    largestComponentSize: candidate.shape?.largestComponentSize ?? null,
    largestComponentRatio: candidate.shape?.largestComponentRatio ?? null,
    diagonalRatio: candidate.shape?.diagonalRatio ?? null,
  }));

  const best = scoredCandidates[0];
  const second = scoredCandidates[1];
  const evidence: DecisionTraceContext = {
    field: group.field,
    boundsSource: image.contentBoundsSource ?? 'none',
    boundsWidth: ((image.contentBounds?.right ?? image.width)
      - (image.contentBounds?.left ?? 0)) / image.width,
    paperBoundsThreshold: image.paperBoundsThreshold,
    boundsRejection: image.contentBoundsRejection,
    usesBaseline,
    usesGridCells,
    scores: candidates.map((candidate) => candidate.score),
    ranked: scoredCandidates,
    best,
    gap: 0,
    relativeContrast: 0,
    highScoreThreshold: 0,
    highGapThreshold: 0,
    mediumScoreThreshold: 0,
    mediumGapThreshold: 0,
    requireHighVisualConfidence,
    pageCalibration,
  };

  if (!best) {
    return {
      field: group.field,
      confidence: 'low',
      contested: false,
      candidates,
      candidateMeasurements,
      decision: describeDecision(evidence, 'low', ['no-candidates']),
      evidence: evidence.published,
    };
  }

  // A fallback content bound may still produce plausible-looking candidate scores.
  // Never turn those scores into automatic data when the page frame was not trusted.
  // The runner-up enters both margin tests at its pre-invariant score. That is
  // what makes this unit a pure tightening: `best.score` can only fall and the
  // denominator cannot, so `gap` and `relativeContrast` are both monotonically
  // non-increasing and no gate below can newly pass. Zeroing a runner-up would
  // otherwise widen the winner's margin -- and send `relativeContrast` to
  // infinity -- which is manufacturing evidence out of a refusal.
  const gap = best.score - (second?.residualScore || 0);
  // Printed circles and rules do not cancel perfectly: the blank form is a
  // 200dpi scan while an uploaded page is rendered at roughly half that, so
  // every option keeps a similar floor of leftover ink. That floor makes the
  // absolute gap meaningless -- on a real scan `satisfaction.q01` scored
  // 0.0500 / 0.0439 / 0.0423 / 0.0225 and the unmarked option 1 won by 0.0077,
  // well past the 0.004 gap rule. A real mark instead multiplies the runner-up
  // (1.9x on the same field's correct pages) because the leftover floor is
  // common to every option while pen ink is not.
  //
  // 1.25 is the largest threshold that costs no correct answer on the six-page
  // answer key (1.15-1.25 both give CORRECT 92 WRONG 0; 1.35 drops to 87), so
  // it maximizes the margin against unseen pages without trading accuracy. The
  // one measured wrong answer sat at 1.14.
  const relativeContrast = second && second.residualScore > 0
    ? best.score / second.residualScore
    : Number.POSITIVE_INFINITY;
  // The baseline score now acts only as a minimum signal floor. For a real
  // mark, the residual must also form a compact, stroke-like shape. This is
  // deliberately shared by every baseline-backed candidate; it does not know
  // the field name or the candidate index.
  // The relative-contrast rule below compares the best option with the runner
  // up, which is meaningless when both are noise. On one real page the
  // satisfaction marks were six times fainter than normal (0.011 against 0.067
  // elsewhere), the printed residue at 0.020 outscored the real mark, and the
  // 1.8x ratio confirmed it as a wrong answer. A floor keeps that comparison
  // from running at all until there is a real signal to compare.
  const baseHighScoreThreshold = usesBaseline ? HIGH_ABSOLUTE_SIGNAL : 0.35;
  const baseMediumScoreThreshold = usesBaseline ? 0.007 : 0.1;
  // A two-candidate group on a photo sheet answers to a higher minimum. Applied
  // as a maximum against the thresholds that already exist so it can only ever
  // raise one: on the raw-density path both are already above it and nothing
  // moves at all.
  const photoBinaryFloor = photoProvenance && scoredCandidates.length === 2
    ? PHOTO_BINARY_FLOOR
    : 0;
  const highScoreThreshold = Math.max(baseHighScoreThreshold, photoBinaryFloor);
  const highGapThreshold = usesBaseline ? 0.004 : 0.12;
  const mediumScoreThreshold = Math.max(baseMediumScoreThreshold, photoBinaryFloor);
  const mediumGapThreshold = usesBaseline ? 0.003 : 0.025;
  // The rescue route below reads no floor of its own, so the raised one has to
  // be handed to it separately or a binary group would walk under it there.
  const belowPhotoBinaryFloor = photoBinaryFloor > 0 && !(best.score >= photoBinaryFloor);

  evidence.gap = gap;
  evidence.relativeContrast = relativeContrast;
  evidence.highScoreThreshold = highScoreThreshold;
  evidence.highGapThreshold = highGapThreshold;
  evidence.mediumScoreThreshold = mediumScoreThreshold;
  evidence.mediumGapThreshold = mediumGapThreshold;

  if (!allowAutoValue) {
    // The caller ands two independent preconditions together and passes only
    // the conjunction, so this branch used to report `form-boundary-unverified`
    // for either of them. Re-checking the half that lives in this file
    // separates them: if the form bounds are usable, the grid is what refused,
    // and that is a different file and a different fix.
    const formBounds = resolveFormBoundsStatus(image);
    // No review suggestion here, and the scope is measured rather than
    // cautious. The 192 refused groups §31 ranked are the ones whose geometry
    // was trusted and whose *scoring* declined; the groups that got here
    // instead are the ~21 per set the grid never verified (§30.1), and they
    // were not in that sample. Ranking boxes that may not be the answer boxes
    // is a different question with no measurement behind it.
    return {
      field: group.field,
      confidence: 'low',
      contested: false,
      candidates,
      candidateMeasurements,
      decision: describeDecision(
        evidence,
        'low',
        [formBounds.usable ? 'grid-unverified' : `form-bounds:${formBounds.reason}`],
      ),
      evidence: evidence.published,
    };
  }

  const hasStructuredMark = !usesBaseline || hasStructuredTemplateMark(best.shape);
  const rescue = rescueConfidence(best.shape as TemplateInkFeatures | undefined,
    second?.shape as TemplateInkFeatures | undefined);

  // Which of the four high-confidence tests refused, recorded as they are
  // evaluated. This reads the same values the condition below reads and
  // decides nothing.
  const refused: string[] = [];
  // Named separately from `absolute-floor`, which is where a zeroed winner
  // otherwise lands: those are different facts. `absolute-floor` says the
  // signal was too weak to trust; this says there was no added ink to measure
  // at all, and only the second is an invariant.
  // Photo sheets only, and the measurement is why. Enforced on every path, the
  // invariant cost the scan set 21 correct cells (node 355 -> 334) while
  // removing 2 wrong ones -- so on scans `actualInk <= baselineInk` does NOT
  // mean "nothing was added". A thin tick adds ink in a handful of samples
  // while the box as a whole still reads lighter than the blank asset's
  // printed circle, because the two rasters render that circle at different
  // weights. The aggregate comparison is confounded by the printed content,
  // and §14.2 over-read it as an invariant of the differential itself.
  //
  // Measured again on photos with the linear path: the same guard cost 33
  // correct cells there too (59 -> 26), so the confound is the raster pair, not
  // the scanner. The guard belongs to the affine package alone.
  //
  // What the measurement does support is the narrower claim: under the affine
  // tone map, stretching the photo's darkest tone onto the blank's manufactures
  // per-sample residual in a box nothing was added to -- that is how
  // `p3 basic.gender`, a cell the key marks blank, came to be filled from a box
  // measuring 0.099 against the blank's 0.112. Photo provenance is exactly the
  // condition under which that stretch happens, so the guard is scoped to it
  // and the scan path keeps the behaviour its baseline was measured on.
  const bestInkInvariantZeroed = affineToneEnabled() && photoProvenance
    && best.shape?.inkInvariantZeroed === true;
  if (bestInkInvariantZeroed) refused.push('ink-invariant');
  if (!(best.score >= highScoreThreshold)) refused.push('absolute-floor');
  if (!(gap >= highGapThreshold)) refused.push('gap');
  if (!hasStructuredMark) refused.push('mark-shape');
  if (usesBaseline && !(relativeContrast >= HIGH_RELATIVE_CONTRAST)) refused.push('relative-contrast');
  // Named separately, and only where it changed the answer: the base floor
  // would have admitted this score and the photo-binary one did not. That makes
  // a trace run count exactly what this constant costs, rather than leaving it
  // inside `absolute-floor` with every other refusal.
  if (belowPhotoBinaryFloor && best.score >= baseHighScoreThreshold) {
    refused.push('photo-binary-floor');
  }

  // Ahead of every route that can put a value on the page -- the high
  // conjunction, the rescue, and the medium path all sit below this -- because
  // the whole point is that those routes see healthy margins on a band that is
  // not on the answer row at all. It can only take a value away: nothing below
  // reads `offRowBand`, no threshold moves, and a group it does not refuse
  // reaches the same tests with the same numbers it did before.
  //
  // Template ink only. The raw-density path has no `actualInk` to read, and a
  // density reading is not the same measurement, so it is left alone.
  // Photo sheets only: the off-row signature comes from a warped photo's band
  // landing on printed text, and on scans the same shape occurs benignly —
  // enabling it there measurably cost 4 correct cells for zero WRONG change.
  const bandInks = photoProvenance && usesBaseline
    ? scoredCandidates.map((candidate) => candidate.shape?.actualInk)
    : [];
  const offRowBand = photoProvenance && usesBaseline && bandInks.length > 0
    && bandInks.every((ink) => typeof ink === 'number')
    ? detectOffRowBand(bandInks as number[], 0)
    : null;
  if (offRowBand) {
    refused.push('band-structure');
    evidence.band = { ...offRowBand, inks: bandInks as number[] };
    // No review suggestion. This refusal's own finding is that the band being
    // measured is not the answer row, so the best box in it is not an answer
    // and offering it as a default would be pointing the reviewer at the wrong
    // part of the page.
    return {
      field: group.field,
      confidence: 'low',
      contested: false,
      candidates,
      candidateMeasurements,
      decision: describeDecision(evidence, 'low', refused),
      evidence: evidence.published,
    };
  }

  // A two-candidate group on a photo sheet reaches no automatic value at all.
  //
  // Spec §14.1: with the affine tone map armed, the binary questions produced
  // 27 automatic values over the 19 photo sheets, 21 correct and 6 wrong, and
  // every wrong one was the *other box winning outright* -- not a weak reading
  // that a floor could cut away. Three features looked like they separated the
  // two classes at 26 of 27 (blank ink, edgeFraction, bcoreFill) and all three
  // turned out to be restatements of which position won: the answer key holds
  // 26 ones against a single zero, and the blank form's ink is fully determined
  // by position (pos1 0.079-0.090, pos2 0.057-0.069). The rule they encode is
  // "always answer 1". So no measured per-box feature discriminates, and the
  // answer is not a better rule but refusal. `WRONG = 0` outranks correct
  // count; the price is the 21.
  //
  // Placed here on purpose: every route that can put a value on the page sits
  // below it -- the high conjunction, the rescue, and the medium path -- which
  // is the same set `PHOTO_BINARY_FLOOR` had to cover (it reached the first
  // through `highScoreThreshold`, the second through `belowPhotoBinaryFloor`,
  // and the third through `mediumScoreThreshold`). It sits *after* the
  // band-structure refusal so a group that check already refuses keeps
  // reporting that reason, with its ink readings, rather than this one.
  //
  // It can only take a value away. Nothing below reads it, no threshold moves,
  // and a group it does not refuse reaches the same tests with the same
  // numbers. `refused` already carries whichever high-conjunction tests would
  // have declined anyway, so a trace run can tell a cell this rule really cost
  // from one that was never going to be filled.
  //
  // Photo sheets only, so a scan takes the byte-identical path it took before.
  //
  // And only while the affine tone map is armed, which is the measurement it
  // was commissioned from: §14.1's six wrong binary reads all appear under that
  // map. On the shipped linear path the same questions auto-fill with the
  // measured floor and produced no wrong value at all, and refusing them there
  // cost 36 correct cells on the 19-student set (59 -> 23) for nothing. A
  // refusal is still a cost, and it is only worth paying where the failure it
  // prevents actually occurs.
  if (photoProvenance && affineToneEnabled() && group.candidates.length === 2 && photoBinaryRefusalEnabled()) {
    refused.push('photo-binary-refused');
    // No review suggestion, and this one is the sharpest case. Spec §14.1
    // measured "the ranking is right" on exactly these groups and got 21 of 27
    // -- every wrong one the other box winning outright. A default offered here
    // would be that measured-bad rule wearing the 83% badge, on a population
    // where 83% was never observed.
    return {
      field: group.field,
      confidence: 'low',
      contested: false,
      candidates,
      candidateMeasurements,
      decision: describeDecision(evidence, 'low', refused),
      evidence: evidence.published,
    };
  }

  if (
    best.score >= highScoreThreshold
    && gap >= highGapThreshold
    && hasStructuredMark
    && (!usesBaseline || relativeContrast >= HIGH_RELATIVE_CONTRAST)
  ) {
    const contested = isContestedHighConfidenceRunnerUp(second);
    return {
      field: group.field,
      value: best.value,
      confidence: 'high',
      contested,
      candidates,
      candidateMeasurements,
      decision: describeDecision(evidence, 'high', refused, contested),
      evidence: evidence.published,
    };
  }

  // A second route to the same confidence, for cells the four thresholds refuse
  // on their own. It never overrides a decision -- it only runs after the
  // conjunction above has already declined -- so nothing the gate accepts today
  // can change, and only refused cells can move.
  //
  // `belowPhotoBinaryFloor` is the one thing it is not allowed to overrule.
  // Its weights read shape and fit, not signal strength, so a two-candidate
  // photo group under the raised floor is precisely the case it would rescue
  // -- and the floor exists because those readings were wrong as often as they
  // were right.
  //
  // `bestInkInvariantZeroed` is the second thing it may not overrule, and for
  // the same reason: its weights read shape and fit, never signal strength, so
  // it is the one route that would still confirm a box the invariant emptied.
  // The floors below and above both refuse a zero score on their own.
  if (
    usesBaseline
    && !belowPhotoBinaryFloor
    && !bestInkInvariantZeroed
    && rescue !== null
    && rescue >= RESCUE_THRESHOLD
  ) {
    refused.push(`rescued:${rescue.toFixed(2)}`);
    const contested = isContestedHighConfidenceRunnerUp(second);
    return {
      field: group.field,
      value: best.value,
      confidence: 'high',
      contested,
      candidates,
      candidateMeasurements,
      decision: describeDecision(evidence, 'high', refused, contested),
      evidence: evidence.published,
    };
  }

  // A verified table cell lets us use a lower medium threshold for a clear
  // hand-drawn ring. Sensitive fields can opt out and remain manual unless
  // the stricter high-confidence rule above is met. `mediumScoreThreshold`
  // already carries the photo-binary floor where it applies, so this path
  // cannot admit a score the high one refused for being under it.
  if (!requireHighVisualConfidence && best.score >= mediumScoreThreshold && gap >= mediumGapThreshold) {
    // Medium reaches no automatic value either -- `detectCheckmarks` requires
    // `high` -- so this group arrives at the review screen empty, exactly like
    // the `low` return below, and gets the same default offered.
    const suggestion = buildReviewSuggestion(scoredCandidates, usesBaseline);
    return {
      field: group.field,
      value: best.value,
      confidence: 'medium',
      contested: false,
      suggestion,
      candidates,
      candidateMeasurements,
      decision: describeDecision(evidence, 'medium', refused, false, suggestion),
      evidence: evidence.published,
    };
  }

  if (requireHighVisualConfidence) refused.push('medium-path-not-offered');
  if (!(best.score >= mediumScoreThreshold)) refused.push('medium-floor');
  if (!(gap >= mediumGapThreshold)) refused.push('medium-gap');

  const suggestion = buildReviewSuggestion(scoredCandidates, usesBaseline);
  return {
    field: group.field,
    confidence: 'low',
    contested: false,
    suggestion,
    candidates,
    candidateMeasurements,
    decision: describeDecision(evidence, 'low', refused, false, suggestion),
    evidence: evidence.published,
  };
}

/**
 * Scores only ink that is present in the submitted form but not in the
 * measured blank template. This removes the printed answer glyph and table
 * rules from the decision, which otherwise dominate small hand-drawn circles.
 *
 * Returns the score after the total-ink invariant, which is the number the
 * gate decides on: 0 for a box whose page ink does not exceed the blank's.
 * See `TEMPLATE_INK_INVARIANT_EPSILON`.
 */
export function calculateTemplateInkDifference(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  actualRect: PixelRect,
  baseline: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  baselineRect: PixelRect,
): number {
  return calculateTemplateInkFeatures(image, actualRect, baseline, baselineRect).score;
}

/**
 * How a choice group's tones are mapped onto the blank form's before any ink
 * is counted. See `createGroupToneCorrection` for why it is one correction for
 * the group rather than one per box.
 *
 * Two shapes, and the linear one is the special case: `applyTone` at
 * `gain === 1` is exactly `value + shift`, the correction every sheet took
 * before 2026-08-27 and the only one a scan can ever take.
 *
 * Measured (FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27 §12.2), over the twelve
 * photo students who produced no automatic value at all: the winner box's page
 * ink has median 0.000 against a blank-template median of 0.096 -- the
 * photographed box reads emptier than the printed circle underneath it -- and
 * 0 of 263 boxes clear the 0.08 differential margin. Their per-box
 * `brightnessOffset` reaches 185 where no productive student exceeds 61, which
 * puts those pages' 82nd percentile around grey 70. `darkness()` returns 0
 * from 178 up, so adding 185 carries paper at 70 and a mark at 50 over that
 * edge together: a shift cannot separate two tones because it moves them
 * equally. Stretching the range can, which is what the affine mode is.
 */
interface ToneCorrection {
  mode: 'linear' | 'affine';
  /** `blank p82 - actual p82`: the shift the linear correction applies. */
  shift: number;
  /** The dark anchor, on the page and on the blank form. */
  actualLo: number;
  blankLo: number;
  /** The paper anchor, on the page and on the blank form. */
  actualHi: number;
  blankHi: number;
  /** Blank-form levels per page level. Exactly 1 on the linear path. */
  gain: number;
  /** Why the map was declined, when it was. Null on a scan and on the map. */
  fallback: string | null;
  /** What `describeDecision` prints, so the path taken is never silent. */
  label: string;
}

interface MatchedScoreInput {
  actual: number[];
  blank: number[];
  width: number;
  height: number;
  tone: ToneCorrection;
  offsetX: number;
  offsetY: number;
  radiusX: number;
  radiusY: number;
}

/**
 * The two anchors, as percentiles of the samples.
 *
 * PROVISIONAL. The checkout that wrote them has neither scans nor an answer
 * key; the central measurement calibrates or rejects them.
 *
 * The paper anchor is 0.82 because that is the percentile `brightnessOffset`
 * has always been defined on, so the two corrections are the same function at
 * `gain === 1` and differ only in slope. `BrightnessReferenceProbe` already
 * carries a 0.95 pair if a cleaner paper anchor measures better.
 *
 * The dark anchor is 0.05 because §12.2 measured a blank-template ink median
 * of 0.096 per box -- roughly a tenth of a box is printed glyph -- so the 5th
 * percentile of the blank form's samples lands inside printed ink rather than
 * on paper, which is the whole reason it can serve as an anchor. Where it does
 * not, `blankSpan` collapses and the correction falls back to the shift. It is
 * read over the group's cells together, which is also what keeps a student's
 * pen mark (about 1% of the pooled samples) from becoming its own anchor.
 */
const TONE_LOW_PERCENTILE = 0.05;
const TONE_HIGH_PERCENTILE = 0.82;

/**
 * The fixed grid every cell is resampled onto before it is scored. Named
 * because the tonal anchors have to be read off the same samples the scorer
 * reads, or the correction would be calibrated on pixels nothing scores.
 */
const TEMPLATE_SAMPLE_WIDTH = 36;
const TEMPLATE_SAMPLE_HEIGHT = 28;

/**
 * The narrowest anchor separation that may be divided by, in grey levels.
 * PROVISIONAL. Below this the two anchors are one reading with noise between
 * them and the gain they imply is arbitrary, so the shift is used instead.
 */
const TONE_MIN_SPAN = 8;

/**
 * The most a page's range may be stretched. PROVISIONAL.
 *
 * §12.2's worst sheet sits at a p82 near grey 70 against a blank p82 near 255,
 * so the stretch those pages ask for is single-digit; 12 leaves room above the
 * measured worst case while stopping a nearly-degenerate span from licensing
 * unbounded amplification of the paper's own grain. The cap changes only how
 * far the dark half of the range is pulled down -- the paper anchor still
 * lands on the blank's paper anchor at any gain -- and a capped correction is
 * marked `!` in the trace.
 */
const TONE_MAX_GAIN = 12;

/**
 * One raw sample (0-255) mapped onto the blank form's tonal range.
 *
 * The affine branch is written about the paper anchor rather than the dark
 * one. `blankLo + (v - actualLo) * gain` is the same line whenever `gain` is
 * the ratio of the two spans, and this form additionally keeps
 * `actualHi -> blankHi` true when TONE_MAX_GAIN has reduced the slope.
 *
 * The linear branch is `value + shift` and nothing else -- no clamp, no
 * arithmetic that was not there before -- because every scan takes it and the
 * scan measurement is byte-exact. (The affine clamp is a no-op through
 * `darkness`, which saturates outside 0..178 anyway; it is there so the mapped
 * value is a grey level rather than an extrapolation.)
 */
function applyTone(tone: ToneCorrection, value: number): number {
  if (tone.mode === 'linear') {
    return value + tone.shift;
  }
  return clamp(tone.blankHi + (value - tone.actualHi) * tone.gain, 0, 255);
}

/**
 * The correction as it was before this file knew about photographs.
 *
 * `fallback` is the group-level reason, when there was one, so a box scored
 * through the shift on a photo sheet still says why in the trace.
 */
function linearTone(shift: number, fallback: string | null = null): ToneCorrection {
  return {
    mode: 'linear',
    shift,
    actualLo: 0,
    blankLo: 0,
    actualHi: 0,
    blankHi: 0,
    gain: 1,
    fallback,
    label: `linear(${shift.toFixed(0)}${fallback ? `,${fallback}` : ''})`,
  };
}

/**
 * Chooses the correction from a set of page samples and the blank form's.
 *
 * `photoProvenance === false` returns the shift before anything else is even
 * measured, so no scan can reach the two-point map by any route.
 *
 * Three refusals, each stated as a negation so that a NaN anchor takes the
 * shift rather than the map:
 *
 *   `span`       the page's own anchors are too close to divide by;
 *   `blank-span` the blank form has no tonal range to map onto, which is what
 *                a cell with almost no printed content looks like;
 *   `flat`       the page's range is already as wide as the blank's, so there
 *                is nothing to stretch. A healthy photograph lands here and
 *                takes exactly the correction it took before.
 */
function createToneCorrection(
  actual: number[],
  blank: number[],
  photoProvenance: boolean,
): ToneCorrection {
  const actualHi = percentile(actual, TONE_HIGH_PERCENTILE);
  const blankHi = percentile(blank, TONE_HIGH_PERCENTILE);
  const shift = blankHi - actualHi;
  if (!photoProvenance) {
    return linearTone(shift);
  }

  const actualLo = percentile(actual, TONE_LOW_PERCENTILE);
  const blankLo = percentile(blank, TONE_LOW_PERCENTILE);
  const actualSpan = actualHi - actualLo;
  const blankSpan = blankHi - blankLo;
  const rawGain = actualSpan > 0 ? blankSpan / actualSpan : 0;

  let fallback: string | null = null;
  if (!(actualSpan >= TONE_MIN_SPAN)) fallback = 'span';
  else if (!(blankSpan >= TONE_MIN_SPAN)) fallback = 'blank-span';
  else if (!(rawGain > 1)) fallback = 'flat';

  if (fallback) {
    // The spans are printed with the reason: a fallback whose numbers cannot
    // be read is a silent change, which is the thing this label exists to
    // prevent.
    const reason = `${fallback}=${actualSpan.toFixed(0)}/${blankSpan.toFixed(0)}`;
    return {
      ...linearTone(shift, reason),
      actualLo,
      blankLo,
      actualHi,
      blankHi,
    };
  }

  const gain = Math.min(rawGain, TONE_MAX_GAIN);
  return {
    mode: 'affine',
    shift,
    actualLo,
    blankLo,
    actualHi,
    blankHi,
    gain,
    fallback: null,
    label: `affine(${actualLo.toFixed(0)},${actualHi.toFixed(0)}`
      + `->${blankLo.toFixed(0)},${blankHi.toFixed(0)}`
      + `,g=${gain.toFixed(2)}${gain < rawGain ? '!' : ''})`,
  };
}

/**
 * One correction for a whole choice group, pooled over its candidate boxes.
 *
 * Measured, and the reason this is not per box: over 120 synthetic groups the
 * per-box version put boxes of the SAME group on different scales -- one box
 * mapped at 1.41x while its neighbour fell back to the shift, because the
 * neighbour's blank cell held too little printed ink to have a dark anchor --
 * and the winner then changed on 6 of 240 decisions. Every rule above this
 * compares boxes with each other (`gap`, `relativeContrast`, the band check),
 * so two boxes measured on different scales is a wrong value waiting to
 * happen, which `WRONG = 0` does not allow.
 *
 * Pooling also makes the dark anchor sturdier: over four or five cells a pen
 * mark is about 1% of the samples, well under `TONE_LOW_PERCENTILE`, so the
 * anchor is the printed form rather than the student's answer.
 *
 * Returns `undefined` for a scan and for a group the map declined, and both of
 * those mean the same thing downstream: every box computes its own shift, as
 * it did before this existed.
 */
/**
 * Off by default -- the affine map is measured, kept, and NOT shipped.
 *
 * On the 19-student photo set it recovered a great deal of signal that the
 * linear shift was destroying (auto-filled correct cells 59 -> 122, blanks
 * 392 -> 322), which is the direction §12.2 predicted. It also produced eight
 * wrong values where there had been none, and those cannot be gated away with
 * what the scorer currently measures: six are binary questions where the wrong
 * box simply won (got 0, key says 1) with scores 0.044-0.154 fully interleaved
 * with the correct reads' 0.043-0.226, and one fills `p3 basic.gender`, a cell
 * the key marks blank -- the failure CLAUDE.md §3 puts above every other
 * number. §5.4 rejects a change that raises wrong values however far correct
 * ones rise, so the shipped path stays on the linear shift.
 *
 * The code stays behind this flag as a neutral instrument (CLAUDE.md §1.4's
 * second exception) so the next cycle can measure variants -- gating the map on
 * evidence of underexposure, refusing binary groups under it, re-cutting the
 * band and binary constants that were calibrated on linear-corrected ink --
 * without rebuilding it. Set MARK_AFFINE_TONE=1 to measure.
 *
 * The second of those is now built, and unconditionally rather than only under
 * this flag: see `photoBinaryRefusalEnabled` and spec §14.1. A two-candidate
 * photo group is refused whichever tone map it was measured through.
 */
function affineToneEnabled(): boolean {
  return typeof process !== 'undefined' && Boolean(process.env?.MARK_AFFINE_TONE);
}

function createGroupToneCorrection(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  actualRects: PixelRect[],
  baseline: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  baselineRects: PixelRect[],
  photoProvenance: boolean,
): ToneCorrection | undefined {
  if (!affineToneEnabled()) {
    return undefined;
  }
  if (!photoProvenance || actualRects.length === 0 || actualRects.length !== baselineRects.length) {
    return undefined;
  }
  const actual: number[] = [];
  const blank: number[] = [];
  for (let index = 0; index < actualRects.length; index++) {
    const box = sampleRect(image, actualRects[index], TEMPLATE_SAMPLE_WIDTH, TEMPLATE_SAMPLE_HEIGHT);
    const blankBox = sampleRect(baseline, baselineRects[index], TEMPLATE_SAMPLE_WIDTH, TEMPLATE_SAMPLE_HEIGHT);
    if (box.length === 0 || blankBox.length === 0) {
      return undefined;
    }
    for (const sample of box) actual.push(sample);
    for (const sample of blankBox) blank.push(sample);
  }
  return createToneCorrection(actual, blank, true);
}

/**
 * The correction one cell is measured through.
 *
 * A group correction is used only when it resolved to the map. Where it did
 * not -- a scan, or a group whose pooled anchors were degenerate -- the cell
 * computes its own shift, which is the arithmetic every cell had before, and
 * carries the group's reason into its label so the trace still explains it.
 */
function resolveTone(
  actual: number[],
  blank: number[],
  groupTone: ToneCorrection | undefined,
): ToneCorrection {
  if (groupTone && groupTone.mode === 'affine') {
    return groupTone;
  }
  const shift = percentile(blank, TONE_HIGH_PERCENTILE) - percentile(actual, TONE_HIGH_PERCENTILE);
  return linearTone(shift, groupTone?.fallback ?? null);
}

/**
 * The pure half of the tonal correction, for tests and for any caller that
 * needs to reproduce what a reading was measured through. Returns the mapped
 * grey level and the label the trace would carry.
 */
export function normalizeTone(
  actual: number[],
  blank: number[],
  photoProvenance: boolean,
): {
  apply: (value: number) => number;
  mode: 'linear' | 'affine';
  shift: number;
  gain: number;
  label: string;
} {
  const tone = createToneCorrection(actual, blank, photoProvenance);
  return {
    apply: (value: number) => applyTone(tone, value),
    mode: tone.mode,
    shift: tone.shift,
    gain: tone.gain,
    label: tone.label,
  };
}

/**
 * How far a box's aggregate page ink must exceed the blank form's before its
 * differential residual is allowed to stand. **Zero, deliberately.**
 *
 * Differential scoring rests on one premise: count only what the student
 * ADDED. A box carrying no more total ink than the blank form has nothing
 * added, whatever the per-sample arithmetic says. That premise is an
 * invariant, not a threshold, so the comparison is exact.
 *
 * It was measured broken. `Task/FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27.md`
 * §14.2: the winning box of `p3 basic.gender` -- a cell the answer key marks
 * blank, and filling it is the failure CLAUDE.md §3 ranks above every other
 * number -- read
 *
 *     page=0.099  blank=0.112   scr=0.056   tone=affine(53,209->0,255,g=1.63)
 *
 * Less total ink than the blank form, and a positive residual anyway. The two
 * quantities are summed over the same samples in the same loop below, so they
 * are directly comparable; what lets them disagree in sign is that the
 * aggregates are two-sided while the residual is `max(0, actual - baseline -
 * 0.08)` per sample. Clipping discards every sample where the page is lighter,
 * so a box that is darker in a few places and lighter everywhere else still
 * accumulates a positive score. Stretching a photograph's darkest tone onto
 * the blank's (§13) manufactures exactly that arrangement in an unmarked box,
 * but the invariant is not a property of the affine map -- it has to hold
 * whichever correction ran, which is why this is unconditional.
 *
 * A non-zero epsilon here would be a signal threshold, and there is no
 * measurement to cut one on. Leave it at 0 unless someone measures otherwise.
 */
const TEMPLATE_INK_INVARIANT_EPSILON = 0;

function calculateResidualInk(
  actualInk: number,
  baselineInk: number,
  pageCalibration?: PageInkCalibration,
): number {
  if (pageCalibration) {
    return Math.max(0, actualInk - baselineInk * pageCalibration.gain - pageCalibration.margin);
  }
  // Keep the legacy expression as its own branch: with no calibration this is
  // the byte-identical rule used by bilevel scans and photos.
  return Math.max(0, actualInk - baselineInk - 0.08);
}

function calculateTemplateInkFeatures(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  actualRect: PixelRect,
  baseline: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  baselineRect: PixelRect,
  // The group's correction, from `analyzeChoiceGroup`. Absent here means the
  // cell computes its own shift, which is what a scan does and what this
  // function did for every caller before photographs existed.
  groupTone?: ToneCorrection,
  pageCalibration?: PageInkCalibration,
): TemplateInkFeatures {
  const sampleWidth = TEMPLATE_SAMPLE_WIDTH;
  const sampleHeight = TEMPLATE_SAMPLE_HEIGHT;
  const actual = sampleRect(image, actualRect, sampleWidth, sampleHeight);
  const blank = sampleRect(baseline, baselineRect, sampleWidth, sampleHeight);
  if (actual.length === 0 || blank.length === 0) {
    return {
      score: 0,
      // Nothing was sampled, so nothing was removed. The invariant did not
      // act here and must not claim to have.
      residualScore: 0,
      inkInvariantZeroed: false,
      largestComponentSize: 0,
      largestComponentRatio: 0,
      diagonalRatio: 0,
      actualInk: 0,
      baselineInk: 0,
      brightnessOffset: 0,
      tone: 'linear(0)',
      alignX: 0,
      alignY: 0,
      pagePitchX: 0,
      pagePitchY: 0,
      blankPitchX: 0,
      blankPitchY: 0,
      radiusX: BASELINE_ALIGNMENT_RADIUS,
      radiusY: BASELINE_ALIGNMENT_RADIUS,
      stepsX: 1,
      stepsY: 1,
      fit: 0,
      edges: { edgeShare: 0, edgeFraction: 0 },
    };
  }

  // Different scanners change the paper's overall brightness. Normalize only
  // the light background before comparing dark ink, keeping local pen strokes.
  //
  // On a scan this is still exactly `percentile(blank, 0.82) - percentile(
  // actual, 0.82)` applied as a shift. On a photographed sheet it may instead
  // be the group's two-point map, because a shift large enough to correct a
  // badly underexposed page carries the marks over the ink threshold with the
  // paper (§12.2). Every reading below goes through the same `tone`, so the
  // page and the alignment search cannot be corrected two different ways.
  const tone = resolveTone(actual, blank, groupTone);
  const brightnessOffset = tone.shift;
  const pagePitchX = (actualRect.right - actualRect.left) / sampleWidth;
  const pagePitchY = (actualRect.bottom - actualRect.top) / sampleHeight;
  // The reach is set from the page's own pitch, because the registration error
  // to be absorbed is measured in the page's pixels.
  const radiusX = alignmentRadius(pagePitchX);
  const radiusY = alignmentRadius(pagePitchY);
  // The offset is resolved to a fraction of a sample wherever the grid
  // oversamples the page, because that is where a fractional misregistration
  // can exist at all.
  const stepsX = alignmentSteps(pagePitchX);
  const stepsY = alignmentSteps(pagePitchY);
  const alignment = findBestBaselineAlignment(
    actual,
    blank,
    sampleWidth,
    sampleHeight,
    tone,
    radiusX,
    radiusY,
    stepsX,
    stepsY,
  );
  const residual = new Float32Array(sampleWidth * sampleHeight);
  let difference = 0;
  // Totals either side of the subtraction. They change nothing; they are what
  // makes "the baseline removed almost all of it" distinguishable from "there
  // was almost nothing there" once a group is refused.
  let actualTotal = 0;
  let baselineTotal = 0;

  for (let y = radiusY; y < sampleHeight - radiusY; y++) {
    for (let x = radiusX; x < sampleWidth - radiusX; x++) {
      const index = y * sampleWidth + x;
      const actualInk = darkness(applyTone(tone, actual[index]));
      const baselineInk = darkness(
        sampleGridAt(blank, sampleWidth, sampleHeight, x + alignment.x, y + alignment.y),
      );
      actualTotal += actualInk;
      baselineTotal += baselineInk;
      // The subtrahend, and only the subtrahend. Under MARK_BASELINE_DILATE the
      // printed ink is grown by one sample before it is taken away, so a
      // glyph edge that the whole-sample alignment left one sample off no
      // longer survives as residual. The totals above are already banked, so
      // the ink ratio, the total-ink invariant and every gate keep reading the
      // undilated baseline -- the flag moves the subtraction, nothing else.
      const subtrahendInk = baselineDilationEnabled()
        ? dilatedBaselineInk(
          blank,
          sampleWidth,
          sampleHeight,
          x + alignment.x,
          y + alignment.y,
        )
        : baselineInk;
      // Ignore the narrow anti-aliasing and scanner-noise band around the
      // printed form. A handwritten circle or check remains well above it.
      const residualInk = calculateResidualInk(actualInk, subtrahendInk, pageCalibration);
      residual[index] = residualInk;
      difference += residualInk;
    }
  }

  // Counted, not assumed: a cell inset further contributes fewer samples and
  // must be divided by fewer, or its score would shrink for no reason.
  const usablePixels = Math.max((sampleWidth - 2 * radiusX) * (sampleHeight - 2 * radiusY), 1);
  const shape = analyzeResidualShape(residual, sampleWidth, sampleHeight);
  const actualInk = actualTotal / usablePixels;
  const baselineInk = baselineTotal / usablePixels;
  const residualScore = difference / usablePixels;
  // The total-ink invariant. Both totals come from the loop above -- same
  // samples, same window, same tone, same alignment, same `darkness` scale --
  // so this comparison is the aggregate form of the very subtraction that
  // produced `difference`. See `TEMPLATE_INK_INVARIANT_EPSILON`.
  const inkInvariantZeroed = actualInk <= baselineInk + TEMPLATE_INK_INVARIANT_EPSILON;
  return {
    score: inkInvariantZeroed ? 0 : residualScore,
    residualScore,
    inkInvariantZeroed,
    ...shape,
    actualInk,
    baselineInk,
    brightnessOffset,
    tone: tone.label,
    alignX: alignment.x,
    alignY: alignment.y,
    pagePitchX,
    pagePitchY,
    blankPitchX: (baselineRect.right - baselineRect.left) / sampleWidth,
    blankPitchY: (baselineRect.bottom - baselineRect.top) / sampleHeight,
    radiusX,
    radiusY,
    stepsX,
    stepsY,
    fit: alignment.fit,
    brightnessProbe: isTracing()
      ? measureBrightnessReference(
        actual,
        blank,
        sampleWidth,
        sampleHeight,
        radiusX,
        radiusY,
        stepsX,
        stepsY,
        pageCalibration,
      )
      : undefined,
    insetSignal: isTracing()
      ? calculateInsetResidualSignal(image, actualRect, baseline, baselineRect, pageCalibration)
      : undefined,
    blankGeometry: isTracing()
      ? measureBlankInkGeometry(
        blank,
        sampleWidth,
        sampleHeight,
        radiusX,
        radiusY,
        alignment.x,
        alignment.y,
      )
      : undefined,
    probe: isTracing()
      ? probeAlignment(actual, blank, sampleWidth, sampleHeight, tone, alignment.x, alignment.y)
      : undefined,
    edges: analyzeResidualEdges(
      actual, blank, sampleWidth, sampleHeight, tone,
      alignment.x, alignment.y, radiusX, radiusY,
    ),
    composition: isTracing()
      ? analyzeResidualComposition(
        actual,
        blank,
        sampleWidth,
        sampleHeight,
        tone,
        alignment.x,
        alignment.y,
        radiusX,
        radiusY,
      )
      : undefined,
    matchedScoreInput: {
      actual,
      blank,
      width: sampleWidth,
      height: sampleHeight,
      tone,
      offsetX: alignment.x,
      offsetY: alignment.y,
      radiusX,
      radiusY,
    },
  };
}

/**
 * The cheap half of `analyzeResidualComposition`, run on every cell.
 *
 * Only the two numbers a decision reads: how much of the leftover disagreement
 * sits on a printed edge, and how much of the cell is printed edge to begin
 * with. No softened copies and no matched score, so this costs one pass with a
 * four-neighbour gradient rather than two blurs -- the full function stays
 * behind the trace flag for the readings that are only ever looked at.
 */
function analyzeResidualEdges(
  actual: number[],
  blank: number[],
  width: number,
  height: number,
  tone: ToneCorrection,
  offsetX: number,
  offsetY: number,
  radiusX: number,
  radiusY: number,
): ResidualEdges {
  const page = new Float32Array(width * height);
  const base = new Float32Array(width * height);
  for (let index = 0; index < page.length; index++) {
    page[index] = darkness(applyTone(tone, actual[index]));
    base[index] = darkness(blank[index]);
  }
  const at = (grid: Float32Array, x: number, y: number): number => {
    const cx = clamp(x, 0, width - 1);
    const cy = clamp(y, 0, height - 1);
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const fx = cx - x0;
    const fy = cy - y0;
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const topLeft = grid[y0 * width + x0];
    const topRight = grid[y0 * width + x1];
    const bottomLeft = grid[y1 * width + x0];
    const bottomRight = grid[y1 * width + x1];
    return topLeft
      + (topRight - topLeft) * fx
      + (bottomLeft - topLeft) * fy
      + (topLeft - topRight - bottomLeft + bottomRight) * fx * fy;
  };
  const gradient = (grid: Float32Array, x: number, y: number): number => Math.max(
    Math.abs(at(grid, x + 1, y) - at(grid, x - 1, y)),
    Math.abs(at(grid, x, y + 1) - at(grid, x, y - 1)),
  );

  let total = 0;
  let edgeMass = 0;
  let edgeCount = 0;
  let count = 0;
  for (let y = radiusY; y < height - radiusY; y++) {
    for (let x = radiusX; x < width - radiusX; x++) {
      const bx = x + offsetX;
      const by = y + offsetY;
      const difference = Math.abs(at(page, x, y) - at(base, bx, by));
      total += difference;
      count++;
      if (gradient(base, bx, by) >= RESIDUAL_EDGE_GRADIENT) {
        edgeMass += difference;
        edgeCount++;
      }
    }
  }
  return {
    edgeShare: total > 0 ? edgeMass / total : 0,
    edgeFraction: edgeCount / Math.max(count, 1),
  };
}

interface BlankInkGeometry {
  /**
   * Share of the blank form's ink in this cell that falls inside the middle
   * half of each axis, divided by that region's share of the area. Above 1
   * means the printed ink is concentrated in the centre; below 1 means it is
   * pushed to the perimeter. Scale-free, so a 13px checkbox and a 58px
   * satisfaction cell are directly comparable.
   */
  coreConcentration: number;
  /** Mean printed darkness across the cell, so an empty cell is recognisable. */
  fill: number;
}

/**
 * Where the printed ink sits in a cell, measured on the blank form alone.
 *
 * Reads the same resampled grid the score is computed from, over the same
 * usable region, so it describes the cell the scorer actually sees rather than
 * an idealised rectangle.
 */
function measureBlankInkGeometry(
  blank: number[],
  width: number,
  height: number,
  radiusX: number,
  radiusY: number,
  alignX: number,
  alignY: number,
): BlankInkGeometry {
  const coreLeft = width * 0.25;
  const coreRight = width * 0.75;
  const coreTop = height * 0.25;
  const coreBottom = height * 0.75;
  let total = 0;
  let core = 0;
  let samples = 0;
  let coreSamples = 0;

  for (let y = radiusY; y < height - radiusY; y++) {
    for (let x = radiusX; x < width - radiusX; x++) {
      const ink = darkness(sampleGridAt(blank, width, height, x + alignX, y + alignY));
      total += ink;
      samples += 1;
      if (x >= coreLeft && x < coreRight && y >= coreTop && y < coreBottom) {
        core += ink;
        coreSamples += 1;
      }
    }
  }

  if (samples === 0 || total <= 0 || coreSamples === 0) {
    return { coreConcentration: 0, fill: 0 };
  }
  // Ink share of the core against its area share. A cell whose print is spread
  // evenly reads 1 whatever its size.
  const areaShare = coreSamples / samples;
  return { coreConcentration: core / total / areaShare, fill: total / samples };
}

/**
 * Measures whether the local 82nd-percentile paper reference is being moved by
 * a dark mark. The 95th-percentile offset is a diagnostic comparison only; it
 * never changes the score or any gate.
 */
function measureBrightnessReference(
  actual: number[],
  blank: number[],
  width: number,
  height: number,
  radiusX: number,
  radiusY: number,
  stepsX: number,
  stepsY: number,
  pageCalibration?: PageInkCalibration,
): BrightnessReferenceProbe {
  const actualP82 = percentile(actual, 0.82);
  const blankP82 = percentile(blank, 0.82);
  const actualP95 = percentile(actual, 0.95);
  const blankP95 = percentile(blank, 0.95);
  const offset95 = blankP95 - actualP95;
  // This probe measures the 0.95 reference *as a shift*, which is what it has
  // always been. It is a comparison against the shift at 0.82, so it must not
  // acquire the two-point map or the two readings stop being comparable.
  const tone95 = linearTone(offset95);
  const alignment95 = findBestBaselineAlignment(
    actual,
    blank,
    width,
    height,
    tone95,
    radiusX,
    radiusY,
    stepsX,
    stepsY,
  );
  let difference = 0;
  for (let y = radiusY; y < height - radiusY; y++) {
    for (let x = radiusX; x < width - radiusX; x++) {
      const actualInk = darkness(applyTone(tone95, actual[y * width + x]));
      const baselineInk = darkness(
        sampleGridAt(blank, width, height, x + alignment95.x, y + alignment95.y),
      );
      difference += calculateResidualInk(actualInk, baselineInk, pageCalibration);
    }
  }
  const usablePixels = Math.max((width - 2 * radiusX) * (height - 2 * radiusY), 1);
  return {
    actualP82,
    blankP82,
    actualP95,
    blankP95,
    offset95,
    score95: difference / usablePixels,
  };
}

/**
 * Mirrors the direct checkbox gate's 3px/4px inset and 8x8 sampling as
 * measurement. It is intentionally separate from the full-box scorer and is
 * never used to alter a candidate score or decision.
 */
function calculateInsetResidualSignal(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  actualRect: PixelRect,
  baseline: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  baselineRect: PixelRect,
  pageCalibration?: PageInkCalibration,
): number {
  const actual = insetPixelRect(actualRect, 3);
  const blank = insetPixelRect(baselineRect, 4);
  let difference = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const actualX = clamp(
        Math.round(actual.left + (x + 0.5) * (actual.right - actual.left) / 8),
        0,
        image.width - 1,
      );
      const actualY = clamp(
        Math.round(actual.top + (y + 0.5) * (actual.bottom - actual.top) / 8),
        0,
        image.height - 1,
      );
      const blankX = clamp(
        Math.round(blank.left + (x + 0.5) * (blank.right - blank.left) / 8),
        0,
        baseline.width - 1,
      );
      const blankY = clamp(
        Math.round(blank.top + (y + 0.5) * (blank.bottom - blank.top) / 8),
        0,
        baseline.height - 1,
      );
      const actualInk = darkness(image.pixels[actualY * image.width + actualX]);
      const blankInk = darkness(baseline.pixels[blankY * baseline.width + blankX]);
      difference += calculateResidualInk(actualInk, blankInk, pageCalibration);
    }
  }
  return difference / 64;
}

function insetPixelRect(rect: PixelRect, inset: number): PixelRect {
  const left = Math.min(rect.left + inset, rect.right - 1);
  const top = Math.min(rect.top + inset, rect.bottom - 1);
  const right = Math.max(left + 1, rect.right - inset);
  const bottom = Math.max(top + 1, rect.bottom - inset);
  return { left, top, right, bottom };
}

function hasStructuredTemplateMark(shape?: TemplateInkShape): boolean {
  return Boolean(
    shape
    && shape.largestComponentSize >= STRUCTURED_MARK_MIN_COMPONENT
    && shape.largestComponentRatio >= STRUCTURED_MARK_MIN_COMPONENT_RATIO
    && shape.diagonalRatio >= STRUCTURED_MARK_MIN_DIAGONAL_RATIO,
  );
}

function analyzeResidualShape(
  residual: Float32Array,
  width: number,
  height: number,
): TemplateInkShape {
  const shapeThreshold = 0.08;
  const visited = new Uint8Array(residual.length);
  let activePixels = 0;
  let largestComponentSize = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const start = y * width + x;
      if (visited[start] || residual[start] <= shapeThreshold) continue;

      const queue = [start];
      visited[start] = 1;
      let componentSize = 0;
      while (queue.length > 0) {
        const current = queue.pop()!;
        const currentX = current % width;
        const currentY = Math.floor(current / width);
        componentSize += 1;
        activePixels += 1;

        for (let offsetY = -1; offsetY <= 1; offsetY++) {
          for (let offsetX = -1; offsetX <= 1; offsetX++) {
            if (offsetX === 0 && offsetY === 0) continue;
            const neighborX = currentX + offsetX;
            const neighborY = currentY + offsetY;
            if (
              neighborX < 1
              || neighborX >= width - 1
              || neighborY < 1
              || neighborY >= height - 1
            ) continue;
            const neighbor = neighborY * width + neighborX;
            if (visited[neighbor] || residual[neighbor] <= shapeThreshold) continue;
            visited[neighbor] = 1;
            queue.push(neighbor);
          }
        }
      }
      largestComponentSize = Math.max(largestComponentSize, componentSize);
    }
  }

  let diagonalEdges = 0;
  let orthogonalEdges = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      if (residual[index] <= shapeThreshold) continue;
      for (const [offsetX, offsetY] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
        const neighbor = (y + offsetY) * width + x + offsetX;
        if (residual[neighbor] <= shapeThreshold) continue;
        if (offsetX === 0 || offsetY === 0) orthogonalEdges += 1;
        else diagonalEdges += 1;
      }
    }
  }

  return {
    largestComponentSize,
    largestComponentRatio: activePixels > 0 ? largestComponentSize / activePixels : 0,
    diagonalRatio: diagonalEdges / Math.max(diagonalEdges + orthogonalEdges, 1),
  };
}

function toPixelRect(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
  rect: NormalizedRect,
  yOverride?: { top: number; bottom: number },
): PixelRect {
  const bounds = getRegistrationBounds(image);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const left = clamp(Math.floor(bounds.left + rect.x * width), 0, image.width - 1);
  const right = clamp(Math.ceil(bounds.left + (rect.x + rect.width) * width), left + 1, image.width);
  const top = clamp(Math.floor(yOverride ? yOverride.top : bounds.top + rect.y * height), 0, image.height - 1);
  const bottom = clamp(Math.ceil(yOverride ? yOverride.bottom : bounds.top + (rect.y + rect.height) * height), top + 1, image.height);
  return { left, top, right, bottom };
}

/**
 * Exported only so a measurement outside this file can resample a rectangle
 * the *same* way the scorer does (sheetExposure.ts). Adding `export` changes
 * no behaviour here: nothing about the function or its callers moved.
 */
export function sampleRect(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  rect: PixelRect,
  sampleWidth: number,
  sampleHeight: number,
): number[] {
  const left = clamp(Math.floor(rect.left), 0, image.width - 1);
  const top = clamp(Math.floor(rect.top), 0, image.height - 1);
  const right = clamp(Math.ceil(rect.right), left + 1, image.width);
  const bottom = clamp(Math.ceil(rect.bottom), top + 1, image.height);
  const width = right - left;
  const height = bottom - top;
  const samples: number[] = [];

  for (let y = 0; y < sampleHeight; y++) {
    const sourceY = Math.min(bottom - 1, Math.max(top, Math.round(top + ((y + 0.5) / sampleHeight) * height - 0.5)));
    for (let x = 0; x < sampleWidth; x++) {
      const sourceX = Math.min(right - 1, Math.max(left, Math.round(left + ((x + 0.5) / sampleWidth) * width - 0.5)));
      samples.push(image.pixels[sourceY * image.width + sourceX]);
    }
  }

  return samples;
}

/**
 * How far the baseline may be nudged when it is compared with the page.
 *
 * The radius is in resampled samples, but every cell is resampled to the same
 * fixed grid, so one sample is a different physical distance in a small cell
 * than in a large one. At a fixed radius of 1 the search reached two source
 * pixels on a satisfaction cell and under one on a basic-info checkbox, and the
 * winner sat against the boundary on 69% of all decisions -- 100% of basic
 * info. The radius is therefore derived per cell from its own sampling pitch,
 * so every cell gets the same physical reach of about one source pixel: the
 * reach a search expressed in samples had was an accident of cell size.
 *
 * The minimum is 1, which reproduces the previous behaviour exactly for any
 * cell already sampled at a pitch of one source pixel or coarser. The maximum
 * bounds both the cost and the freedom: past about a pixel, a mismatch is a
 * registration failure rather than jitter, and the cell should not be scored on
 * a guess.
 */
export { BASELINE_ALIGNMENT_RADIUS };
const BASELINE_ALIGNMENT_MAX_RADIUS = 4;

/**
 * Reach given to the diagnostic probe only. Wide enough that a table-sized
 * registration error lands inside it, so an optimum that still sits on this
 * boundary means something other than translation is separating the two images.
 */
const PROBE_ALIGNMENT_RADIUS = 4;

/**
 * How finely the baseline offset is resolved, in steps per sample.
 *
 * The residual decomposition said the leftover disagreement sits on printed
 * edges, is antisymmetric about them, and goes only when both images are
 * matched rather than either one alone. Geometry makes the blank the
 * higher-resolution image everywhere -- a 200dpi scan against a half-resolution
 * render -- so a sharpness mismatch would have gone with softening the blank
 * alone, and softening the blank alone changed nothing. What both-sided
 * softening removes is sub-sample misregistration: the search moved in whole
 * samples, so a fractional offset was invisible to it at any radius, and 23
 * pinned cells gaining nothing from four times the reach is that showing.
 *
 * The operation that removes a fractional offset is a fractional shift, not a
 * softer comparison. Softening the comparison was built, measured and rejected
 * before shipping: on a blank-form checkbox where a whole-sample offset already
 * fitted to 0.0012, the flattened objective could no longer see that minimum,
 * took its neighbour at 0.0264, and turned an empty cell into a
 * medium-confidence read. Choosing an offset on a softened objective and
 * applying it to unsoftened images drifts the choice.
 *
 * Interpolating leaves the objective alone. The whole-sample offsets are still
 * candidates, so the search minimises over a superset and the fit it finds can
 * only match or beat the previous one -- and nothing that is scored is
 * softened, so a faint mark keeps every bit of its ink and the shape test still
 * sees it at full resolution.
 *
 * Steps come from the page's own pitch, the same quantity that sets the reach.
 * Where the grid is at or coarser than the source pixels there is nothing
 * between samples to find, the count is 1, and the search is exactly the one
 * that ran before.
 */
const BASELINE_ALIGNMENT_MAX_STEPS = 4;

function alignmentSteps(pitch: number): number {
  if (!Number.isFinite(pitch) || pitch <= 0) {
    return 1;
  }
  return clamp(Math.round(1 / pitch), 1, BASELINE_ALIGNMENT_MAX_STEPS);
}

/**
 * Bilinear read of a sample grid at a fractional position. At a whole-number
 * position it returns that sample exactly, which is what keeps a single-step
 * search identical to the one that ran before.
 */
function sampleGridAt(grid: number[], width: number, height: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const left = clamp(x0, 0, width - 1);
  const top = clamp(y0, 0, height - 1);
  const right = clamp(x0 + 1, 0, width - 1);
  const bottom = clamp(y0 + 1, 0, height - 1);
  const topLeft = grid[top * width + left];
  const topRight = grid[top * width + right];
  const bottomLeft = grid[bottom * width + left];
  const bottomRight = grid[bottom * width + right];
  return topLeft
    + (topRight - topLeft) * fx
    + (bottomLeft - topLeft) * fy
    + (topLeft - topRight - bottomLeft + bottomRight) * fx * fy;
}

/**
 * Gradient above which a sample counts as sitting on a printed edge. Darkness
 * runs 0 to 1, and the edge of a printed rule crosses most of that range, so
 * this separates structure from paper texture without being near either.
 */
const RESIDUAL_EDGE_GRADIENT = 0.15;

/**
 * Samples needed to cover one source pixel, so a cell resampled far above its
 * own resolution can still be shifted a whole pixel.
 */
function alignmentRadius(pitch: number): number {
  const floor = alignmentRadiusFloor();
  if (!Number.isFinite(pitch) || pitch <= 0) {
    return floor;
  }
  return clamp(Math.round(1 / pitch), floor, BASELINE_ALIGNMENT_MAX_RADIUS);
}

/**
 * Instrument, off by default: the smallest reach the baseline alignment search
 * is allowed, in samples. Unset it reads `BASELINE_ALIGNMENT_RADIUS` and every
 * number this file produces is the one it produced before.
 *
 * MARK_ALIGN_RADIUS=2 gives every cell the reach a cell sampled at half a
 * source pixel already gets, which is the point: the hypothesis under
 * measurement is that the ~0.03 residual left in unmarked boxes is a printed
 * glyph the whole-sample search could not reach. Raising the floor here rather
 * than inside `findBestBaselineAlignment` keeps the reach and the compared
 * window the same number, which is the invariant that function is built on --
 * every offset reads real in-bounds samples and compares exactly the same
 * count, so a wider search cannot win by scoring fewer samples. The cost is
 * that the scored window narrows with the reach (36x28 samples inset by 2
 * instead of 1); that is the same trade an oversampled cell already makes, and
 * `usablePixels` already divides by the count it actually summed.
 *
 * Values outside the search's own bounds are clamped rather than refused: this
 * is a measurement dial, and a nonsense setting should read as the nearest
 * sensible one rather than change the code path.
 */
function alignmentRadiusFloor(): number {
  if (typeof process === 'undefined') return BASELINE_ALIGNMENT_RADIUS;
  const raw = process.env?.MARK_ALIGN_RADIUS;
  if (typeof raw !== 'string') return BASELINE_ALIGNMENT_RADIUS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return BASELINE_ALIGNMENT_RADIUS;
  return clamp(parsed, BASELINE_ALIGNMENT_RADIUS, BASELINE_ALIGNMENT_MAX_RADIUS);
}

/**
 * Instrument, off by default: 3x3 maximum filter over the baseline ink map,
 * read at the aligned position.
 *
 * `darkness` runs light-to-dark, so a maximum over the neighbourhood is a
 * dilation of the printed ink -- one sample of slack in every direction for
 * the subtraction to find the same stroke the page has.
 *
 * This is deliberately not the dilation recorded at
 * `findBestBaselineAlignment` as having taken CORRECT 92 to 64. That one
 * enlarged what is removed from every cell unconditionally and permanently.
 * This one is off unless asked for, and even on it touches only the residual:
 * `actualInk`, `baselineInk`, the total-ink invariant and every gate
 * constant still read the undilated map. The delegator measures whether the
 * separation it buys is worth the ink it eats; this file does not decide that.
 */
function baselineDilationEnabled(): boolean {
  return typeof process !== 'undefined' && Boolean(process.env?.MARK_BASELINE_DILATE);
}

function dilatedBaselineInk(
  grid: number[],
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  let maxInk = 0;
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const ink = darkness(sampleGridAt(grid, width, height, x + offsetX, y + offsetY));
      if (ink > maxInk) {
        maxInk = ink;
      }
    }
  }
  return maxInk;
}

/**
 * Finds where the blank form sits against the page.
 *
 * The objective is the symmetric absolute difference between the two images,
 * not the one-sided residual that becomes the score. That is what keeps a wider
 * search from eating a mark: sliding the blank's ink onto a pen stroke lowers
 * the difference under the stroke, but it also strips that ink from where it
 * belongs and plants it where it does not, so mis-registering the print costs
 * twice over the printed structure -- which carries far more ink than any pen
 * mark (mean 0.251 against 0.079 on a measured checkbox). The minimum therefore
 * sits at true print-to-print registration, and widening the window does not
 * move that minimum, it only lets the search reach it.
 *
 * This is the opposite of dilating the blank form, which took this project from
 * CORRECT 92 to 64: dilation adds ink to the subtrahend, permanently enlarging
 * what is removed from every cell. A translation adds no ink at all. It only
 * chooses where the same ink sits.
 *
 * The compared region is inset by the radius so that every offset reads real
 * in-bounds samples and compares exactly the same count. Without that the
 * offsets near the edge would read past the array, and scoring fewer samples
 * would look better than scoring more -- driving the search straight to its
 * own boundary.
 */
function findBestBaselineAlignment(
  actual: number[],
  baseline: number[],
  width: number,
  height: number,
  tone: ToneCorrection,
  radiusX: number,
  radiusY: number,
  stepsX: number,
  stepsY: number,
): { x: number; y: number; fit: number } {
  let best = { x: 0, y: 0, score: Number.POSITIVE_INFINITY };
  const compared = Math.max((width - 2 * radiusX) * (height - 2 * radiusY), 1);

  const scoreAt = (offsetX: number, offsetY: number): number => {
    let score = 0;
    for (let y = radiusY; y < height - radiusY; y++) {
      for (let x = radiusX; x < width - radiusX; x++) {
        const actualInk = darkness(applyTone(tone, actual[y * width + x]));
        const baselineInk = darkness(sampleGridAt(baseline, width, height, x + offsetX, y + offsetY));
        score += Math.abs(actualInk - baselineInk);
      }
    }
    return score;
  };

  // Whole samples first, over exactly the grid the previous search used, then
  // fractions within one sample of the winner. Searching every fraction across
  // the whole reach costs the fourth power of the radius; this costs its square
  // and still evaluates the old grid in full, so the offset returned is at
  // least as good as the one that grid would have given.
  for (let offsetY = -radiusY; offsetY <= radiusY; offsetY++) {
    for (let offsetX = -radiusX; offsetX <= radiusX; offsetX++) {
      const score = scoreAt(offsetX, offsetY);
      if (score < best.score) {
        best = { x: offsetX, y: offsetY, score };
      }
    }
  }

  if (stepsX > 1 || stepsY > 1) {
    const coarse = { x: best.x, y: best.y };
    for (let stepY = -stepsY; stepY <= stepsY; stepY++) {
      for (let stepX = -stepsX; stepX <= stepsX; stepX++) {
        if (stepX % stepsX === 0 && stepY % stepsY === 0) {
          continue;
        }
        const offsetX = clamp(coarse.x + stepX / stepsX, -radiusX, radiusX);
        const offsetY = clamp(coarse.y + stepY / stepsY, -radiusY, radiusY);
        const score = scoreAt(offsetX, offsetY);
        if (score < best.score) {
          best = { x: offsetX, y: offsetY, score };
        }
      }
    }
  }

  // Mean disagreement per sample at the offset chosen. A cell that is merely
  // shifted comes to near-agreement once it is shifted back; a cell that cannot
  // be made to agree by any shift keeps a floor here, and no amount of reach
  // will help it.
  return { x: best.x, y: best.y, fit: best.score / compared };
}

interface ResidualComposition {
  /** Share of the disagreement carried by samples on a printed edge. */
  edgeShare: number;
  /** Share of samples that are on a printed edge. */
  edgeFraction: number;
  /** 0 when the edge disagreement cancels out, 1 when it is all one way. */
  edgeBalance: number;
  /** Mean gradient of each image: which one is sharper, and by how much. */
  pageSharpness: number;
  blankSharpness: number;
  /** Fit after softening the blank, and after softening both. */
  fitSoftBlank: number;
  fitSoftBoth: number;
  /**
   * What the score would be if the subtraction itself were taken at the common
   * band. Measured, never applied: softening what is scored spreads a mark's
   * ink and the residual's clip then eats proportionally more of a faint mark
   * than a strong one. This is the number that says whether touching the
   * subtraction is ever worth it, without touching it.
   */
  matchedScore: number;
}

/**
 * Calculates the structural signal in one already-aligned candidate. This is
 * the single definition shared by the trace and the production runner-up
 * badge; callers decide when the result is worth paying for.
 */
function calculateMatchedScore(input: MatchedScoreInput): number {
  const page = new Float32Array(input.width * input.height);
  const base = new Float32Array(input.width * input.height);
  for (let index = 0; index < page.length; index++) {
    page[index] = darkness(applyTone(input.tone, input.actual[index]));
    base[index] = darkness(input.blank[index]);
  }

  return calculateMatchedScoreFromSoftened(
    softenSamples(page, input.width, input.height),
    softenSamples(base, input.width, input.height),
    input.width,
    input.height,
    input.offsetX,
    input.offsetY,
    input.radiusX,
    input.radiusY,
  );
}

function calculateMatchedScoreFromSoftened(
  softPage: Float32Array,
  softBase: Float32Array,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  radiusX: number,
  radiusY: number,
): number {
  const at = (grid: Float32Array, x: number, y: number): number => {
    const cx = clamp(x, 0, width - 1);
    const cy = clamp(y, 0, height - 1);
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const fx = cx - x0;
    const fy = cy - y0;
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const topLeft = grid[y0 * width + x0];
    const topRight = grid[y0 * width + x1];
    const bottomLeft = grid[y1 * width + x0];
    const bottomRight = grid[y1 * width + x1];
    return topLeft
      + (topRight - topLeft) * fx
      + (bottomLeft - topLeft) * fy
      + (topLeft - topRight - bottomLeft + bottomRight) * fx * fy;
  };

  let matchedScoreTotal = 0;
  let count = 0;
  for (let y = radiusY; y < height - radiusY; y++) {
    for (let x = radiusX; x < width - radiusX; x++) {
      const bx = x + offsetX;
      const by = y + offsetY;
      matchedScoreTotal += Math.max(0, at(softPage, x, y) - at(softBase, bx, by) - 0.08);
      count++;
    }
  }

  return matchedScoreTotal / Math.max(count, 1);
}

/**
 * What the leftover disagreement is made of, once the baseline is placed as
 * well as it can be.
 *
 * Half the pinned satisfaction cells gain nothing from a search four times
 * wider: the offset a wide search picks is the one it already had. So whatever
 * separates those two images there, sliding one over the other does not close
 * it. Three readings separate the remaining candidates, and they are readings
 * rather than an argument because this axis has now produced four wrong
 * diagnoses, two of them mine.
 *
 * `edgeShare` against `edgeFraction` says whether the disagreement sits on the
 * edges of printed rules and glyphs or is spread across the cell. A resampling
 * difference lives on edges; a genuine ink difference need not.
 *
 * `edgeBalance` is the sharper test. Two images at different effective
 * resolutions disagree *antisymmetrically* about an edge -- the softer one is
 * lighter on one side and darker on the other -- so the signed difference
 * cancels while the absolute difference stays large. Ink that is present in one
 * image and absent from the other is one-signed. Near 0 means sharpness, near 1
 * means substance.
 *
 * `fitSoftBlank` answers the question that decides the axis: if the residual is
 * the blank being sharper, softening the blank removes it, and the fix is to
 * compare the two at a common effective resolution. If softening changes
 * nothing, no operation on the baseline reaches this residual.
 *
 * The full composition remains trace-only; `matchedScore` is also requested for
 * the one runner-up of a high-confidence production group.
 */
function analyzeResidualComposition(
  actual: number[],
  blank: number[],
  width: number,
  height: number,
  tone: ToneCorrection,
  offsetX: number,
  offsetY: number,
  radiusX: number,
  radiusY: number,
): ResidualComposition {
  const page = new Float32Array(width * height);
  const base = new Float32Array(width * height);
  for (let index = 0; index < page.length; index++) {
    page[index] = darkness(applyTone(tone, actual[index]));
    base[index] = darkness(blank[index]);
  }
  const softPage = softenSamples(page, width, height);
  const softBase = softenSamples(base, width, height);

  // The alignment offset is fractional wherever the search runs sub-sample,
  // and the score path reads the baseline through a bilinear interpolation
  // there. Indexing with the raw offset instead is wrong two different ways:
  // 0.5 * width is a whole number, so it silently reads another row, and any
  // other fraction reads undefined and turns the reading into NaN. This is
  // exact at whole positions, so it changes nothing where the offset is one.
  const at = (grid: Float32Array, x: number, y: number): number => {
    const cx = clamp(x, 0, width - 1);
    const cy = clamp(y, 0, height - 1);
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const fx = cx - x0;
    const fy = cy - y0;
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const topLeft = grid[y0 * width + x0];
    const topRight = grid[y0 * width + x1];
    const bottomLeft = grid[y1 * width + x0];
    const bottomRight = grid[y1 * width + x1];
    return topLeft
      + (topRight - topLeft) * fx
      + (bottomLeft - topLeft) * fy
      + (topLeft - topRight - bottomLeft + bottomRight) * fx * fy;
  };
  const gradient = (grid: Float32Array, x: number, y: number): number => Math.max(
    Math.abs(at(grid, x + 1, y) - at(grid, x - 1, y)),
    Math.abs(at(grid, x, y + 1) - at(grid, x, y - 1)),
  );

  let total = 0;
  let edgeMass = 0;
  let edgeSigned = 0;
  let edgeCount = 0;
  let count = 0;
  let pageGradient = 0;
  let blankGradient = 0;
  let softBlankTotal = 0;
  let softBothTotal = 0;

  for (let y = radiusY; y < height - radiusY; y++) {
    for (let x = radiusX; x < width - radiusX; x++) {
      const bx = x + offsetX;
      const by = y + offsetY;
      const difference = at(page, x, y) - at(base, bx, by);
      total += Math.abs(difference);
      softBlankTotal += Math.abs(at(page, x, y) - at(softBase, bx, by));
      softBothTotal += Math.abs(at(softPage, x, y) - at(softBase, bx, by));
      pageGradient += gradient(page, x, y);
      blankGradient += gradient(base, bx, by);
      count++;
      if (gradient(base, bx, by) >= RESIDUAL_EDGE_GRADIENT) {
        edgeMass += Math.abs(difference);
        edgeSigned += difference;
        edgeCount++;
      }
    }
  }

  const samples = Math.max(count, 1);
  return {
    edgeShare: total > 0 ? edgeMass / total : 0,
    edgeFraction: edgeCount / samples,
    edgeBalance: edgeMass > 0 ? Math.abs(edgeSigned) / edgeMass : 0,
    pageSharpness: pageGradient / samples,
    blankSharpness: blankGradient / samples,
    fitSoftBlank: softBlankTotal / samples,
    fitSoftBoth: softBothTotal / samples,
    matchedScore: calculateMatchedScoreFromSoftened(
      softPage,
      softBase,
      width,
      height,
      offsetX,
      offsetY,
      radiusX,
      radiusY,
    ),
  };
}

/** Three-by-three mean, the mildest way to take resolution out of an image. */
function softenSamples(grid: Float32Array, width: number, height: number): Float32Array {
  const output = new Float32Array(grid.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let seen = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const row = clamp(y + dy, 0, height - 1);
          const column = clamp(x + dx, 0, width - 1);
          sum += grid[row * width + column];
          seen++;
        }
      }
      output[y * width + x] = sum / seen;
    }
  }
  return output;
}

/**
 * Where the alignment would have gone with far more room, and how much better
 * it would have fitted.
 *
 * This decides the shape of the next fix and nothing else, so it is measured
 * rather than reasoned about: a consistent direction across a table means the
 * two images disagree about where the table is, and belongs upstream of this
 * file; scattered directions mean per-cell jitter and want more reach; an
 * optimum that is itself pinned, or one that barely improves the fit, means
 * translation is not the missing operation at all.
 *
 * It runs only while tracing, so it costs a measurement run and nothing else.
 * Both fits are computed over the same probe-inset region so the two are
 * comparable.
 */
function probeAlignment(
  actual: number[],
  baseline: number[],
  width: number,
  height: number,
  tone: ToneCorrection,
  chosenX: number,
  chosenY: number,
): { x: number; y: number; fit: number; chosenFit: number; radius: number } {
  const radius = PROBE_ALIGNMENT_RADIUS;
  const fitAt = (offsetX: number, offsetY: number): number => {
    let score = 0;
    let compared = 0;
    for (let y = radius; y < height - radius; y++) {
      for (let x = radius; x < width - radius; x++) {
        const actualInk = darkness(applyTone(tone, actual[y * width + x]));
        const baselineInk = darkness(baseline[(y + offsetY) * width + (x + offsetX)]);
        score += Math.abs(actualInk - baselineInk);
        compared++;
      }
    }
    return score / Math.max(compared, 1);
  };

  let best = { x: 0, y: 0, fit: Number.POSITIVE_INFINITY };
  for (let offsetY = -radius; offsetY <= radius; offsetY++) {
    for (let offsetX = -radius; offsetX <= radius; offsetX++) {
      const fit = fitAt(offsetX, offsetY);
      if (fit < best.fit) {
        best = { x: offsetX, y: offsetY, fit };
      }
    }
  }

  return { ...best, chosenFit: fitAt(chosenX, chosenY), radius };
}

function darkness(value: number): number {
  return Math.max(0, Math.min(1, (178 - value) / 178));
}

/**
 * Exported for the same reason as `sampleRect`: the sheet-level exposure
 * measurement has to be the scorer's percentile, not a second definition of
 * one. Nothing here changed but the visibility.
 */
export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isPlausibleFrameBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height'>,
  bounds: PixelBounds,
  reference: PixelBounds = { left: 0, top: 0, right: image.width, bottom: image.height },
): boolean {
  const frameWidth = bounds.right - bounds.left;
  const frameHeight = bounds.bottom - bounds.top;
  const aspectRatio = frameHeight / frameWidth;
  const referenceWidth = reference.right - reference.left;
  const referenceHeight = reference.bottom - reference.top;

  // The templates are portrait forms. Reject small internal tables or a partial
  // page frame before normalized ROI coordinates are allowed to drive recognition.
  return (
    frameWidth >= referenceWidth * 0.7 &&
    frameHeight >= referenceHeight * 0.78 &&
    bounds.left <= reference.left + referenceWidth * 0.2 &&
    bounds.right >= reference.right - referenceWidth * 0.2 &&
    bounds.top <= reference.top + referenceHeight * 0.2 &&
    bounds.bottom >= reference.bottom - referenceHeight * 0.2 &&
    aspectRatio >= 1.05 &&
    aspectRatio <= 1.9
  );
}

function hasContinuousFrameEdges(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  bounds: PixelBounds,
): boolean {
  const frameWidth = bounds.right - bounds.left;
  const frameHeight = bounds.bottom - bounds.top;
  const horizontalInset = Math.max(1, Math.round(frameWidth * 0.04));
  const verticalInset = Math.max(1, Math.round(frameHeight * 0.02));
  const horizontalLeft = bounds.left + horizontalInset;
  const horizontalRight = bounds.right - horizontalInset;
  const verticalTop = bounds.top + verticalInset;
  const verticalBottom = bounds.bottom - verticalInset;

  const topRatio = darkRatioInRows(
    image,
    bounds.top,
    Math.min(bounds.top + Math.max(2, Math.round(frameHeight * 0.01)), bounds.bottom),
    horizontalLeft,
    horizontalRight,
  );
  const bottomRatio = darkRatioInRows(
    image,
    Math.max(bounds.top, bounds.bottom - Math.max(2, Math.round(frameHeight * 0.01))),
    bounds.bottom,
    horizontalLeft,
    horizontalRight,
  );
  const leftRatio = darkRatioInColumns(
    image,
    bounds.left,
    Math.min(bounds.left + Math.max(2, Math.round(frameWidth * 0.01)), bounds.right),
    verticalTop,
    verticalBottom,
  );
  const rightRatio = darkRatioInColumns(
    image,
    Math.max(bounds.left, bounds.right - Math.max(2, Math.round(frameWidth * 0.01))),
    bounds.right,
    verticalTop,
    verticalBottom,
  );

  return (
    topRatio >= 0.38 &&
    bottomRatio >= 0.38 &&
    leftRatio >= 0.45 &&
    rightRatio >= 0.45
  );
}

function darkRatioInRows(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  top: number,
  bottom: number,
  left: number,
  right: number,
): number {
  const safeTop = clamp(Math.floor(top), 0, image.height - 1);
  const safeBottom = clamp(Math.ceil(bottom), safeTop + 1, image.height);
  const safeLeft = clamp(Math.floor(left), 0, image.width - 1);
  const safeRight = clamp(Math.ceil(right), safeLeft + 1, image.width);
  let bestRatio = 0;

  for (let y = safeTop; y < safeBottom; y++) {
    let dark = 0;
    for (let x = safeLeft; x < safeRight; x++) {
      if (image.pixels[y * image.width + x] < 220) {
        dark++;
      }
    }

    bestRatio = Math.max(bestRatio, dark / (safeRight - safeLeft));
  }

  return bestRatio;
}

function darkRatioInColumns(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  left: number,
  right: number,
  top: number,
  bottom: number,
): number {
  const safeLeft = clamp(Math.floor(left), 0, image.width - 1);
  const safeRight = clamp(Math.ceil(right), safeLeft + 1, image.width);
  const safeTop = clamp(Math.floor(top), 0, image.height - 1);
  const safeBottom = clamp(Math.ceil(bottom), safeTop + 1, image.height);
  let bestRatio = 0;

  for (let x = safeLeft; x < safeRight; x++) {
    let dark = 0;
    for (let y = safeTop; y < safeBottom; y++) {
      if (image.pixels[y * image.width + x] < 220) {
        dark++;
      }
    }

    bestRatio = Math.max(bestRatio, dark / (safeBottom - safeTop));
  }

  return bestRatio;
}
