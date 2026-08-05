import sharp from 'sharp';
import { generateFieldCropBuffer } from './fieldCrop';
import { type PixelRect } from './markDensity';
import { cagiTemplate, satisfactionTemplate } from './roiTemplates';

export interface SourcePreviewAssets {
  cagiImageDataUrl: string;
  satisfactionImageDataUrl: string;
  cropDataUrls: Record<string, string>;
  cropDebugDataUrls: Record<string, string>;
}

export async function buildSourcePreview(
  cagiPath: string,
  satisfactionPath: string,
  fieldCropOverrides: Record<string, PixelRect> = {},
): Promise<SourcePreviewAssets> {
  const [cagiImageDataUrl, satisfactionImageDataUrl, cagiCrops, satisfactionCrops] = await Promise.all([
    buildImageThumbnailDataUrl(cagiPath),
    buildImageThumbnailDataUrl(satisfactionPath),
    buildFieldCropDataUrls(cagiPath, [
      ...cagiTemplate.choiceGroups.map((group) => group.field),
      ...(cagiTemplate.fieldRegions || []).map((region) => region.field),
    ], fieldCropOverrides),
    buildFieldCropDataUrls(satisfactionPath, satisfactionTemplate.choiceGroups.map((group) => group.field), fieldCropOverrides),
  ]);

  return {
    cagiImageDataUrl,
    satisfactionImageDataUrl,
    cropDataUrls: {
      ...cagiCrops.cropDataUrls,
      ...satisfactionCrops.cropDataUrls,
    },
    cropDebugDataUrls: {
      ...cagiCrops.cropDebugDataUrls,
      ...satisfactionCrops.cropDebugDataUrls,
    },
  };
}

async function buildImageThumbnailDataUrl(imagePath: string): Promise<string> {
  const buffer = await sharp(imagePath)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: 640, withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toBuffer();

  return toDataUrl(buffer, 'image/jpeg');
}

async function buildFieldCropDataUrls(
  imagePath: string,
  fields: string[],
  fieldCropOverrides: Record<string, PixelRect>,
): Promise<Pick<SourcePreviewAssets, 'cropDataUrls' | 'cropDebugDataUrls'>> {
  const entries = await Promise.all(
    fields.map(async (field) => {
      const [cropBuffer, debugCropBuffer] = await Promise.all([
        generateFieldCropBuffer(imagePath, field, false, fieldCropOverrides[field]),
        generateFieldCropBuffer(imagePath, field, true, fieldCropOverrides[field]),
      ]);

      return {
        field,
        cropDataUrl: cropBuffer ? toDataUrl(cropBuffer, 'image/png') : undefined,
        cropDebugDataUrl: debugCropBuffer ? toDataUrl(debugCropBuffer, 'image/png') : undefined,
      };
    }),
  );

  const cropDataUrls: Record<string, string> = {};
  const cropDebugDataUrls: Record<string, string> = {};

  for (const entry of entries) {
    if (entry.cropDataUrl) {
      cropDataUrls[entry.field] = entry.cropDataUrl;
    }
    if (entry.cropDebugDataUrl) {
      cropDebugDataUrls[entry.field] = entry.cropDebugDataUrl;
    }
  }

  return { cropDataUrls, cropDebugDataUrls };
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}
