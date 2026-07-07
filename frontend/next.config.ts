import type { NextConfig } from "next";

// The frontend talks to its own origin; Next proxies /api/* to the backend.
// Override with CLAUSE_BACKEND_URL if the backend runs elsewhere.
const backend = process.env.CLAUSE_BACKEND_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default nextConfig;
