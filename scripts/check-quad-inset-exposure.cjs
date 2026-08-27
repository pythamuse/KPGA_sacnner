// Two review lenses disagreed about the live reading using two different
// SYNTHETIC composites (119 vs 163 for the same nominal case), and the
// disagreement turned on whether the quad's edge ring -- the paper/desk blend
// the downscale creates -- is inside the measured region. CLAUDE.md §2: do not
// judge on synthetics. Judge on the real photos.
//
// Shrink the detected quad toward its centroid by k px and re-measure. If the
// reading is dominated by illumination it barely moves; if it is dominated by
// the edge ring it collapses.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = process.env.KPGA_ROOT || 'C:/Users/night/Desktop/바이브코딩/도박예방';
const sharp = require(path.join(ROOT, 'node_modules', 'sharp'));
const { execSync } = require('child_process');
const SP = process.argv[2];
const TMP = path.join(os.tmpdir(), 'm5-preview-exposure');

const cv = require(path.join(os.tmpdir(), 'opencv-4.9.0.js'));
const detector = require(path.join(TMP, 'detect.cjs'));
const guidance = require(path.join(TMP, 'guidance.cjs'));

const LIVE = 480;
const ASPECT = 656 / 474;
const INSETS = [0, 1, 2, 3, 5, 8, 12];

function shrink(points, k) {
  const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
  const cy = points.reduce((a, p) => a + p.y, 0) / points.length;
  return points.map((p) => {
    const dx = p.x - cx; const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const f = Math.max(0, (len - k)) / len;
    return { x: cx + dx * f, y: cy + dy * f };
  });
}

(async () => {
  const start = Date.now();
  while (!cv.Mat && Date.now() - start < 30000) await new Promise((r) => setTimeout(r, 10));

  console.log('사각형을 중심 쪽으로 k px 줄여가며 dynamicRange 재측정 (실제 사진)');
  console.log('');
  console.log('사진             ' + INSETS.map((k) => `k=${k}`.padStart(6)).join('') + '   변동폭');
  const moves = [];
  for (const form of [{ d: 'set19/cagi', p: 'cagi' }, { d: 'set19/sat', p: 'sat' }]) {
    for (let s = 1; s <= 19; s++) {
      const f = path.join(SP, form.d, `${form.p}-p${s}.jpg`);
      if (!fs.existsSync(f)) continue;
      const meta = await sharp(f).metadata();
      const sc = LIVE / Math.max(meta.width, meta.height);
      const w = Math.round(meta.width * sc); const h = Math.round(meta.height * sc);
      const pv = await sharp(f).resize(w, h).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const rgba = new Uint8ClampedArray(pv.data);
      const mat = cv.matFromImageData({ data: rgba, width: w, height: h });
      let quad = null;
      try {
        const det = detector.detectDocumentQuadFromMat(cv, mat, w, h, ASPECT);
        quad = det && det.quality ? det.quality.points : null;
      } catch (e) { quad = null; }
      mat.delete();
      if (!quad) continue; // only quad-locked frames reach the reducer branch
      const vals = INSETS.map((k) => {
        const r = guidance.measureFrameExposureInRegion(rgba, w, h, shrink(quad, k));
        return r ? r.dynamicRange : -1;
      });
      const span = Math.max(...vals) - Math.min(...vals);
      moves.push({ name: `${form.p}-p${s}`, vals, span });
      console.log(`${(form.p + '-p' + s).padEnd(16)}` + vals.map((v) => String(v).padStart(6)).join('') + String(span).padStart(9));
    }
  }
  const spans = moves.map((m) => m.span).sort((a, b) => a - b);
  console.log('');
  console.log(`사각형 검출된 프레임 ${moves.length}개 · 안쪽 12px까지 줄였을 때 변동폭 중앙값 ${spans[Math.floor(spans.length / 2)]}, 최대 ${spans[spans.length - 1]}`);
  const anyAbove = moves.filter((m) => Math.max(...m.vals) >= guidance.LIVE_DYNAMIC_RANGE_WARN);
  console.log(`어느 inset 에서든 문턱 ${guidance.LIVE_DYNAMIC_RANGE_WARN} 을 넘는 프레임: ${anyAbove.length}/${moves.length}`);
})();
