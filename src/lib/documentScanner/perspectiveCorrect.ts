export interface Point {
  x: number;
  y: number;
}

export interface QuadQuality {
  points: Point[];
  areaRatio: number;
  aspectRatio: number;
  confidence: number;
  angleScore: number;
  edgeConsistency: number;
}

export function detectDocumentQuad(cv: any, canvas: HTMLCanvasElement): Point[] | null {
  const source = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 75, 200);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const imageArea = canvas.width * canvas.height;
    const minDocumentArea = imageArea * 0.2;
    let bestArea = 0;
    let bestQuad: Point[] | null = null;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const approx = new cv.Mat();

      try {
        const perimeter = cv.arcLength(contour, true);
        cv.approxPolyDP(contour, approx, perimeter * 0.02, true);

        if (approx.rows !== 4 || !cv.isContourConvex(approx)) {
          continue;
        }

        const area = Math.abs(cv.contourArea(approx));
        if (area < minDocumentArea || area <= bestArea) {
          continue;
        }

        const points: Point[] = [];
        for (let pointIndex = 0; pointIndex < 4; pointIndex++) {
          points.push({
            x: approx.data32S[pointIndex * 2],
            y: approx.data32S[pointIndex * 2 + 1],
          });
        }

        bestArea = area;
        bestQuad = points;
      } finally {
        approx.delete();
        contour.delete();
      }
    }

    return bestQuad;
  } finally {
    hierarchy.delete();
    contours.delete();
    edges.delete();
    blurred.delete();
    gray.delete();
    source.delete();
  }
}

export function orderQuadPoints(points: Point[]): Point[] {
  if (points.length !== 4) {
    throw new Error('orderQuadPoints requires exactly 4 points.');
  }

  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
    { x: 0, y: 0 },
  );
  const sorted = [...points].sort((a, b) => (
    Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x)
  ));
  let topLeftIndex = 0;

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].x + sorted[i].y < sorted[topLeftIndex].x + sorted[topLeftIndex].y) {
      topLeftIndex = i;
    }
  }

  return [0, 1, 2, 3].map((offset) => sorted[(topLeftIndex + offset) % sorted.length]);
}

// The page quads measured on real photos span 1.300 to 1.415 against an
// expected 1.384, so a 1.25x band holds every one of them with room to
// spare while still excluding both off-shape printed blocks (0.19, 2.10).
const PAGE_ASPECT_TOLERANCE = 1.25;

// A quad flush against the frame edge is the signature of a page that runs
// off the photo, so what it encloses is not the whole sheet. That is the case
// the position test is here to catch -- the rejected candidate in
// tests/perspective-correct.test.ts sits 1.7% from the right edge. It used to
// be written as "must span from 20% to 80% of the frame", which is a
// centring requirement rather than a cropping one: a page covering 66% with
// margins of 13% and 21% is whole and well inside the frame, and was rejected
// anyway.
const MIN_FRAME_MARGIN = 0.02;

export function evaluateQuad(
  points: Point[],
  imageWidth: number,
  imageHeight: number,
  expectedAspectRatio: number,
): QuadQuality | null {
  if (points.length !== 4 || imageWidth <= 0 || imageHeight <= 0 || expectedAspectRatio <= 0) {
    return null;
  }

  const ordered = orderQuadPoints(points);
  if (!isConvexQuad(ordered)) {
    return null;
  }

  const [topLeft, topRight, bottomRight, bottomLeft] = ordered;
  const topWidth = distance(topLeft, topRight);
  const bottomWidth = distance(bottomLeft, bottomRight);
  const leftHeight = distance(topLeft, bottomLeft);
  const rightHeight = distance(topRight, bottomRight);
  const averageWidth = (topWidth + bottomWidth) / 2;
  const averageHeight = (leftHeight + rightHeight) / 2;

  if (averageWidth <= 0 || averageHeight <= 0) {
    return null;
  }

  // A form table can also produce a clean convex quadrilateral. It must be
  // large enough to plausibly be the page before it is allowed to drive a
  // perspective warp. Otherwise an inner table may be stretched into a
  // page-sized image and later confuse the server-side form classifier.
  const left = Math.min(...ordered.map((point) => point.x));
  const right = Math.max(...ordered.map((point) => point.x));
  const top = Math.min(...ordered.map((point) => point.y));
  const bottom = Math.max(...ordered.map((point) => point.y));
  const widthCoverage = (right - left) / imageWidth;
  const heightCoverage = (bottom - top) / imageHeight;

  // What this gate is for: a printed table inside the form can also produce a
  // clean convex quadrilateral, and warping one into a page-sized image would
  // feed the server a stretched table for fixed-ROI classification.
  //
  // It used to do that with size alone, at 0.70 wide by 0.78 tall. Measured
  // against the forms themselves, that was about three times stricter than the
  // job needs on one axis -- and it was rejecting real pages. On ten sample photos the
  // largest printed cluster that shares the page's aspect is the CAGI answer
  // column at 0.21 x 0.21, while the page quads the detector actually found
  // ranged from 0.60 x 0.58 to 0.84 x 0.88. Five of ten pages failed the old
  // floor and were reported `no-document`; the panel then uploaded the
  // unrectified photo, which scored CORRECT 8 / WRONG 13 against the key.
  //
  // So the floor moves down to where it still clears the largest same-aspect
  // table by nearly 3x, and the shape test the old rule lacked is added
  // beside it: the quad must also be page-shaped. That pair excludes every
  // printed cluster on both forms -- the CAGI answer column on size, the CAGI
  // basic block (aspect 0.19) and the satisfaction answer block (aspect 2.10)
  // on shape. Nine of the ten photos now rectify; the tenth fills only 58% of
  // the frame height, which is a capture problem and stays refused.
  const aspectRatio = averageHeight / averageWidth;
  if (
    widthCoverage < 0.6 ||
    heightCoverage < 0.6 ||
    left < imageWidth * MIN_FRAME_MARGIN ||
    right > imageWidth * (1 - MIN_FRAME_MARGIN) ||
    top < imageHeight * MIN_FRAME_MARGIN ||
    bottom > imageHeight * (1 - MIN_FRAME_MARGIN) ||
    aspectRatio < expectedAspectRatio / PAGE_ASPECT_TOLERANCE ||
    aspectRatio > expectedAspectRatio * PAGE_ASPECT_TOLERANCE
  ) {
    return null;
  }

  const areaRatio = polygonArea(ordered) / (imageWidth * imageHeight);
  const widthConsistency = Math.min(topWidth, bottomWidth) / Math.max(topWidth, bottomWidth);
  const heightConsistency = Math.min(leftHeight, rightHeight) / Math.max(leftHeight, rightHeight);
  const edgeConsistency = (widthConsistency + heightConsistency) / 2;
  const angleScore = ordered.reduce((score, _, index) => {
    const previous = ordered[(index + 3) % 4];
    const current = ordered[index];
    const next = ordered[(index + 1) % 4];
    const first = { x: previous.x - current.x, y: previous.y - current.y };
    const second = { x: next.x - current.x, y: next.y - current.y };
    const denominator = Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y);

    if (denominator === 0) {
      return score;
    }

    const cosine = clamp((first.x * second.x + first.y * second.y) / denominator, -1, 1);
    const angle = Math.acos(cosine) * (180 / Math.PI);
    return score + clamp(1 - Math.abs(90 - angle) / 90, 0, 1);
  }, 0) / 4;
  const areaScore = clamp((areaRatio - 0.18) / 0.52, 0, 1);
  const aspectScore = clamp(
    1 - Math.abs(Math.log(aspectRatio / expectedAspectRatio)) / Math.log(1.9),
    0,
    1,
  );
  const confidence = clamp(
    areaScore * 0.35 + aspectScore * 0.3 + edgeConsistency * 0.2 + angleScore * 0.15,
    0,
    1,
  );

  return {
    points: ordered,
    areaRatio,
    aspectRatio,
    confidence,
    angleScore,
    edgeConsistency,
  };
}

function isConvexQuad(points: Point[]): boolean {
  let sign = 0;

  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const following = points[(i + 2) % points.length];
    const cross = (next.x - current.x) * (following.y - next.y) -
      (next.y - current.y) * (following.x - next.x);

    if (cross === 0) {
      return false;
    }

    const currentSign = cross > 0 ? 1 : -1;
    if (sign === 0) {
      sign = currentSign;
    } else if (sign !== currentSign) {
      return false;
    }
  }

  return true;
}

function polygonArea(points: Point[]): number {
  let sum = 0;

  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }

  return Math.abs(sum) / 2;
}

function distance(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function warpToRectangle(
  cv: any,
  canvas: HTMLCanvasElement,
  quad: Point[],
  outputWidth: number,
  outputHeight: number,
): HTMLCanvasElement {
  const [topLeft, topRight, bottomRight, bottomLeft] = orderQuadPoints(quad);
  const source = cv.imread(canvas);
  const sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    topLeft.x,
    topLeft.y,
    topRight.x,
    topRight.y,
    bottomRight.x,
    bottomRight.y,
    bottomLeft.x,
    bottomLeft.y,
  ]);
  const destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0,
    0,
    outputWidth - 1,
    0,
    outputWidth - 1,
    outputHeight - 1,
    0,
    outputHeight - 1,
  ]);
  const transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
  const result = new cv.Mat();
  const outputCanvas = document.createElement('canvas');

  try {
    outputCanvas.width = outputWidth;
    outputCanvas.height = outputHeight;
    cv.warpPerspective(
      source,
      result,
      transform,
      new cv.Size(outputWidth, outputHeight),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(),
    );
    cv.imshow(outputCanvas, result);
    return outputCanvas;
  } finally {
    result.delete();
    transform.delete();
    destinationPoints.delete();
    sourcePoints.delete();
    source.delete();
  }
}
