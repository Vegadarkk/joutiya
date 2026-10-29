import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { SAME_ORIGIN_RESOURCE_SOURCE, apiContentSecurityPolicy, sameOriginResourcePolicy, staticSecurityHeaders } from "./src/lib/security/headers.ts";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// One image serves staging and production (§2): no NEXT_PUBLIC_* may be frozen at build time.
// Next inlines them into server bundles as well, so the build refuses any such variable.
const frozen = Object.keys(process.env).filter((name) => name.startsWith("NEXT_PUBLIC_") && process.env[name]);
if (frozen.length > 0) {
  throw new Error(`NEXT_PUBLIC_* variables are not allowed (runtime configuration, src/lib/config): ${frozen.join(", ")}`);
}

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
  // The legal pages read their Markdown sources at render time, ISR regenerations included (phase 6, D11).
  outputFileTracingIncludes: { "/[locale]/legal/[page]": ["./src/content/legal/**/*.md"], "/[locale]/legal/[page]/[version]": ["./src/content/legal/**/*.md"] },
  // Native and runtime-resolved packages stay outside the server bundle (Sentry hooks Node modules).
  serverExternalPackages: ["@sentry/node", "pino", "firebase-admin"],
  // The sitemap index lives with its files under /sitemaps/ (design D16): one ISR route handler,
  // no metadata sitemap.ts (generateSitemaps runs at build and conflicts with this route).
  async rewrites() {
    return [{ source: "/sitemap.xml", destination: "/sitemaps/index.xml" }];
  },
  async headers() {
    return [
      { source: "/:path*", headers: staticSecurityHeaders() },
      { source: SAME_ORIGIN_RESOURCE_SOURCE, headers: [sameOriginResourcePolicy] },
      {
        source: "/api/:path*",
        headers: [{ key: "Content-Security-Policy", value: apiContentSecurityPolicy }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
