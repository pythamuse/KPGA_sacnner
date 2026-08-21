import { describe, it } from 'vitest';
import path from 'path';
import { loadImageAnalysisData } from '../src/lib/recognition/markDensity';

describe('blank form content bounds', () => {
  it('reports the reference envelope both templates are calibrated to', async () => {
    const out: string[] = ['===== BLANK BOUNDS ====='];
    for (const name of ['cagi-blank.png', 'satisfaction-blank.png']) {
      const file = path.join(process.cwd(), 'src/lib/recognition/assets', name);
      const img = await loadImageAnalysisData(file);
      const b = img.contentBounds;
      out.push(`${name.padEnd(24)} page ${img.width}x${img.height}  bounds L=${b?.left} T=${b?.top} W=${b ? b.right - b.left : -1} H=${b ? b.bottom - b.top : -1}  src=${img.contentBoundsSource}`);
    }
    out.push('=====END=====');
    console.log(out.join(String.fromCharCode(10)));
  }, 120000);
});
