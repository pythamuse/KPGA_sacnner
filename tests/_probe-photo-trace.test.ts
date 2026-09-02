import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * The photo-directory twin of _probe-tracedump: runs the PHOTO path (provenance
 * flags on, as the product arms them from stored F1 meta) over two directories
 * of already-warped sheets and dumps the raw decision trace per group, joined to
 * the answer key. Same row shape as the scan dump so every analysis script that
 * reads trace-set*.jsonl reads this unchanged.
 *
 * Built for CAPTURE_GUIDANCE §17 cycle 1: seven photo wrongs are all
 * `cagi.q01 -> "3"`, and the trace is where the mechanism will be visible.
 *
 *   PHOTO_CAGI_DIR=.. PHOTO_SAT_DIR=.. SET=p1 OUT=..jsonl \
 *     npx vitest run tests/_probe-photo-trace.test.ts
 */

const CAGI_DIR = process.env.PHOTO_CAGI_DIR;
const SAT_DIR = process.env.PHOTO_SAT_DIR;
const OUT = process.env.OUT;
const SET = process.env.SET || 'photo';
const KEY_PATH = process.env.REAL_SCAN_ANSWER_KEY
  || path.join(process.cwd(), 'local-scans', 'answer-key.json');

// Numeric sort: a lexicographic one scores p10 against key row 2 (§8 lesson).
const listImages = (dir: string) => fs.readdirSync(dir)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort((a, b) => Number(/([0-9]+)/.exec(a)?.[1] ?? 0) - Number(/([0-9]+)/.exec(b)?.[1] ?? 0));

function parseTrace(line: string) {
  const field = /field=([\w.]+)/.exec(line)?.[1];
  const outcome = /outcome=(\w+)/.exec(line)?.[1];
  if (!field || !outcome) return null;
  return { field, outcome, line };
}

const ready = CAGI_DIR && SAT_DIR && OUT && fs.existsSync(KEY_PATH);
const run = ready ? describe : describe.skip;

run('photo trace dump', () => {
  it('dumps every group with its raw decision trace, joined to the key', async () => {
    const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as { pages: Array<Record<string, unknown>> };
    const cagi = listImages(CAGI_DIR!).map((f) => path.join(CAGI_DIR!, f));
    const sat = listImages(SAT_DIR!).map((f) => path.join(SAT_DIR!, f));
    const rows: unknown[] = [];
    const realInfo = console.info;

    for (let i = 0; i < Math.min(cagi.length, sat.length); i += 1) {
      const page = i + 1;
      const keyRow = key.pages.find((p) => Number(p.page) === page) ?? {};
      const lines: string[] = [];
      console.info = (...args: unknown[]) => { lines.push(String(args[0])); };
      process.env.MARK_DECISION_TRACE = '1';
      let draft: Record<string, unknown> = {};
      try {
        draft = (await recognizeStudentForms(cagi[i], sat[i], {
          cagiPhotoProvenance: true,
          satisfactionPhotoProvenance: true,
        })) as unknown as Record<string, unknown>;
      } catch (e) {
        console.info = realInfo;
        realInfo(`p${page} threw: ${String(e).slice(0, 120)}`);
        continue;
      } finally {
        delete process.env.MARK_DECISION_TRACE;
        console.info = realInfo;
      }

      const byField = new Map<string, ReturnType<typeof parseTrace>>();
      for (const line of lines) {
        const t = parseTrace(line);
        if (!t) continue;
        const prev = byField.get(t.field);
        if (!prev || t.outcome !== 'low') byField.set(t.field, t);
      }

      const d = draft as Record<string, Record<string, unknown>>;
      const source = (draft.recognitionValueSource || {}) as Record<string, string>;
      const values: Record<string, unknown> = {
        'basic.age': d.basic?.age,
        'basic.gender': d.basic?.gender,
        'basic.schoolType': d.basic?.schoolType,
        'basic.grade': d.basic?.grade,
        ...Object.fromEntries(Object.entries(d.cagi || {}).map(([k, v]) => [`cagi.${k}`, v])),
        ...Object.fromEntries(Object.entries(d.satisfaction || {}).map(([k, v]) => [`satisfaction.${k}`, v])),
      };

      for (const [field, t] of Array.from(byField.entries())) {
        if (!t) continue;
        const raw = values[field];
        // only an 'auto' value counts as got, matching the accuracy probe
        const got = source[field] === 'auto' && raw !== undefined && raw !== null && raw !== '' ? raw : null;
        const want = keyRow[field];
        rows.push({
          set: SET,
          page,
          field,
          outcome: t.outcome,
          valueSource: source[field] ?? null,
          want: want === undefined ? null : want,
          got,
          keyHasNull: Object.prototype.hasOwnProperty.call(keyRow, field) && keyRow[field] === null,
          trace: t.line,
        });
      }
      realInfo(`${SET} p${page} groups=${byField.size}`);
    }

    fs.writeFileSync(OUT!, rows.map((r) => JSON.stringify(r)).join('\n'));
    realInfo(`wrote ${rows.length} rows -> ${OUT}`);
  }, 1_800_000);
});
