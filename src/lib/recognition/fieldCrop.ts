import sharp from 'sharp';
import { loadImageAnalysisData, type PixelRect } from './markDensity';
import { cagiTemplate, ChoiceGroup, FieldRegion, NormalizedRect, satisfactionTemplate } from './roiTemplates';

export interface CropBox {
  left: number;
  top: number;
  width: number;
  height: number;
  roi: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export function findChoiceGroup(field: string): ChoiceGroup | undefined {
  return [...cagiTemplate.choiceGroups, ...satisfactionTemplate.choiceGroups].find((group) => group.field === field);
}

export function findFieldRegion(field: string): FieldRegion | undefined {
  return [...(cagiTemplate.fieldRegions || []), ...(satisfactionTemplate.fieldRegions || [])].find((region) => region.field === field);
}

export function findCropRect(field: string): NormalizedRect | undefined {
  const group = findChoiceGroup(field);
  if (group) return getUnionRect(group);

  return findFieldRegion(field)?.rect;
}

export function getUnionRect(group: ChoiceGroup): NormalizedRect {
  const left = Math.min(...group.candidates.map((candidate) => candidate.rect.x));
  const top = Math.min(...group.candidates.map((candidate) => candidate.rect.y));
  const right = Math.max(...group.candidates.map((candidate) => candidate.rect.x + candidate.rect.width));
  const bottom = Math.max(...group.candidates.map((candidate) => candidate.rect.y + candidate.rect.height));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

export function getCropBox(
  image: { width: number; height: number; contentBounds?: { left: number; top: number; right: number; bottom: number } },
  rect: NormalizedRect,
  paddingRatio: number,
): CropBox {
  const bounds = image.contentBounds || {
    left: 0,
    top: 0,
    right: image.width,
    bottom: image.height,
  };
  const baseWidth = bounds.right - bounds.left;
  const baseHeight = bounds.bottom - bounds.top;
  const paddingX = Math.max(8, Math.round(baseWidth * paddingRatio));
  const paddingY = Math.max(8, Math.round(baseHeight * paddingRatio));

  const roiLeft = Math.floor(bounds.left + rect.x * baseWidth);
  const roiTop = Math.floor(bounds.top + rect.y * baseHeight);
  const roiRight = Math.ceil(bounds.left + (rect.x + rect.width) * baseWidth);
  const roiBottom = Math.ceil(bounds.top + (rect.y + rect.height) * baseHeight);

  const left = clamp(roiLeft - paddingX, 0, image.width - 1);
  const top = clamp(roiTop - paddingY, 0, image.height - 1);
  const right = clamp(roiRight + paddingX, left + 1, image.width);
  const bottom = clamp(roiBottom + paddingY, top + 1, image.height);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    roi: {
      left: roiLeft - left,
      top: roiTop - top,
      width: roiRight - roiLeft,
      height: roiBottom - roiTop,
    },
  };
}

export function getPixelCropBox(
  image: { width: number; height: number; contentBounds?: { left: number; top: number; right: number; bottom: number } },
  rect: PixelRect,
  paddingRatio: number,
): CropBox {
  const roiLeft = clamp(Math.floor(rect.left), 0, image.width - 1);
  const roiTop = clamp(Math.floor(rect.top), 0, image.height - 1);
  const roiRight = clamp(Math.ceil(rect.right), roiLeft + 1, image.width);
  const roiBottom = clamp(Math.ceil(rect.bottom), roiTop + 1, image.height);
  // Pixel overrides represent one detected response row, unlike normalized
  // template regions. Their padding must track the cell itself so adjacent
  // questions do not leak into the review crop.
  const paddingX = Math.max(8, Math.round((roiRight - roiLeft) * paddingRatio * 6));
  const paddingY = Math.max(8, Math.round((roiBottom - roiTop) * paddingRatio * 6));
  const left = clamp(roiLeft - paddingX, 0, image.width - 1);
  const top = clamp(roiTop - paddingY, 0, image.height - 1);
  const right = clamp(roiRight + paddingX, left + 1, image.width);
  const bottom = clamp(roiBottom + paddingY, top + 1, image.height);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    roi: {
      left: roiLeft - left,
      top: roiTop - top,
      width: roiRight - roiLeft,
      height: roiBottom - roiTop,
    },
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function generateFieldCropBuffer(
  imagePath: string,
  field: string,
  debug: boolean,
  pixelRect?: PixelRect,
): Promise<Buffer | undefined> {
  const cropRect = pixelRect ? undefined : findCropRect(field);
  if (!cropRect && !pixelRect) return undefined;

  const analysis = await loadImageAnalysisData(imagePath);
  const cropBox = pixelRect
    ? getPixelCropBox(analysis, pixelRect, debug ? 0.07 : 0.022)
    : getCropBox(analysis, cropRect!, debug ? 0.07 : 0.022);

  const extracted = sharp(imagePath)
    .rotate()
    .flatten({ background: '#ffffff' })
    .extract({
      left: cropBox.left,
      top: cropBox.top,
      width: cropBox.width,
      height: cropBox.height,
    })
    .resize({ width: 520, withoutEnlargement: true });

  return debug
    ? addDebugOverlay(extracted, cropBox, pixelRect ? `${field} grid-cell` : `${field} ${serializeRect(cropRect!)}`)
    : extracted.png().toBuffer();
}

export async function addDebugOverlay(
  image: sharp.Sharp,
  cropBox: CropBox,
  label?: string,
): Promise<Buffer> {
  const { data, info } = await image.png().toBuffer({ resolveWithObject: true });
  const width = info.width || cropBox.width;
  const height = info.height || cropBox.height;
  const scaleX = width / cropBox.width;
  const scaleY = height / cropBox.height;
  const roi = {
    left: cropBox.roi.left * scaleX,
    top: cropBox.roi.top * scaleY,
    width: cropBox.roi.width * scaleX,
    height: cropBox.roi.height * scaleY,
  };
  const centerX = roi.left + roi.width / 2;
  const centerY = roi.top + roi.height / 2;
  const labelText = escapeSvgText(label || '');
  const overlay = Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#6855a0" stroke-width="2"/>
      <rect x="${roi.left}" y="${roi.top}" width="${roi.width}" height="${roi.height}" fill="none" stroke="#d83024" stroke-width="3"/>
      <line x1="${centerX}" y1="${Math.max(0, centerY - 9)}" x2="${centerX}" y2="${Math.min(height, centerY + 9)}" stroke="#d83024" stroke-width="2"/>
      <line x1="${Math.max(0, centerX - 9)}" y1="${centerY}" x2="${Math.min(width, centerX + 9)}" y2="${centerY}" stroke="#d83024" stroke-width="2"/>
      ${labelText ? `<rect x="8" y="8" width="${Math.min(width - 16, Math.max(180, labelText.length * 7 + 18))}" height="24" rx="4" fill="rgba(255,255,255,0.92)" stroke="#6855a0" stroke-width="1"/><text x="17" y="25" fill="#55438a" font-family="Arial, sans-serif" font-size="12" font-weight="700">${labelText}</text>` : ''}
    </svg>
  `);

  return sharp(data)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

export function serializeRect(rect: NormalizedRect): string {
  return `x=${rect.x};y=${rect.y};width=${rect.width};height=${rect.height}`;
}

export function serializeCropBox(cropBox: { left: number; top: number; width: number; height: number }): string {
  return `left=${cropBox.left};top=${cropBox.top};width=${cropBox.width};height=${cropBox.height}`;
}

export function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
