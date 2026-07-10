/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained production server under .next/standalone (server.js +
  // traced node_modules) so the app can be shipped as a portable bundle that
  // runs with a bundled Node.exe and no `npm install` on the target machine.
  output: "standalone",
  // better-sqlite3 is a native (.node) addon: keep it external so it is copied
  // as-is into the standalone output instead of being bundled by the compiler.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
