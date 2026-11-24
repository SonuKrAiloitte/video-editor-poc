import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // ffmpeg.wasm spawns its own worker; pre-bundling breaks the worker URL
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "@twick/ffmpeg-web"] },
  server: {
    proxy: {
      "/api": "http://localhost:5181",
      "/out": "http://localhost:5181",
    },
  },
});
