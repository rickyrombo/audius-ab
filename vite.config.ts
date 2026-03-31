import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
  ],
  server: {
    proxy: {
      "/api/phoenix": {
        target: "https://api.phoenix.rickyrombo.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/phoenix/, ""),
      },
    },
  },
});
