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
    }

    for (const group of template.choiceGroups) {
      expect(baseline?.candidateRects[group.field]).toHaveLength(group.candidates.length);
    }
  });
});
