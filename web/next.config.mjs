const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH || "/peekremote";
const basePath =
  configuredBasePath && configuredBasePath !== "/"
    ? `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`
    : undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Export estático: gera web/out, servido pelo backend FastAPI.
  output: "export",
  basePath,
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
