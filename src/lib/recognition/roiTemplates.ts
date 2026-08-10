export type FormType = 'cagi' | 'satisfaction';

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChoiceCandidate {
  value: number | string;
  rect: NormalizedRect;
}

export interface ChoiceGroup {
  field: string;
  candidates: ChoiceCandidate[];
}

export interface FieldRegion {
  field: string;
  rect: NormalizedRect;
}

export interface FormRecognitionTemplate {
  formType: FormType;
  baseSize: {
    width: number;
    height: number;
  };
  /**
   * Printed-content frame measured from the blank form, normalized to the
   * physical sheet. Real photos are registered to this frame after the sheet
   * itself has been detected, rather than from a dark-pixel envelope that can
   * include a desk edge, cable, or shadow.
   */
  registrationFrame?: NormalizedRect;
  choiceGroups: ChoiceGroup[];
  fieldRegions?: FieldRegion[];
}

const rect = (x: number, y: number, width: number, height: number): NormalizedRect => ({
  x,
  y,
  width,
  height,
});

// Calibrated against the official A4 form's printed table geometry. These
// coordinates are only a search anchor; tableGridDetection must still find
// the actual row and column rules before an answer can be confirmed.
// Measured from the committed blank CAGI form. The primary and late question
// tables have slightly different printed column geometry, so they must not
// share one approximate X-axis anchor.
const cagiPrimaryOptionXs = [0.6898, 0.7468, 0.8092, 0.8805];
const cagiLateOptionXs = [0.6901, 0.7471, 0.8092, 0.8771];
export const cagiQuestionYs = [0.334, 0.358, 0.383, 0.401, 0.419, 0.436, 0.455];
export const cagiLateQuestionYs = [0.512, 0.53];
const schoolTypeCandidates = [
  { value: 'elementary', rect: rect(0.335, 0.164, 0.025, 0.02) },
  { value: 'middle', rect: rect(0.512, 0.164, 0.025, 0.02) },
  { value: 'high', rect: rect(0.335, 0.183, 0.025, 0.02) },
  { value: 'outside', rect: rect(0.622, 0.164, 0.025, 0.02) },
];
const gradeCandidates = [
  { value: 'grade1', rect: rect(0.245, 0.198, 0.024, 0.02) },
  { value: 'grade2', rect: rect(0.39, 0.198, 0.024, 0.02) },
  { value: 'grade3', rect: rect(0.535, 0.198, 0.024, 0.02) },
  { value: 'grade4', rect: rect(0.245, 0.218, 0.024, 0.02) },
  { value: 'grade5', rect: rect(0.39, 0.218, 0.024, 0.02) },
  { value: 'grade6', rect: rect(0.535, 0.218, 0.024, 0.02) },
];
export const satisfactionFrequencyXs = [0.691, 0.772, 0.852, 0.9419];
const satisfactionBinaryXs = [0.849, 0.934];
const satisfactionScaleXs = [0.583, 0.677, 0.764, 0.849, 0.943];
export const satisfactionBinaryYs = [0.43, 0.478, 0.526, 0.561, 0.596];
export const satisfactionScaleYs = [0.75, 0.78, 0.811, 0.841];

const makeChoiceGroup = (
  field: string,
  values: Array<number | string>,
  xs: number[],
  y: number,
  size = 0.018,
): ChoiceGroup => ({
  field,
  candidates: values.map((value, index) => ({
    value,
    rect: rect(xs[index] - size / 2, y - size / 2, size, size),
  })),
});

export const cagiTemplate: FormRecognitionTemplate = {
  formType: 'cagi',
  baseSize: {
    width: 474,
    height: 656,
  },
  // Measured from templates/blank-cagi.png: [154, 190] - [1619, 2219]
  // inside a 1654 x 2337 page.
  registrationFrame: rect(0.0931, 0.0813, 0.8857, 0.8682),
  choiceGroups: [
    {
      field: 'basic.gender',
      candidates: [
        { value: '남', rect: rect(0.792, 0.145, 0.022, 0.018) },
        { value: '여', rect: rect(0.91, 0.145, 0.022, 0.018) },
      ],
    },
    {
      field: 'basic.schoolType',
      candidates: schoolTypeCandidates,
    },
    {
      field: 'basic.grade',
      candidates: gradeCandidates,
    },
    ...cagiQuestionYs.map((y, index) =>
      makeChoiceGroup(`cagi.q${String(index + 1).padStart(2, '0')}`, [0, 1, 2, 3], cagiPrimaryOptionXs, y),
    ),
    ...cagiLateQuestionYs.map((y, index) =>
      makeChoiceGroup(`cagi.q${String(index + 8).padStart(2, '0')}`, [0, 1, 2, 3], cagiLateOptionXs, y),
    ),
  ],
  fieldRegions: [
    // Measured from the inner age-number rectangle on cagi-blank.png:
    // [1204, 517] - [1364, 563] in the [154, 190] - [1619, 2219]
    // registration frame. The prior anchor started at the printed "세"
    // suffix, so a correct photograph could never expose the handwritten
    // digits to OCR.
    { field: 'basic.age', rect: rect(0.716, 0.162, 0.11, 0.023) },
  ],
};

export const satisfactionTemplate: FormRecognitionTemplate = {
  formType: 'satisfaction',
  baseSize: {
    width: 474,
    height: 656,
  },
  // Measured from templates/blank-satisfaction.png: [155, 207] -
  // [1513, 2219] inside a 1654 x 2337 page.
  registrationFrame: rect(0.0938, 0.0886, 0.8210, 0.8609),
  choiceGroups: [
    makeChoiceGroup('satisfaction.q01', [1, 2, 3, 4], satisfactionFrequencyXs, 0.2852, 0.025),
    ...satisfactionBinaryYs.map((y, index) =>
      makeChoiceGroup(`satisfaction.q${String(index + 2).padStart(2, '0')}`, [0, 1], satisfactionBinaryXs, y, 0.022),
    ),
    ...satisfactionScaleYs.map((y, index) =>
      makeChoiceGroup(`satisfaction.q${String(index + 7).padStart(2, '0')}`, [0, 1, 2, 3, 4], satisfactionScaleXs, y, 0.022),
    ),
  ],
};

export function getTemplate(formType: FormType): FormRecognitionTemplate {
  return formType === 'cagi' ? cagiTemplate : satisfactionTemplate;
}
