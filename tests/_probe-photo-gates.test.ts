import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * Flattening took the photo path from WRONG 13 to WRONG 0, but the correct
 * count fell from 8 to 1 -- the gate now refuses nearly everything. Refusing
 * more is not an improvement, it is the reviewer doing the work by hand. This
 * asks *which* of the four conjunction terms is doing the refusing, on the same
 * student before and after, so the next move is aimed rather than guessed.
 */

const CAGI = process.env.GATE_CAGI;
const SAT = process.env.GATE_SAT;
const FIELDS = (process.env.GATE_FIELDS || 'cagi.q01,cagi.q02,cagi.q03,basic.age,basic.gender').split(',');
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'photo-gates.txt');

describe.skipIf(!CAGI || !SAT)('photo gate probe', () => {
  it('dumps the gate terms for selected fields', async () => {
    const captured: string[] = [];
    const realInfo = console.info;
    console.info = (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === 'string' && first.startsWith('[marks ')) { captured.push(first); return; }
      (realInfo as (...a: unknown[]) => void)(...args);
    };
    try {
      await recognizeStudentForms(CAGI!, SAT!);
    } finally {
      console.info = realInfo;
    }

    const lines: string[] = [`======== GATES: ${path.basename(CAGI!)} ========`];
    for (const trace of captured) {
      const field = /field=([\w.]+)/.exec(trace)?.[1];
      if (!field || !FIELDS.includes(field)) continue;
      lines.push(trace);
      lines.push('');
    }
    const text = lines.join('\n');
    // eslint-disable-next-line no-console
    console.log(text);
    fs.writeFileSync(OUT, text, 'utf8');
  }, 900_000);
});
