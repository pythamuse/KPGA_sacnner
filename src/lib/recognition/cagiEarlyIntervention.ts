import { calculateDarkPixelDensity, hasUsableFormBounds, loadImageAnalysisData, type ImageAnalysisData } from './markDensity';
import { NormalizedRect } from './roiTemplates';

const MARK_THRESHOLD = 0.34;
const CONTACT_INPUT_THRESHOLD = 0.08;

const rect = (x: number, y: number, width: number, height: number): NormalizedRect => ({
  x,
  y,
  width,
  height,
});

const earlyInterventionMarkRegions: NormalizedRect[] = [
  rect(0.225, 0.7, 0.028, 0.024),
  rect(0.415, 0.7, 0.028, 0.024),
  rect(0.62, 0.7, 0.028, 0.024),
  rect(0.74, 0.7, 0.028, 0.024),
  rect(0.86, 0.7, 0.028, 0.024),
];

const nameInputRegion = rect(0.15, 0.715, 0.24, 0.03);
const contactInputRegion = rect(0.55, 0.715, 0.32, 0.03);

export interface CagiEarlyInterventionDetection {
  hasMarks: boolean;
  hasContactInformation: boolean;
}

export async function detectCagiEarlyIntervention(filePath: string): Promise<CagiEarlyInterventionDetection> {
  try {
    const image = await loadImageAnalysisData(filePath);
    return detectCagiEarlyInterventionFromImage(image);
  } catch {
    return { hasMarks: false, hasContactInformation: false };
  }
}

export async function hasCagiEarlyInterventionMarks(filePath: string): Promise<boolean> {
  return (await detectCagiEarlyIntervention(filePath)).hasMarks;
}

/**
 * Checks only for writing traces in the two entry cells. The value itself is
 * intentionally never OCR'd, returned, persisted, or included in a warning.
 */
export function detectCagiEarlyInterventionFromImage(image: ImageAnalysisData): CagiEarlyInterventionDetection {
  if (!hasUsableFormBounds(image)) {
    return { hasMarks: false, hasContactInformation: false };
  }

  const hasMarks = earlyInterventionMarkRegions.some((region) =>
    calculateDarkPixelDensity(image, region) >= MARK_THRESHOLD,
  );
  const hasContactInformation =
    calculateDarkPixelDensity(image, nameInputRegion) >= CONTACT_INPUT_THRESHOLD &&
    calculateDarkPixelDensity(image, contactInputRegion) >= CONTACT_INPUT_THRESHOLD;

  return { hasMarks, hasContactInformation };
}
