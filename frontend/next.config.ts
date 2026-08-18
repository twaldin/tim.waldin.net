import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [
      {
        source: "/resume.html",
        destination: "/resume.pdf",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
