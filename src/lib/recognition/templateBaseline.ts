import path from 'path';
import {
  applyTemplateRegistrationFrame,
  getRegistrationBounds,
  loadImageAnalysisData,
  type ImageAnalysisData,
  type PixelRect,
} from './markDensity';
import {
  getTemplate,
  type ChoiceGroup,
  type FormType,
} from './roiTemplates';
import {
  buildCagiGridDetection,
  buildSatisfactionGridDetection,
} from './tableGridDetection';
import { detectBlankBasicCheckboxes } from './basicCheckboxDetection';

export interface BlankFormBaseline {
  image: ImageAnalysisData;
  candidateRects: Record<string, PixelRect[]>;
  fieldRects: Record<string, PixelRect>;
  basicCheckboxCandidateRects?: Record<string, PixelRect[]>;
}

const baselinePromises = new Map<FormType, Promise<BlankFormBaseline | undefined>>();

/**
 * Loads the committed, unmarked form once per runtime. The baseline is used
 * only to distinguish new pen ink from printed circles and grid rules; it
 * never supplies an answer by itself.
 */
export function loadBlankFormBaseline(formType: FormType): Promise<BlankFormBaseline | undefined> {
  const cached = baselinePromises.get(formType);
  if (cached) {
    return cached;
  }

  const loading = createBlankFormBaseline(formType).catch(() => undefined);
  baselinePromises.set(formType, loading);
  return loading;
}

async function createBlankFormBaseline(formType: FormType): Promise<BlankFormBaseline> {
  const template = getTemplate(formType);
  const filename = formType === 'cagi' ? 'cagi-blank.png' : 'satisfaction-blank.png';
  const image = applyTemplateRegistrationFrame(
    await loadImageAnalysisData(path.join(
      process.cwd(),
      'src',
      'lib',
      'recognition',
      'assets',
      filename,
    )),
    template.registrationFrame,
  );
  const grid = formType === 'cagi'
    ? buildCagiGridDetection(image)
    : buildSatisfactionGridDetection(image);
  const basicGroups = template.choiceGroups.filter((group) => group.field.startsWith('basic.'));
  const basicCheckboxes = formType === 'cagi'
    ? detectBlankBasicCheckboxes(image, basicGroups)
    : undefined;

  return {
    image,
    fieldRects: grid.fieldRects,
    candidateRects: Object.fromEntries(template.choiceGroups.map((group) => [
      group.field,
      grid.overrides[group.field] || buildTemplateCandidateRects(image, group),
    ])),
    ...(basicCheckboxes ? { basicCheckboxCandidateRects: basicCheckboxes.candidateRects } : {}),
  };
}

function buildTemplateCandidateRects(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
  group: ChoiceGroup,
): PixelRect[] {
  const bounds = getRegistrationBounds(image);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;

  return group.candidates.map((candidate) => ({
    left: clamp(Math.round(bounds.left + candidate.rect.x * width), 0, image.width - 1),
    top: clamp(Math.round(bounds.top + candidate.rect.y * height), 0, image.height - 1),
    right: clamp(Math.round(bounds.left + (candidate.rect.x + candidate.rect.width) * width), 1, image.width),
    bottom: clamp(Math.round(bounds.top + (candidate.rect.y + candidate.rect.height) * height), 1, image.height),
  })).map((rect) => ({
    ...rect,
    right: Math.max(rect.right, rect.left + 1),
    bottom: Math.max(rect.bottom, rect.top + 1),
  }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
