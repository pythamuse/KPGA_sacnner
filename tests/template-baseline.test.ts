import { describe, expect, it } from 'vitest';
import { getTemplate } from '../src/lib/recognition/roiTemplates';
import { loadBlankFormBaseline } from '../src/lib/recognition/templateBaseline';

describe('committed blank form baselines', () => {
  it.each(['cagi', 'satisfaction'] as const)('loads the %s baseline with every answer cell', async (formType) => {
    const baseline = await loadBlankFormBaseline(formType);
    const template = getTemplate(formType);

    expect(baseline).toBeDefined();
    expect(baseline?.image.contentBoundsSource).toBe('template');
    if (formType === 'cagi') {
      expect(baseline?.fieldRects).toHaveProperty('basic.age');
      const basicCheckboxRects = Object.values(baseline?.basicCheckboxCandidateRects || {}).flat();
      expect(basicCheckboxRects).toHaveLength(12);
      expect(new Set(basicCheckboxRects.map((rect) => `${rect.left},${rect.top},${rect.right},${rect.bottom}`)).size)
        .toBe(12);
    }

    for (const group of template.choiceGroups) {
      expect(baseline?.candidateRects[group.field]).toHaveLength(group.candidates.length);
    }
  });
});
