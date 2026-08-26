import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  loadImageAnalysisData,
  applyTemplateRegistrationFrame,
  detectPaperBounds,
  hasUsableFormBounds,
} from '../src/lib/recognition/markDensity';
import { buildCagiGridDetection, buildSatisfactionGridDetection } from '../src/lib/recognition/tableGridDetection';
import { cagiTemplate, satisfactionTemplate } from '../src/lib/recognition/roiTemplates';

/**
 * ONE-OFF PROBE -- delete after the round. §0 of the photo-path plan.
 *
 * Before asking what a photo recognises, ask whether the pipeline can put a
 * coordinate frame on it at all. If `hasUsableFormBounds` is false the whole
 * page is refused before a single cell is scored, and any accuracy number would
 * be measuring that refusal rather than the recognition.
 *
 *   PHOTO_DIR="C:/.../사진샘플/선별검사" npx vitest run tests/_probe-photo.test.ts
 */

const PHOTO_DIR = process.env.PHOTO_DIR;
const FORM = (process.env.PHOTO_FORM || 'cagi') as 'cagi' | 'satisfaction';
const TEMPLATE = FORM === 'cagi' ? cagiTemplate : satisfactionTemplate;
const buildGrid = FORM === 'cagi' ? buildCagiGridDetection : buildSatisfactionGridDetection;
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'photo-frame.txt');

describe.skipIf(!PHOTO_DIR)('photo frame probe', () => {
  it('reports whether each photo gets a usable form frame', async () => {
    const files = fs.readdirSync(PHOTO_DIR!)
      .filter((f) => /\.(jpe?g|png)$/i.test(f))
      .sort();

    const lines: string[] = ['================ PHOTO FRAME ================'];
    lines.push(`${files.length} files from ${PHOTO_DIR}`);
    lines.push('');

    for (const file of files) {
      const full = path.join(PHOTO_DIR!, file);
      // Appended rather than logged: vitest buffers console output, so a run
      // that is killed loses exactly the lines that would say where it stopped.
      const mark = (stage: string) => {
        fs.appendFileSync(`${OUT}.trail.txt`,
          `[${new Date().toISOString().slice(11, 23)}] ${file} ${stage}\n`);
      };
      mark('load…');
      const raw = await loadImageAnalysisData(full);
      mark(`loaded ${raw.width}x${raw.height}`);
      const paper = detectPaperBounds(raw);
      mark('paperBounds done');
      const framed = applyTemplateRegistrationFrame(raw, TEMPLATE.registrationFrame);
      const usable = hasUsableFormBounds(framed);
      mark(`frame ${usable ? 'usable' : 'REFUSED'}`);

      const b = framed.contentBounds;
      const norm = b
        ? `[${(b.left / framed.width).toFixed(3)},${(b.top / framed.height).toFixed(3)}`
          + ` ${((b.right - b.left) / framed.width).toFixed(3)}x${((b.bottom - b.top) / framed.height).toFixed(3)}]`
        : 'none';

      lines.push(`--- ${file} ---`);
      lines.push(`  size ${raw.width}x${raw.height}   pageInkRatio ${(raw.pageInkRatio ?? 0).toFixed(4)}`);
      lines.push(`  detectPaperBounds: ${paper
        ? `[${paper.left},${paper.top} ${paper.right - paper.left}x${paper.bottom - paper.top}]`
          + `  aspect ${((paper.bottom - paper.top) / (paper.right - paper.left)).toFixed(3)}`
          + `  coverage ${((paper.right - paper.left) / raw.width).toFixed(2)}x${((paper.bottom - paper.top) / raw.height).toFixed(2)}`
        : 'NULL  <-- paper not found'}`);
      lines.push(`  contentBoundsSource=${framed.contentBoundsSource}`
        + `  confident=${framed.contentBoundsConfident}`
        + (framed.contentBoundsRejection ? `  rejection=${framed.contentBoundsRejection}` : ''));
      lines.push(`  contentBounds ${norm}`);
      lines.push(`  ★ hasUsableFormBounds = ${usable}${usable ? '' : '   <-- every field refused before scoring'}`);

      if (usable) {
        mark('grid…');
        const grid = buildGrid(framed);
        mark('grid done');
        const fields = Object.keys(grid.overrides || {});
        lines.push(`  grid: ${fields.length} fields got cells`
          + (fields.length ? `  (${fields.slice(0, 4).join(', ')}${fields.length > 4 ? ' …' : ''})` : ''));
      }
      lines.push('');
    }

    // The blank asset and a scan render, for scale.
    for (const [label, file] of [
      ['blank asset', path.join(process.cwd(), 'src/lib/recognition/assets/' + (FORM === 'cagi' ? 'cagi-blank.png' : 'satisfaction-blank.png'))],
    ] as const) {
      if (!fs.existsSync(file)) continue;
      const raw = await loadImageAnalysisData(file);
      const framed = applyTemplateRegistrationFrame(raw, TEMPLATE.registrationFrame);
      const b = framed.contentBounds;
      lines.push(`--- ${label} (reference) ---`);
      lines.push(`  size ${raw.width}x${raw.height}  source=${framed.contentBoundsSource}`
        + `  usable=${hasUsableFormBounds(framed)}`);
      if (b) {
        lines.push(`  contentBounds [${(b.left / framed.width).toFixed(3)},${(b.top / framed.height).toFixed(3)}`
          + ` ${((b.right - b.left) / framed.width).toFixed(3)}x${((b.bottom - b.top) / framed.height).toFixed(3)}]`);
      }
    }

    const text = lines.join('\n');
    // eslint-disable-next-line no-console
    console.log(text);
    fs.writeFileSync(OUT, text, 'utf8');
  }, 600_000);
});
