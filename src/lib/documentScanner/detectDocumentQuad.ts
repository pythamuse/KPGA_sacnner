import {
  evaluateQuadDetailed,
  type Point,
  type QuadQuality,
  type QuadRejection,
} from './perspectiveCorrect';

export interface QuadCandidate {
  coverageW: number;
  coverageH: number;
  aspectRatio: number;
  marginMin: number;
  rejection: QuadRejection | null;
  confidence: number | null;
}

/** Diagnostic seam. Called for every candidate the contour search evaluated. */
export type QuadCandidateObserver = (candidate: QuadCandidate) => void;

export interface QuadDetection {
  quality: QuadQuality | null;
  /**
   * Why the largest plausible candidate was refused, when none was accepted.
   * `null` alongside a `null` quality means no sheet-sized candidate was seen
   * at all -- a different problem from a sheet that was seen and rejected.
   */
  rejection: QuadRejection | null;
  /** Internal: lets the two search levels compare candidates by area. */
  explanation?: RejectionCandidate | null;
}

// Every image contains a contour tracing its own border, and that contour
// always touches all four edges -- so ranking refusals by 'what can a person
// act on' made *every* photo report `cropped`, whether or not a sheet was ever
// seen. What a refusal has to describe is the best candidate that could
// plausibly BE the page, so whole-frame contours are ignored and the largest
// survivor speaks. If nothing survives, no sheet was found at all, which is
// its own answer and a different instruction to the person holding the phone.
const WHOLE_FRAME_COVERAGE = 0.97;
const PLAUSIBLE_PAGE_COVERAGE = 0.4;

interface RejectionCandidate {
  area: number;
  rejection: QuadRejection;
}

function betterExplanation(
  current: RejectionCandidate | null,
  next: RejectionCandidate | null,
): RejectionCandidate | null {
  if (!next) return current;
  if (!current) return next;
  return next.area > current.area ? next : current;
}

/**
 * Finds the page quadrilateral in an already-decoded image.
 *
 * This lives outside the Worker on purpose. Nothing here touches a browser API
 * -- it needs an OpenCV module and a Mat, both of which a Node harness can
 * supply -- and keeping it importable is what lets a measurement run score the
 * *same* detector the product ships instead of a re-implementation of it. The
 * Worker keeps the message plumbing and the canvas work, which genuinely are
 * browser-only.
 */
export function detectDocumentQuadFromMat(
  cv: any,
  source: any,
  imageWidth: number,
  imageHeight: number,
  expectedAspectRatio: number,
  observe?: QuadCandidateObserver,
): QuadDetection {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const detectionMaps: any[] = [];

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    for (const thresholds of [[50, 150], [85, 220]]) {
      const edges = new cv.Mat();
      cv.Canny(blurred, edges, thresholds[0], thresholds[1]);
      detectionMaps.push(edges);
    }

    // Canny and adaptiveThreshold both describe *edges*, and a sheet on a
    // patterned surface -- a wooden floor, a desk with grain -- produces edges
    // everywhere, none of which close into the page outline. Otsu separates the
    // image into bright and dark by a single global cut, which on a page-on-a-
    // darker-surface photo is exactly the page: one filled blob whose contour
    // reduces cleanly to four points. Measured on the 19-page set, the sheet
    // was not found at all in 12 of 19 CAGI photos before this map existed.
    try {
      const otsu = new cv.Mat();
      cv.threshold(blurred, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      detectionMaps.push(otsu);
    } catch {
      // Some OpenCV.js builds omit THRESH_OTSU; the edge maps still run.
    }

    try {
      const adaptive = new cv.Mat();
      cv.adaptiveThreshold(
        gray,
        adaptive,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        31,
        11,
      );
      detectionMaps.push(adaptive);
    } catch {
      // Older OpenCV.js builds may not expose adaptiveThreshold in the Worker.
    }

    let best: QuadQuality | null = null;
    let explanation: RejectionCandidate | null = null;
    for (const detectionMap of detectionMaps) {
      const found = findBestQuadFromMap(
        cv,
        detectionMap,
        imageWidth,
        imageHeight,
        expectedAspectRatio,
        observe,
      );

      explanation = betterExplanation(explanation, found.explanation ?? null);
      const candidate = found.quality;
      if (!best || (candidate && candidate.confidence > best.confidence)) {
        best = candidate;
      }
    }

    return { quality: best, rejection: best ? null : explanation?.rejection ?? null };
  } finally {
    detectionMaps.forEach((detectionMap) => detectionMap.delete());
    blurred.delete();
    gray.delete();
  }
}

function findBestQuadFromMap(
  cv: any,
  detectionMap: any,
  imageWidth: number,
  imageHeight: number,
  expectedAspectRatio: number,
  observe?: QuadCandidateObserver,
): QuadDetection {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let best: QuadQuality | null = null;
  let explanation: RejectionCandidate | null = null;

  try {
    cv.findContours(detectionMap, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);

      try {
        const perimeter = cv.arcLength(contour, true);
        for (const epsilonRatio of [0.015, 0.02, 0.03]) {
          const approx = new cv.Mat();

          try {
            cv.approxPolyDP(contour, approx, perimeter * epsilonRatio, true);

            if (approx.rows !== 4 || !cv.isContourConvex(approx)) {
              continue;
            }

            const points: Point[] = [];
            for (let pointIndex = 0; pointIndex < 4; pointIndex++) {
              points.push({
                x: approx.data32S[pointIndex * 2],
                y: approx.data32S[pointIndex * 2 + 1],
              });
            }

            const evaluation = evaluateQuadDetailed(points, imageWidth, imageHeight, expectedAspectRatio);
            if (observe) {
              const xs = points.map((pt) => pt.x);
              const ys = points.map((pt) => pt.y);
              observe({
                coverageW: (Math.max(...xs) - Math.min(...xs)) / imageWidth,
                coverageH: (Math.max(...ys) - Math.min(...ys)) / imageHeight,
                aspectRatio: (Math.max(...ys) - Math.min(...ys)) / Math.max(1, Math.max(...xs) - Math.min(...xs)),
                marginMin: Math.min(
                  Math.min(...xs) / imageWidth,
                  1 - Math.max(...xs) / imageWidth,
                  Math.min(...ys) / imageHeight,
                  1 - Math.max(...ys) / imageHeight,
                ),
                rejection: evaluation.rejection,
                confidence: evaluation.quality?.confidence ?? null,
              });
            }
            if (evaluation.rejection) {
              const xs2 = points.map((pt) => pt.x);
              const ys2 = points.map((pt) => pt.y);
              const cw = (Math.max(...xs2) - Math.min(...xs2)) / imageWidth;
              const ch = (Math.max(...ys2) - Math.min(...ys2)) / imageHeight;
              const isWholeFrame = cw >= WHOLE_FRAME_COVERAGE && ch >= WHOLE_FRAME_COVERAGE;
              const isPlausible = cw >= PLAUSIBLE_PAGE_COVERAGE && ch >= PLAUSIBLE_PAGE_COVERAGE;
              if (!isWholeFrame && isPlausible) {
                explanation = betterExplanation(explanation, { area: cw * ch, rejection: evaluation.rejection });
              }
            }
            const quality = evaluation.quality;
            if (quality && (!best || quality.confidence > best.confidence)) {
              best = quality;
            }
          } finally {
            approx.delete();
          }
        }
      } finally {
        contour.delete();
      }
    }

    return { quality: best, rejection: best ? null : explanation?.rejection ?? null, explanation: best ? null : explanation };
  } finally {
    hierarchy.delete();
    contours.delete();
  }
}
