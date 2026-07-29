/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // sharp 라이브러리가 Next.js API Routes 내부에서 원활히 빌드되고 구동되도록 설정
  webpack: (config) => {
    config.externals.push({
      sharp: 'commonjs sharp',
    });
    return config;
  },
};

export default nextConfig;
