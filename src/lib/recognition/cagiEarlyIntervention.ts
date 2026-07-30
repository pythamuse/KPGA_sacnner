import { calculateDarkPixelDensity, loadImageAnalysisData } from './markDensity';
import { NormalizedRect } from './roiTemplates';

const MARK_THRESHOLD = 0.34;

const rect = (x: number, y: number, width: number, height: number): NormalizedRect => ({
  x,
  y,
  width,
  height,
});

const earlyInterventionMarkRegions: NormalizedRect[] = [
  rect(0.175, 0.654, 0.028, 0.024),
  rect(0.386, 0.738, 0.028, 0.024),
  rect(0.56, 0.738, 0.028, 0.024),
  rect(0.786, 0.738, 0.028, 0.024),
  rect(0.896, 0.738, 0.028, 0.024),
  rect(0.196, 0.885, 0.03, 0.026),
  rect(0.372, 0.94, 0.03, 0.026),
  rect(0.49, 0.94, 0.03, 0.026),
];

export async function hasCagiEarlyInterventionMarks(filePath: string): Promise<boolean> {
  try {
    const image = await loadImageAnalysisData(filePath);
    return earlyInterventionMarkRegions.some((region) =>
      calculateDarkPixelDensity(image, region) >= MARK_THRESHOLD,
    );
  } catch {
    return false;
  }
}
