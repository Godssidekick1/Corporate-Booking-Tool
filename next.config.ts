import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This directory is the project root. Without it Turbopack infers the root
  // from the nearest lockfile it finds walking up, and C:\CBT holds a stray
  // package.json/package-lock.json of its own -- so it guessed the parent, and
  // resolved and watched files outside the repository.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
