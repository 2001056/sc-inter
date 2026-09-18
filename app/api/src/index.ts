/** 진입점. PORT/HOST 환경변수를 읽고 graceful shutdown 을 건다. */
import { createApp } from "./server.ts";

const PORT = Number.parseInt(process.env["PORT"] ?? "8787", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";
const SHUTDOWN_TIMEOUT_MS = 5_000;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[sc-inter] PORT 값이 올바르지 않습니다: ${process.env["PORT"]}`);
  process.exit(1);
}

const app = createApp();

app.http.listen(PORT, HOST, () => {
  console.log(`[sc-inter] http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`[sc-inter] WebSocket /ws · health /healthz`);
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[sc-inter] ${signal} 수신, 종료를 시작합니다.`);
  const timer = setTimeout(() => {
    console.warn("[sc-inter] 정상 종료가 지연되어 강제로 닫습니다.");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try {
    await app.close();
    console.log("[sc-inter] 정상 종료했습니다.");
    process.exit(0);
  } catch (err) {
    console.error("[sc-inter] 종료 중 오류", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
