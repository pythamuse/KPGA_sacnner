import { describe, it } from 'vitest';
import { loadImageAnalysisData, applyTemplateRegistrationFrame } from '../src/lib/recognition/markDensity';
import { getTemplate } from '../src/lib/recognition/roiTemplates';
import { buildSatisfactionGridDetection, buildCagiGridDetection } from '../src/lib/recognition/tableGridDetection';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * Prints the registration diagnostic (with the detected-line evidence) for
 * one table on one already-rasterised page, through the same registration
 * frame the product applies. Used to compare the browser JPEG of set 1 p4
 * with the node render of the same page (FIELD_TEST §34.3).
 *
 *   IMAGE=..jpg TEMPLATE=sat FIELD=satisfaction.q07 npx vitest run tests/_probe-lines.test.ts
 */
const IMAGE = process.env.IMAGE;
const TEMPLATE = (process.env.TEMPLATE || 'sat').toLowerCase();
const FIELD = process.env.FIELD || 'satisfaction.q07';
const run = IMAGE ? describe : describe.skip;

run('line evidence', () => {
  it('prints the registration diagnostic for one field', async () => {
    const template = getTemplate(TEMPLATE === 'cagi' ? 'cagi' : 'satisfaction');
    const raw = await loadImageAnalysisData(IMAGE!);
    const registered = applyTemplateRegistrationFrame(raw, template.registrationFrame);
    const detection = TEMPLATE === 'cagi' ? buildCagiGridDetection(registered) : buildSatisfactionGridDetection(registered);
    const reg = detection.registrations?.[FIELD];
    console.info(`[lines] image=${IMAGE} bounds=${JSON.stringify(registered.contentBounds)} source=${registered.contentBoundsSource}`);
    console.info(`[lines] ${FIELD}: status=${reg?.status} hLines=${JSON.stringify(reg?.horizontalLines)} vLines=${JSON.stringify(reg?.verticalLines)}`);
    console.info(`[lines] diagnostic=${reg?.diagnostic ?? '(none)'}`);
    const cells = detection.overrides[FIELD];
    console.info(`[lines] cells=${cells ? cells.map((c) => `${c.left}-${c.right}x${c.top}-${c.bottom}`).join(' | ') : 'none'}`);
  }, 120_000);
});
