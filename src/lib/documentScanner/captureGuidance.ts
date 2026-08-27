import { orderQuadPoints, type Point, type QuadRejection } from './perspectiveCorrect';

/**
 * Live capture guidance -- the arithmetic only.
 *
 * Everything here is pure: no `cv`, no DOM, no worker. That is deliberate and
 * it is the reason this file exists separately from the panel. Two of the
 * three things this module computes (the frame <-> display transform, and the
 * roll/keystone/coverage read of a quad) are exactly the kind of thing this
 * project has already measured wrong four times by instrumenting the wrong
 * stage (CLAUDE.md §2), and a unit test is the only cheap way to pin them
 * down. `cv` cannot be imported into vitest at all -- the 10MB transform hangs
 * the runner -- so anything that needs it lives in the worker or in a
 * standalone Node script instead.
 *
 * Design: Task/CAPTURE_GUIDANCE_2026-08-27.md §3-§5, §7.
 *
 * EVERY THRESHOLD IN THIS FILE IS PROVISIONAL. CAPTURE_GUIDANCE §8 lists the
 * measurements that would settle them and none of them has been run. They are
 * drafts drawn from the 26 successful quads in §4/§5.2, not validated cuts.
 */

// --- coordinate mapping -----------------------------------------------------

export type ObjectFit = 'cover' | 'contain';

/**
 * The single transform between video-frame pixels and on-screen pixels.
 *
 * CAPTURE_GUIDANCE §4.2 is blunt about why this is one object and not two
 * pieces of arithmetic in two components: the guide rectangle and the detected
 * polygon must be drawn through the SAME mapping, or the user aims at a box
 * that does not correspond to what the gate measures. `object-fit` decides
 * whether the frame is cropped (`cover`, scale = max) or letterboxed
 * (`contain`, scale = min) inside the element's box.
 */
export interface VideoBoxMapping {
  frameWidth: number;
  frameHeight: number;
  displayWidth: number;
  displayHeight: number;
  /** frame px -> display px. */
  scale: number;
  /** Display-space position of frame origin. Negative under `cover`. */
  offsetX: number;
  offsetY: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computeVideoBoxMapping(
  frameWidth: number,
  frameHeight: number,
  displayWidth: number,
  displayHeight: number,
  fit: ObjectFit = 'contain',
): VideoBoxMapping | null {
  if (
    !Number.isFinite(frameWidth) || !Number.isFinite(frameHeight) ||
    !Number.isFinite(displayWidth) || !Number.isFinite(displayHeight) ||
    frameWidth <= 0 || frameHeight <= 0 || displayWidth <= 0 || displayHeight <= 0
  ) {
    return null;
  }

  const scaleX = displayWidth / frameWidth;
  const scaleY = displayHeight / frameHeight;
  const scale = fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

  return {
    frameWidth,
    frameHeight,
    displayWidth,
    displayHeight,
    scale,
    offsetX: (displayWidth - frameWidth * scale) / 2,
    offsetY: (displayHeight - frameHeight * scale) / 2,
  };
}

export function mapFrameToDisplay(mapping: VideoBoxMapping, point: Point): Point {
  return {
    x: mapping.offsetX + point.x * mapping.scale,
    y: mapping.offsetY + point.y * mapping.scale,
  };
}

export function mapDisplayToFrame(mapping: VideoBoxMapping, point: Point): Point {
  return {
    x: (point.x - mapping.offsetX) / mapping.scale,
    y: (point.y - mapping.offsetY) / mapping.scale,
  };
}

export function mapQuadToDisplay(mapping: VideoBoxMapping, points: Point[]): Point[] {
  return points.map((point) => mapFrameToDisplay(mapping, point));
}

export function mapRectToDisplay(mapping: VideoBoxMapping, rect: Rect): Rect {
  const topLeft = mapFrameToDisplay(mapping, { x: rect.left, y: rect.top });
  return {
    left: topLeft.x,
    top: topLeft.y,
    width: rect.width * mapping.scale,
    height: rect.height * mapping.scale,
  };
}

// --- guide rectangle --------------------------------------------------------

/**
 * height / width of the sheet. 656 / 474 = 1.3840 from
 * `cagiTemplate.baseSize`, which is also the `expectedAspectRatio` the gate is
 * given, so the guide and the gate describe the same shape.
 */
export const GUIDE_ASPECT_RATIO = 1.384;

/**
 * PROVISIONAL (CAPTURE_GUIDANCE §4.1). The 26 corrected quads covered 0.632 to
 * 0.922 of the frame, median 0.806-0.834, with the gate floor at 0.60 and the
 * margin floor at 0.02. 0.78 sits inside that band with ~0.11 margin per side
 * -- five times the floor -- so a user who fills the guide satisfies coverage,
 * margin and aspect at once rather than balancing on one of them.
 */
export const GUIDE_SHORT_EDGE_FILL = 0.78;

/**
 * The guide box, in whatever coordinate space `width`/`height` are given in.
 * Call it with FRAME dimensions and push the result through
 * `mapRectToDisplay`: coverage and margin are measured against the frame, so a
 * guide defined in display pixels would ask for the wrong thing wherever the
 * element crops or letterboxes the frame (CAPTURE_GUIDANCE §4.2).
 */
export function computeGuideRect(
  width: number,
  height: number,
  aspectRatio: number = GUIDE_ASPECT_RATIO,
  fill: number = GUIDE_SHORT_EDGE_FILL,
): Rect | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0 || !Number.isFinite(fill) || fill <= 0) {
    return null;
  }

  // The rectangle fills `fill` of the SHORT edge of the frame: on a portrait
  // frame that is its width, on a landscape frame its height.
  let rectWidth: number;
  let rectHeight: number;
  if (width <= height) {
    rectWidth = width * fill;
    rectHeight = rectWidth * aspectRatio;
  } else {
    rectHeight = height * fill;
    rectWidth = rectHeight / aspectRatio;
  }

  // A near-square frame can push the portrait box past the long edge; shrink
  // it rather than let the guide leave the picture.
  const overflow = Math.max(rectWidth / width, rectHeight / height);
  if (overflow > 1) {
    rectWidth /= overflow;
    rectHeight /= overflow;
  }

  return {
    left: (width - rectWidth) / 2,
    top: (height - rectHeight) / 2,
    width: rectWidth,
    height: rectHeight,
  };
}

// --- quad geometry ----------------------------------------------------------

export interface QuadGeometry {
  /** Degrees. 0 when the sheet's top and bottom edges are level on screen. */
  rollDeg: number;
  /** (bottom - top) / max. Positive means the TOP edge is farther from the camera. */
  keystoneV: number;
  /** (right - left) / max. Positive means the LEFT edge is farther from the camera. */
  keystoneH: number;
  coverageW: number;
  coverageH: number;
  /** Smallest of the four bounding-box margins, as a fraction of the frame. */
  marginMin: number;
  /** Mean height / mean width, same definition the gate uses. */
  aspectRatio: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * CAPTURE_GUIDANCE §5.2, verbatim: nothing new is estimated, the four ordered
 * corners already carry both tilts. The signs are the whole point -- they turn
 * "it is tilted" into "lower the top edge".
 */
export function computeQuadGeometry(
  points: Point[],
  frameWidth: number,
  frameHeight: number,
): QuadGeometry | null {
  if (!points || points.length !== 4 || frameWidth <= 0 || frameHeight <= 0) {
    return null;
  }

  const [topLeft, topRight, bottomRight, bottomLeft] = orderQuadPoints(points);

  const rollDeg = ((Math.atan2(topRight.y - topLeft.y, topRight.x - topLeft.x)
    + Math.atan2(bottomRight.y - bottomLeft.y, bottomRight.x - bottomLeft.x)) / 2) * (180 / Math.PI);

  const topWidth = distance(topLeft, topRight);
  const bottomWidth = distance(bottomLeft, bottomRight);
  const leftHeight = distance(topLeft, bottomLeft);
  const rightHeight = distance(topRight, bottomRight);

  const widthDenominator = Math.max(topWidth, bottomWidth);
  const heightDenominator = Math.max(leftHeight, rightHeight);
  const keystoneV = widthDenominator > 0 ? (bottomWidth - topWidth) / widthDenominator : 0;
  const keystoneH = heightDenominator > 0 ? (rightHeight - leftHeight) / heightDenominator : 0;

  const xs = [topLeft.x, topRight.x, bottomRight.x, bottomLeft.x];
  const ys = [topLeft.y, topRight.y, bottomRight.y, bottomLeft.y];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);

  const averageWidth = (topWidth + bottomWidth) / 2;
  const averageHeight = (leftHeight + rightHeight) / 2;

  return {
    rollDeg,
    keystoneV,
    keystoneH,
    coverageW: (right - left) / frameWidth,
    coverageH: (bottom - top) / frameHeight,
    marginMin: Math.min(
      left / frameWidth,
      1 - right / frameWidth,
      top / frameHeight,
      1 - bottom / frameHeight,
    ),
    aspectRatio: averageWidth > 0 ? averageHeight / averageWidth : 0,
  };
}

// --- thresholds -------------------------------------------------------------

/**
 * PROVISIONAL (CAPTURE_GUIDANCE §5.2, unvalidated -- §8-4 is the measurement
 * that would confirm it). The 26 corrected quads had `edgeConsistency` from
 * 0.814 with a median of 0.978, i.e. successes are almost head-on. 0.93 is
 * roughly 7% keystone.
 */
export const EDGE_CONSISTENCY_WARN = 0.93;

/** PROVISIONAL (CAPTURE_GUIDANCE §5.2, unvalidated -- see §8-4). */
export const ROLL_WARN_DEG = 4;

/**
 * Mirrors `MIN_PAGE_COVERAGE` / `MIN_FRAME_MARGIN` in perspectiveCorrect.ts.
 *
 * Note what this means in practice: `evaluateQuadDetailed` already refuses
 * anything below these, so a NON-NULL quality can never fail them. They are a
 * guard that keeps this reducer honest if the gate is ever loosened or if a
 * future detect path returns rejected quads with their points -- not the check
 * that drives the live "step closer" hint. That hint reaches the user through
 * `rejection === 'too-small'` instead.
 */
export const MIN_LIVE_COVERAGE = 0.6;
export const MIN_LIVE_MARGIN = 0.02;

// --- status reducer ---------------------------------------------------------

export interface LiveQuadQuality {
  points: Point[];
  confidence: number;
  edgeConsistency: number;
  aspectRatio: number;
}

export interface CaptureGuidanceInput {
  quality: LiveQuadQuality | null;
  rejection: QuadRejection | null;
  frameWidth: number;
  frameHeight: number;
}

export type CaptureGuidanceLevel = 'searching' | 'adjust' | 'ready';

export type CaptureGuidanceCode =
  | 'no-frame'
  | 'landscape'
  | 'searching'
  | 'cropped'
  | 'too-small'
  | 'wrong-shape'
  | 'not-a-quad'
  | 'margin'
  | 'coverage'
  | 'roll'
  | 'keystone-top'
  | 'keystone-bottom'
  | 'keystone-left'
  | 'keystone-right'
  | 'ready';

export interface CaptureGuidanceStatus {
  level: CaptureGuidanceLevel;
  code: CaptureGuidanceCode;
  /** The one line shown beside the frame. Never the only signal -- see §4.2. */
  message: string;
  /** Secondary line, or null. */
  detail: string | null;
  geometry: QuadGeometry | null;
}

/**
 * F2.2's rejection -> instruction table. The panel's `retakeHintFor` and the
 * server verdict in sheetQuality.ts use the same strings; live guidance and
 * the post-capture prompt must not word the same fault two ways.
 */
export function rejectionHint(rejection: QuadRejection | null): string {
  if (rejection === 'cropped') return '종이의 네 모서리가 모두 화면 안에 들어오게 찍어주세요';
  if (rejection === 'too-small') return '종이가 화면을 더 채우도록 가까이서 찍어주세요';
  if (rejection === 'wrong-shape') return '종이 정면에서, 세로 방향으로 찍어주세요';
  return '종이가 배경과 구분되도록 어두운 바닥을 피해 다시 찍어주세요';
}

function rejectionCode(rejection: QuadRejection): CaptureGuidanceCode {
  return rejection;
}

/**
 * An axis-aligned sheet of aspect 1.384 cannot satisfy `MIN_PAGE_COVERAGE` on
 * BOTH axes inside a landscape frame -- 0.6 of the width already implies more
 * than the full height. So a landscape frame is not "hard to detect", it is
 * un-detectable, and saying so first is more useful than "looking for paper"
 * (CAPTURE_GUIDANCE §4.1). This also fires on a landscape desktop webcam,
 * where the same arithmetic holds.
 */
export function isLandscapeFrame(frameWidth: number, frameHeight: number): boolean {
  return frameWidth > frameHeight;
}

export function evaluateCaptureGuidance(input: CaptureGuidanceInput): CaptureGuidanceStatus {
  const { quality, rejection, frameWidth, frameHeight } = input;

  if (!(frameWidth > 0) || !(frameHeight > 0)) {
    return {
      level: 'searching',
      code: 'no-frame',
      message: '카메라 화면을 준비하는 중',
      detail: null,
      geometry: null,
    };
  }

  if (isLandscapeFrame(frameWidth, frameHeight)) {
    return {
      level: 'adjust',
      code: 'landscape',
      message: '휴대폰을 세로로 들어주세요',
      detail: '가로 화면에서는 종이 전체가 인식 범위에 들어오지 않습니다',
      geometry: null,
    };
  }

  if (!quality) {
    if (rejection) {
      // A sheet-shaped candidate WAS seen and refused: name what to change.
      return {
        level: 'adjust',
        code: rejectionCode(rejection),
        message: rejectionHint(rejection),
        detail: null,
        geometry: null,
      };
    }

    return {
      level: 'searching',
      code: 'searching',
      message: '종이를 찾는 중',
      detail: '종이가 배경과 구분되게 놓아주세요',
      geometry: null,
    };
  }

  const geometry = computeQuadGeometry(quality.points, frameWidth, frameHeight);
  if (!geometry) {
    return {
      level: 'searching',
      code: 'searching',
      message: '종이를 찾는 중',
      detail: '종이가 배경과 구분되게 놓아주세요',
      geometry: null,
    };
  }

  // Order follows the gate's own precedence in `evaluateQuadDetailed`: running
  // off the frame is checked before distance, because it is the one fault a
  // person can act on without ambiguity.
  if (geometry.marginMin < MIN_LIVE_MARGIN) {
    return {
      level: 'adjust',
      code: 'margin',
      message: '종이 전체가 화면 안에 들어오게 해주세요',
      detail: null,
      geometry,
    };
  }

  if (geometry.coverageW < MIN_LIVE_COVERAGE || geometry.coverageH < MIN_LIVE_COVERAGE) {
    return {
      level: 'adjust',
      code: 'coverage',
      message: '조금 더 가까이',
      detail: '종이가 안내선을 채우도록 맞춰주세요',
      geometry,
    };
  }

  if (Math.abs(geometry.rollDeg) > ROLL_WARN_DEG) {
    return {
      level: 'adjust',
      code: 'roll',
      message: '화면과 나란히 돌려주세요',
      detail: null,
      geometry,
    };
  }

  if (quality.edgeConsistency < EDGE_CONSISTENCY_WARN) {
    // `edgeConsistency` says HOW MUCH; the individual keystone signs say WHICH
    // WAY. The larger of the two decides the sentence (§5.2).
    const vertical = Math.abs(geometry.keystoneV) >= Math.abs(geometry.keystoneH);
    if (vertical) {
      return geometry.keystoneV >= 0
        ? { level: 'adjust', code: 'keystone-top', message: '위쪽을 조금 낮춰주세요', detail: null, geometry }
        : { level: 'adjust', code: 'keystone-bottom', message: '아래쪽을 조금 낮춰주세요', detail: null, geometry };
    }

    return geometry.keystoneH >= 0
      ? { level: 'adjust', code: 'keystone-left', message: '카메라를 왼쪽으로 조금 옮겨주세요', detail: null, geometry }
      : { level: 'adjust', code: 'keystone-right', message: '카메라를 오른쪽으로 조금 옮겨주세요', detail: null, geometry };
  }

  return {
    level: 'ready',
    code: 'ready',
    message: '지금 촬영하세요',
    detail: null,
    geometry,
  };
}

/**
 * PROVISIONAL. Three consecutive green detections (~0.6s at the §7 target
 * rate) before the shutter is emphasised, so a single lucky frame does not
 * flash the button. This only CHANGES EMPHASIS -- capture is never blocked,
 * because the detector can be wrong and a hard block strands the user with a
 * sheet it refuses to see.
 */
export const READY_STREAK_FOR_SHUTTER = 3;

export function nextReadyStreak(previous: number, status: CaptureGuidanceStatus): number {
  return status.level === 'ready' ? previous + 1 : 0;
}
