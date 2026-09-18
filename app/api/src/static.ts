/** app/web 빌드 산출물을 같은 origin 으로 서빙한다. */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const WEB_ROOT = resolve(HERE, "../../web/dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".hdr": "image/vnd.radiance",
  ".ktx2": "image/ktx2",
  ".bin": "application/octet-stream",
  ".mp3": "audio/mpeg",
  ".webm": "video/webm",
};

function safeJoin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = join(root, clean);
  return full.startsWith(root) ? full : null;
}

/** 정적 파일을 응답했으면 true. SPA 라우트는 index.html 로 되돌린다. */
export function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const indexHtml = join(WEB_ROOT, "index.html");
  if (!existsSync(indexHtml)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("웹 빌드가 없습니다. `pnpm build` 를 먼저 실행하세요.");
    return true;
  }

  const target = safeJoin(WEB_ROOT, req.url ?? "/");
  let filePath = target;
  if (filePath === null || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = indexHtml;
  }

  const ext = extname(filePath);
  const headers: Record<string, string> = {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  };
  headers["cache-control"] =
    filePath === indexHtml ? "no-cache" : "public, max-age=31536000, immutable";

  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(filePath).pipe(res);
  return true;
}
