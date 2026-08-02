export interface Point {
  x: number;
  y: number;
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

  let topLeft = points[0];
  let topRight = points[0];
  let bottomRight = points[0];
  let bottomLeft = points[0];

  for (const point of points) {
    const sum = point.x + point.y;
    const diff = point.y - point.x;

    if (sum < topLeft.x + topLeft.y) {
      topLeft = point;
    }
    if (sum > bottomRight.x + bottomRight.y) {
      bottomRight = point;
    }
    if (diff < topRight.y - topRight.x) {
      topRight = point;
    }
    if (diff > bottomLeft.y - bottomLeft.x) {
      bottomLeft = point;
    }
  }

  return [topLeft, topRight, bottomRight, bottomLeft];
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
