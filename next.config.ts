import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      // Framing is denied unless one embedding origin is configured (Hugging Face Spaces); then only that origin may frame the app.
      process.env.AEC_EMBED_ORIGIN ? { key: "Content-Security-Policy", value: `frame-ancestors 'self' ${process.env.AEC_EMBED_ORIGIN}` } : { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }, { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ...(process.env.AEC_PUBLIC === "1" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
    ] }];
  },
};
export default nextConfig;
