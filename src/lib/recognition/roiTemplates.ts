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
const cagiOptionXs = [0.742, 0.805, 0.871, 0.944];
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
const satisfactionFrequencyXs = [0.691, 0.772, 0.852, 0.933];
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
      makeChoiceGroup(`cagi.q${String(index + 1).padStart(2, '0')}`, [0, 1, 2, 3], cagiOptionXs, y),
    ),
    ...cagiLateQuestionYs.map((y, index) =>
      makeChoiceGroup(`cagi.q${String(index + 8).padStart(2, '0')}`, [0, 1, 2, 3], cagiOptionXs, y),
    ),
  ],
  fieldRegions: [
    { field: 'basic.age', rect: rect(0.77, 0.163, 0.12, 0.03) },
  ],
};

export const satisfactionTemplate: FormRecognitionTemplate = {
  formType: 'satisfaction',
  baseSize: {
    width: 474,
    height: 656,
  },
  choiceGroups: [
    makeChoiceGroup('satisfaction.q01', [1, 2, 3, 4], satisfactionFrequencyXs, 0.43, 0.025),
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
