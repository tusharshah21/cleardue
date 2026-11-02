import type { NextConfig } from "next";

// Cache Components is off: every page here is per-user, DB-backed and request-time.
const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
