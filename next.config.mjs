// The review batch is now cached in the browser -- values in localStorage and
// scanned pages in IndexedDB -- so anything that manages to run script on this
// origin could read a whole class's responses, not just the student on screen.
// `connect-src` is the directive that matters here: it does not stop injected
// script, it stops that script from shipping what it read anywhere we did not
// name. The rest closes the usual side doors.
//
// 'unsafe-inline' stays for now: Next.js emits inline hydration scripts and
// layout.tsx imports pdf.js from an inline module. Removing it needs a nonce
// middleware and a rework of that import, which is a separate change.
//
// Third-party origins in use: pdf.js from cdnjs (its worker is fetched and run
// as a blob), its WASM decoders from unpkg, and OpenCV from docs.opencv.org,
// which is loaded both as a script tag and via importScripts inside a worker.
// `data:` appears in connect-src because the review screen re-fetches its own
// crop data URIs to build blob links.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // 'unsafe-eval' is not optional: opencv.js is an emscripten build that calls
  // eval while initializing, and with only 'wasm-unsafe-eval' the browser
  // reported "script-src <- eval", left `cv` undefined, and importScripts
  // failed inside the correction worker. Dropping it would disable the
  // document scanner. It does not weaken connect-src, which is what keeps an
  // injected script from shipping the cached batch anywhere.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com https://unpkg.com https://docs.opencv.org",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob: https://cdnjs.cloudflare.com https://unpkg.com https://docs.opencv.org",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // Nothing here needs a camera-adjacent API beyond the capture flow,
          // which uses getUserMedia on this origin only.
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), payment=(), usb=()' },
        ],
      },
    ];
  },
  // The recognition route compares submitted response cells against these
  // blank-form assets at runtime, and reads the committed English tesseract
  // model from the same directory instead of downloading it per cold start.
  // Keep them in the serverless trace rather than relying on test fixtures
  // being present in a deployment bundle.
  experimental: {
    outputFileTracingIncludes: {
      '/api/recognize': ['./src/lib/recognition/assets/**'],
    },
  },
  // sharp 라이브러리가 Next.js API Routes 내부에서 원활히 빌드되고 구동되도록 설정
  webpack: (config) => {
    config.externals.push({
      sharp: 'commonjs sharp',
    });
    return config;
  },
};

export default nextConfig;
