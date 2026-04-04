import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@aac/ui"],
  serverExternalPackages: ["@resvg/resvg-js", "satori"],
};

export default nextConfig;
