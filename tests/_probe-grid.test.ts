import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  loadImageAnalysisData,
  applyTemplateRegistrationFrame,
} from '../src/lib/recognition/markDensity';
import { buildCagiGridDetection, buildSatisfactionGridDetection } from '../src/lib/recognition/tableGridDetection';
import { cagiTemplate, satisfactionTemplate } from '../src/lib/recognition/roiTemplates';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * The corrected photo comes out visually square and its registration frame
 * matches the blank asset to three decimals, yet the grid detector returns
 * zero fields while the raw tilted photo returned nine. Either the detector is
 * resolution-bound or the warp costs it something the tilt did not. Run the
 * same call over the blank asset (known good), the corrected photo, the raw
 * photo, and the corrected photo rescaled, and let the counts say which.
 *
 *   GRID_CASES="label=path,label=path" GRID_FORM=cagi npx vitest run tests/_probe-grid.test.ts
 */

const CASES = (process.env.GRID_CASES || '').split(',').filter(Boolean);
const FORM = (process.env.GRID_FORM || 'cagi') as 'cagi' | 'satisfaction';
const TEMPLATE = FORM === 'cagi' ? cagiTemplate : satisfactionTemplate;
const buildGrid = FORM === 'cagi' ? buildCagiGridDetection : buildSatisfactionGridDetection;

describe.skipIf(CASES.length === 0)('grid detection probe', () => {
  it('counts grid fields per image', async () => {
    const lines: string[] = ['================ GRID ================'];
    for (const entry of CASES) {
      const [label, file] = entry.split('=');
      if (!file || !fs.existsSync(file)) { lines.push(`--- ${label}: MISSING ${file}`); continue; }
      const raw = await loadImageAnalysisData(file);
      const framed = applyTemplateRegistrationFrame(raw, TEMPLATE.registrationFrame);
      const grid = buildGrid(framed);
      const fields = Object.keys(grid.overrides || {});
      const b = framed.contentBounds;
      lines.push(`--- ${label} (${path.basename(file)}) ---`);
      lines.push(`  ${raw.width}x${raw.height}  ink ${(raw.pageInkRatio ?? 0).toFixed(4)}`
        + `  bounds ${b ? `[${(b.left / framed.width).toFixed(3)},${(b.top / framed.height).toFixed(3)}`
          + ` ${((b.right - b.left) / framed.width).toFixed(3)}x${((b.bottom - b.top) / framed.height).toFixed(3)}]` : 'none'}`
        + `  source=${framed.contentBoundsSource}`);
      lines.push(`  grid ${fields.length} fields`
        + (fields.length ? `: ${fields.slice(0, 6).join(', ')}${fields.length > 6 ? ' …' : ''}` : ''));
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }, 600_000);
});
