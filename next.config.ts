import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // node-ssh (and its ssh2 dependency) are Node-only libraries — keep them
  // out of the bundler so the scan Route Handler can use Node's net module.
  // pdfkit likewise loads its standard-font AFM metrics from disk at runtime.
  serverExternalPackages: ["node-ssh", "ssh2", "pdfkit"],
};

export default nextConfig;
