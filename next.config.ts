import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { staticSecurityHeaders, apiContentSecurityPolicy } from "./src/lib/security/headers.ts";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Cloudflare compresses at the edge; an uncompressed origin body lets the CSP hook hash
  // inline scripts (src/server/csp-hash-hook.ts).
  compress: false,
  reactStrictMode: true,
  typedRoutes: false,
  // Typecheck and lint run as separate CI steps.
  typescript: { ignoreBuildErrors: false },
  experimental: {
    // Integrity attributes on every script chunk: public ISR pages run under a hash-based CSP.
    sri: { algorithm: "sha256" },
    globalNotFound: true,
    // Regenerated ISR pages stay in memory (cacheMaxMemorySize, 50 MB): the container's file system
    // is read-only (§2) and the VM keeps no unique data.
    isrFlushToDisk: false,
  },
  images: {
    // Photos are served by R2 (media host), never optimized on the VM (§2).
    unoptimized: true,
  },
  async headers() {
    return [
      { source: "/:path*", headers: staticSecurityHeaders() },
      {
        source: "/api/:path*",
        headers: [{ key: "Content-Security-Policy", value: apiContentSecurityPolicy }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
