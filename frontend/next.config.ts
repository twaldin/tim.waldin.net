import type { NextConfig } from "next";

const contentSecurityPolicy = (frameAncestors: string) => [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // Safari < 16 does not match same-origin wss: against 'self'; name the host.
  "connect-src 'self' wss://tim.waldin.net",
  `frame-ancestors ${frameAncestors}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const permissionsPolicy = [
  "accelerometer=()",
  // Same-origin only: blog videos autoplay muted in the page and keep their fullscreen button.
  "autoplay=(self)",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=(self)",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ");

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];

    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy("'self'"),
          },
          {
            key: "Permissions-Policy",
            value: permissionsPolicy,
          },
        ],
      },
      // The X Player Card frames /x on desktop web. Exact path; the last
      // matching header wins, so this rule must stay after the global one.
      {
        source: "/x",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy(
              "'self' https://x.com https://*.x.com https://twitter.com https://*.twitter.com",
            ),
          },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/resume.html",
        destination: "/resume.pdf",
        permanent: true,
      },
      {
        source: "/projects/term-site",
        destination: "/projects/tim.waldin.net",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
