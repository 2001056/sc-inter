import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 개발 서버가 `/ws` 와 `/healthz` 를 넘겨줄 API 주소.
 * 운영에서는 app/api 한 프로세스가 정적 파일과 WebSocket 을 같은 origin 으로 서빙하므로
 * 이 프록시는 개발 중에만 쓰인다.
 */
const API_TARGET = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      "/ws": { target: API_TARGET.replace(/^http/, "ws"), ws: true },
      "/healthz": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
  },
});
