import path from 'path';
import sharp from 'sharp';
import { loadImageAnalysisData } from '../src/lib/recognition/markDensity';
import { cagiTemplate, satisfactionTemplate } from '../src/lib/recognition/roiTemplates';

const DIR = path.join(process.cwd(), 'tests', 'fixtures', 'blank-form');
const OUT = process.env.AUDIT_OUT || path.join(process.cwd(), 'tmp', 'audit');
require('fs').mkdirSync(OUT, { recursive: true });

// Render, for every field, the exact strip the CURRENT template coordinates point at.
// A human/vision check of this sheet catches "right precision, wrong table" errors
// that a numeric tolerance check cannot express.
async function sheet(file: string, tmpl: typeof cagiTemplate, label: string, out: string) {
  const img = await loadImageAnalysisData(path.join(DIR, file));
  const b = img.contentBounds!;
  const W = b.right - b.left, H = b.bottom - b.top;

  const groups = tmpl.choiceGroups;
  const STRIP_W = 900, STRIP_H = 60, GAP = 4, LABEL_W = 190;
  const rows: Buffer[] = [];

  for (const g of groups) {
    const xs = g.candidates.map((c) => c.rect.x);
    const xe = g.candidates.map((c) => c.rect.x + c.rect.width);
    const ys = g.candidates.map((c) => c.rect.y);
    const ye = g.candidates.map((c) => c.rect.y + c.rect.height);
    // pad generously so surrounding context (which table is this?) is visible
    const left = Math.max(0, Math.round(b.left + (Math.min(...xs) - 0.06) * W));
    const right = Math.min(img.width, Math.round(b.left + (Math.max(...xe) + 0.02) * W));
    const top = Math.max(0, Math.round(b.top + (Math.min(...ys) - 0.012) * H));
    const bottom = Math.min(img.height, Math.round(b.top + (Math.max(...ye) + 0.012) * H));

    const crop = await sharp(path.join(DIR, file))
      .extract({ left, top, width: Math.max(2, right - left), height: Math.max(2, bottom - top) })
      .resize({ width: STRIP_W - LABEL_W, height: STRIP_H, fit: 'contain', background: '#fff' })
      .toBuffer();

    const labelSvg = Buffer.from(
      `<svg width="${LABEL_W}" height="${STRIP_H}"><rect width="100%" height="100%" fill="#eee"/>` +
      `<text x="8" y="26" font-family="Arial" font-size="15" font-weight="700">${g.field}</text>` +
      `<text x="8" y="46" font-family="Arial" font-size="12" fill="#555">y=${Math.min(...ys).toFixed(3)}</text></svg>`,
    );
    const labelPng = await sharp(labelSvg).png().toBuffer();

    rows.push(await sharp({ create: { width: STRIP_W, height: STRIP_H, channels: 3, background: '#fff' } })
      .composite([{ input: labelPng, left: 0, top: 0 }, { input: crop, left: LABEL_W, top: 0 }])
      .png().toBuffer());
  }

  const totalH = rows.length * (STRIP_H + GAP);
  const canvas = sharp({ create: { width: STRIP_W, height: totalH, channels: 3, background: '#999' } });
  await canvas
    .composite(rows.map((r, i) => ({ input: r, left: 0, top: i * (STRIP_H + GAP) })))
    .png()
    .toFile(path.join(OUT, out));
  console.log(`${label}: ${rows.length} fields -> ${out}`);
}

async function main() {
  await sheet('cagi-blank.png', cagiTemplate, 'CAGI', 'audit-cagi.png');
  await sheet('satisfaction-blank.png', satisfactionTemplate, 'SATISFACTION', 'audit-satisfaction.png');
}

main().catch((e) => { console.error(e); process.exit(1); });
