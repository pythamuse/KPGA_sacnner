#!/usr/bin/env node
/**
 * Reports sheet-level exposure (src/lib/recognition/sheetExposure.ts) for
 * every image in a directory, so the CENTRAL checkout can test whether a
 * sheet's unusability is forecastable at upload time (spec §12.3, unit W-B).
 *
 *   node scripts/report-sheet-exposure.cjs <dir-or-file> [options]
 *
 *   --form=cagi|satisfaction|auto   form type (default auto: classifyForm,
 *                                   which falls back to the filename)
 *   --json=<file>                   also write the JSON lines to a file
 *   --no-recurse                    do not descend into subdirectories
 *
 * OUTPUT — two streams on purpose:
 *   stdout  JSON Lines, one object per sheet plus a final summary object.
 *           `... > exposure.jsonl` gives a clean machine file.
 *   stderr  the same rows as an aligned human-readable table.
 *
 * WHAT THIS DOES NOT DO: judge anything. There are no labels here and this
 * script asks for none. It emits numbers; the accuracy question — do these
 * separate the productive sheets from the zero-yield ones — belongs to the
 * checkout that holds local-scans/answer-key.json, and the answer is only
 * believable against a SHUFFLED-LABEL CONTROL. Spec F3.4 is why: gridFields
 * and pageInkRatio both looked like signals and came back at chance, one of
 * them pointing the wrong way. Suggested procedure once this has run:
 *
 *   1. label each sheet productive / zero-yield from the answer key;
 *   2. take the best single cut of offset82 and score it;
 *   3. shuffle the labels 500 times, score the best cut each time, take p95;
 *   4. only a real cut ABOVE that control is evidence of anything.
 *
 * Standalone Node rather than vitest, like scripts/check-orb-align.cjs: this
 * runs over directories of student photos that must never enter a test
 * fixture, and it is a reporting tool, not a pass/fail check.
 *
 * Bundling: esbuild puts the shipped TypeScript through as CJS so this
 * measures the code that ships rather than a copy of it. `sharp` stays
 * external because it is a native module.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(ROOT, '.tmp');
const ENTRY_PATH = path.join(BUNDLE_DIR, 'report-sheet-exposure.entry.ts');
const BUNDLE_PATH = path.join(BUNDLE_DIR, 'report-sheet-exposure.bundle.cjs');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function parseArgs(argv) {
  const options = { target: null, form: 'auto', json: null, recurse: true };

  for (const arg of argv) {
    if (arg === '--no-recurse') {
      options.recurse = false;
    } else if (arg.startsWith('--form=')) {
      options.form = arg.slice('--form='.length);
    } else if (arg.startsWith('--json=')) {
      options.json = path.resolve(arg.slice('--json='.length));
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.target === null) {
      // Resolved before the chdir below, so a relative path still means what
      // the caller typed.
      options.target = path.resolve(arg);
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  if (!options.target) {
    throw new Error('Usage: node scripts/report-sheet-exposure.cjs <dir-or-file> [--form=cagi|satisfaction|auto] [--json=<file>] [--no-recurse]');
  }
  if (!fs.existsSync(options.target)) {
    throw new Error(`No such file or directory: ${options.target}`);
  }
  if (!['auto', 'cagi', 'satisfaction'].includes(options.form)) {
    throw new Error(`--form must be auto, cagi or satisfaction (got "${options.form}")`);
  }

  return options;
}

/** Bundles the shipped modules for Node and requires them. */
function loadRecognition() {
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  fs.writeFileSync(ENTRY_PATH, [
    "export { measureSheetExposureForImage } from '../src/lib/recognition/sheetExposure';",
    "export { applyTemplateRegistrationFrame, loadImageAnalysisData } from '../src/lib/recognition/markDensity';",
    "export { getTemplate } from '../src/lib/recognition/roiTemplates';",
    "export { classifyForm } from '../src/lib/recognition/classifyForm';",
    '',
  ].join('\n'), 'utf8');

  execSync(
    `npx esbuild "${ENTRY_PATH.replace(/\\/g, '/')}" --bundle --platform=node `
    + `--format=cjs --external:sharp --outfile="${BUNDLE_PATH.replace(/\\/g, '/')}"`,
    { cwd: ROOT, stdio: 'pipe' },
  );
  return require(BUNDLE_PATH);
}

function collectImages(target, recurse) {
  if (fs.statSync(target).isFile()) {
    return [target];
  }

  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recurse) walk(full);
      } else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(full);
      }
    }
  };
  walk(target);

  // Natural order, so p2 lands before p10 and the rows line up with the
  // student numbering someone will be reading them against.
  return found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function pad(value, width) {
  return String(value).padStart(width);
}

function padName(value, width) {
  return String(value).length >= width ? String(value) : String(value).padEnd(width);
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const recognition = loadRecognition();
  const files = collectImages(options.target, options.recurse);
  const baseDir = fs.statSync(options.target).isFile()
    ? path.dirname(options.target)
    : options.target;

  // The blank baseline loader resolves its asset from process.cwd(); run from
  // the repository root whatever directory the caller invoked this from.
  process.chdir(ROOT);

  const jsonLines = [];
  const emit = (record) => {
    const line = JSON.stringify(record);
    jsonLines.push(line);
    process.stdout.write(`${line}\n`);
  };

  process.stderr.write(`sheet exposure — ${files.length} image(s) under ${options.target}\n`);
  process.stderr.write(
    `${padName('file', 40)} ${padName('form', 13)} ${pad('off82', 6)} ${pad('off95', 6)} `
    + `${pad('a82', 4)} ${pad('b82', 4)} ${pad('a95', 4)} ${pad('b95', 4)} ${pad('range', 5)}  bounds\n`,
  );

  const offsets = [];
  let failures = 0;

  for (const file of files) {
    const relative = path.relative(baseDir, file).replace(/\\/g, '/');
    const startedAt = Date.now();
    try {
      const formType = options.form === 'auto'
        ? await recognition.classifyForm(file)
        : options.form;
      if (formType !== 'cagi' && formType !== 'satisfaction') {
        failures += 1;
        emit({ kind: 'error', file: relative, error: `unclassified form (${formType})` });
        process.stderr.write(`${padName(relative, 40)} ${padName(String(formType), 13)} -- unclassified, skipped\n`);
        continue;
      }

      const template = recognition.getTemplate(formType);
      const image = recognition.applyTemplateRegistrationFrame(
        await recognition.loadImageAnalysisData(file),
        template.registrationFrame,
      );
      const exposure = await recognition.measureSheetExposureForImage(image, formType);
      if (!exposure) {
        failures += 1;
        emit({ kind: 'error', file: relative, formType, error: 'blank baseline unavailable' });
        process.stderr.write(`${padName(relative, 40)} ${padName(formType, 13)} -- no blank baseline\n`);
        continue;
      }

      offsets.push(exposure.offset82);
      emit({
        kind: 'sheet',
        file: relative,
        formType,
        width: image.width,
        height: image.height,
        contentBoundsSource: image.contentBoundsSource ?? null,
        contentBoundsConfident: image.contentBoundsConfident,
        contentBoundsRejection: image.contentBoundsRejection ?? null,
        pageInkRatio: image.pageInkRatio ?? null,
        pageIsBinarySource: image.pageIsBinarySource ?? null,
        ...exposure,
        elapsedMs: Date.now() - startedAt,
      });
      process.stderr.write(
        `${padName(relative, 40)} ${padName(formType, 13)} ${pad(exposure.offset82, 6)} `
        + `${pad(exposure.offset95, 6)} ${pad(exposure.actualP82, 4)} ${pad(exposure.blankP82, 4)} `
        + `${pad(exposure.actualP95, 4)} ${pad(exposure.blankP95, 4)} ${pad(exposure.dynamicRange, 5)}  `
        + `${image.contentBoundsSource ?? 'none'}${image.contentBoundsConfident ? '' : '?'}\n`,
      );
    } catch (error) {
      failures += 1;
      emit({ kind: 'error', file: relative, error: String(error && error.message ? error.message : error) });
      process.stderr.write(`${padName(relative, 40)} ${padName('-', 13)} -- ${error && error.message}\n`);
    }
  }

  const sorted = [...offsets].sort((a, b) => a - b);
  const summary = {
    kind: 'summary',
    measured: offsets.length,
    failed: failures,
    offset82: {
      min: sorted.length ? sorted[0] : null,
      p50: quantile(sorted, 0.5),
      p82: quantile(sorted, 0.82),
      p95: quantile(sorted, 0.95),
      max: sorted.length ? sorted[sorted.length - 1] : null,
    },
  };
  emit(summary);
  process.stderr.write(
    `\nmeasured ${summary.measured}, failed ${summary.failed}; `
    + `offset82 min=${summary.offset82.min} p50=${summary.offset82.p50} max=${summary.offset82.max}\n`,
  );
  process.stderr.write(
    'These are numbers, not a verdict. Compare them with the answer-key labels '
    + 'AND a 500-permutation shuffled-label control before any threshold is set '
    + '(spec F3.4).\n',
  );

  if (options.json) {
    fs.writeFileSync(options.json, `${jsonLines.join('\n')}\n`, 'utf8');
    process.stderr.write(`JSON lines written to ${options.json}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
