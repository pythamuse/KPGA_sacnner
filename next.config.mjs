/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
