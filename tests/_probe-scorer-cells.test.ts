import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * FIELD_TEST §34.7: the mark decision fails at the noise floor, because an
 * unmarked box keeps a residual of about 0.03 that a faint mark barely clears.
 * This dumps every candidate's raw measurements so the separation between
 * marked and unmarked cells can be read directly, and re-read under each
 * scorer variant.
 *
 * The variants are given from OUTSIDE -- this file sets no environment of its
 * own, so the same probe measures the baseline and every variant, and the row
 * it writes is whatever the scorer actually did.
 *
 *   CAGI_DIR=..\pages SAT_DIR=..\pages OUT=..\base.jsonl \
 *     npx vitest run tests/_probe-scorer-cells.test.ts
 *   MARK_BASELINE_DILATE=1 MARK_ALIGN_RADIUS=2 SET=dilate+r2 PHOTO=1 NO_PROVENANCE=1 \
 *     CAGI_DIR=..\pages SAT_DIR=..\pages OUT=..\variant.jsonl \
 *     npx vitest run tests/_probe-scorer-cells.test.ts
 *
 * No answer key is read here: the delegator joins these rows to the key it
 * holds. The image directories are paths in, never content this file keeps.
 */

const SET = process.env.SET || '?';
const OUT = process.env.OUT;
// Photo provenance changes the tone map and the binary refusal, so it is a
// property of the input, not of the probe. NO_PROVENANCE=1 keeps the scan
// class for directories that hold rendered scan pages rather than photographs
// -- the same pairing `_probe-bounds-gate` uses.
const PHOTO = Boolean(process.env.PHOTO);
const PROVENANCE = PHOTO && !process.env.NO_PROVENANCE;

const listImages = (dir: string) => fs.readdirSync(dir)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort((a, b) => Number(/([0-9]+)/.exec(a)?.[1] ?? 0) - Number(/([0-9]+)/.exec(b)?.[1] ?? 0))
  .map((f) => path.join(dir, f));

interface MeasuredCandidate {
  candidateIndex?: number;
  candidateValue?: unknown;
  score?: number;
  actualInk?: number | null;
  baselineInk?: number | null;
  alignX?: number | null;
  alignY?: number | null;
  largestComponentSize?: number | null;
  largestComponentRatio?: number | null;
  autoFilled?: boolean;
}

const ready = Boolean(OUT && process.env.CAGI_DIR && process.env.SAT_DIR);
const run = ready ? describe : describe.skip;

run('scorer cell probe', () => {
  it('dumps every candidate measurement the scorer produced', async () => {
    const cagi = listImages(process.env.CAGI_DIR!);
    const sat = listImages(process.env.SAT_DIR!);
    const rows: unknown[] = [];

    for (let i = 0; i < Math.min(cagi.length, sat.length); i += 1) {
      const draft = (await recognizeStudentForms(cagi[i], sat[i], {
        cagiPhotoProvenance: PROVENANCE,
        satisfactionPhotoProvenance: PROVENANCE,
      })) as unknown as Record<string, unknown>;
      const measured = (draft.recognitionMeasurements || {}) as Record<string, MeasuredCandidate[]>;
      let cells = 0;
      for (const [field, candidates] of Object.entries(measured)) {
        for (const candidate of candidates) {
          rows.push({
            set: SET,
            page: i + 1,
            field,
            candidateIndex: candidate.candidateIndex ?? null,
            candidateValue: candidate.candidateValue ?? null,
            score: candidate.score ?? null,
            actualInk: candidate.actualInk ?? null,
            baselineInk: candidate.baselineInk ?? null,
            alignX: candidate.alignX ?? null,
            alignY: candidate.alignY ?? null,
            largestComponentSize: candidate.largestComponentSize ?? null,
            largestComponentRatio: candidate.largestComponentRatio ?? null,
            autoFilled: candidate.autoFilled ?? false,
          });
          cells += 1;
        }
      }
      console.info(`${SET} p${i + 1} fields=${Object.keys(measured).length} candidates=${cells}`);
    }

    fs.writeFileSync(OUT!, rows.map((r) => JSON.stringify(r)).join('\n'));
    console.info(`wrote ${rows.length} rows -> ${OUT}`);
  }, 1_800_000);
});
