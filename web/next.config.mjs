/** @type {import('next').NextConfig} */
const nextConfig = {
  // Export estático: gera web/out, servido pelo backend FastAPI.
  output: "export",
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
