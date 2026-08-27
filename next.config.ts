import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // node-ssh (and its ssh2 dependency) are Node-only libraries — keep them
  // out of the bundler so the scan Route Handler can use Node's net module.
  serverExternalPackages: ["node-ssh", "ssh2"],
};

export default nextConfig;
