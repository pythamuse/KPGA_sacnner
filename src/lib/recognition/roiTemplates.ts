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

const cagiOptionXs = [0.746, 0.809, 0.876, 0.951];
const cagiQuestionYs = [0.36, 0.383, 0.405, 0.427, 0.449, 0.471, 0.493];
const cagiLateQuestionYs = [0.548, 0.57];
const schoolTypeCandidates = [
  { value: 'elementary', rect: rect(0.335, 0.177, 0.025, 0.02) },
  { value: 'middle', rect: rect(0.512, 0.177, 0.025, 0.02) },
  { value: 'high', rect: rect(0.335, 0.204, 0.025, 0.02) },
  { value: 'outside', rect: rect(0.622, 0.177, 0.025, 0.02) },
];
const gradeCandidates = [
  { value: 'grade1', rect: rect(0.245, 0.231, 0.024, 0.02) },
  { value: 'grade2', rect: rect(0.39, 0.231, 0.024, 0.02) },
  { value: 'grade3', rect: rect(0.535, 0.231, 0.024, 0.02) },
  { value: 'grade4', rect: rect(0.245, 0.257, 0.024, 0.02) },
  { value: 'grade5', rect: rect(0.39, 0.257, 0.024, 0.02) },
  { value: 'grade6', rect: rect(0.535, 0.257, 0.024, 0.02) },
];
const satisfactionFrequencyXs = [0.668, 0.748, 0.827, 0.908];
const satisfactionBinaryXs = [0.815, 0.903];
const satisfactionScaleXs = [0.595, 0.686, 0.777, 0.866, 0.945];
const satisfactionBinaryYs = [0.462, 0.507, 0.552, 0.596, 0.641];
const satisfactionScaleYs = [0.723, 0.765, 0.806, 0.848];

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
        { value: '남', rect: rect(0.748, 0.151, 0.022, 0.018) },
        { value: '여', rect: rect(0.865, 0.151, 0.022, 0.018) },
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
    { field: 'basic.age', rect: rect(0.795, 0.17, 0.13, 0.055) },
  ],
};

export const satisfactionTemplate: FormRecognitionTemplate = {
  formType: 'satisfaction',
  baseSize: {
    width: 474,
    height: 656,
  },
  choiceGroups: [
    makeChoiceGroup('satisfaction.q01', [1, 2, 3, 4], satisfactionFrequencyXs, 0.35, 0.025),
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
