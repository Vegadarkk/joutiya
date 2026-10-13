// Static security headers for every response (architecture §6, "En-têtes" row).
// The page CSP and COOP depend on the route and host: src/proxy.ts sets them.
// Imported by next.config.ts: keep it free of env access and server-only imports.

export interface Header {
  key: string;
  value: string;
}

export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "publickey-credentials-get=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

export function staticSecurityHeaders(): Header[] {
  return [
    // Two years, subdomains included, eligible for the browser preload list.
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
  ];
}

/** JSON API responses never render HTML: deny everything. */
export const apiContentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** COOP: Google sign-in popups need `same-origin-allow-popups` on the public host (§6). */
export function coopFor(host: "public" | "admin"): string {
  return host === "admin" ? "same-origin" : "same-origin-allow-popups";
}
