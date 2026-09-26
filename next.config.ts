import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    // A checkout page is the live state of a hold. `no-store` keeps it out of every cache,
    // including the browser's back/forward cache, so Back can't show a stale Pay button.
    return [
      { source: "/checkout/:id", headers: [{ key: "Cache-Control", value: "no-store" }] },
      { source: "/m/checkout/:id", headers: [{ key: "Cache-Control", value: "no-store" }] },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
