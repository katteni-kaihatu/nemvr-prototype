import type { IncomingMessage, ServerResponse } from "node:http";
import { IMAGE_UPLOAD_PATH, MAX_IMAGE_BYTES } from "@proto/protocol";
import type { ImageStore } from "./images.js";

const CORS_HEADERS = {
  // プロトタイプのため全オリジンを許可する (client は別ポートの dev server から接続する)
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** body を上限付きで読み込む。超過したら null を返す。 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const IMAGE_ID_PATH = new RegExp(`^${IMAGE_UPLOAD_PATH}/([0-9a-f-]{36})$`);

export function createHttpHandler(images: ImageStore) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "").split("?")[0] ?? "";

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // POST /images : 画像を登録して { id } を返す
    if (req.method === "POST" && path === IMAGE_UPLOAD_PATH) {
      const body = await readBody(req, MAX_IMAGE_BYTES);
      if (!body) {
        json(res, 413, { error: "画像が大きすぎます" });
        req.destroy();
        return;
      }
      const result = images.add(body);
      if ("error" in result) {
        if (result.error === "unsupported") {
          json(res, 415, { error: "対応していない画像形式です (PNG / JPEG / GIF / WebP)" });
        } else {
          json(res, 507, { error: "サーバーが保持できる画像の上限に達しました" });
        }
        return;
      }
      json(res, 201, { id: result.id });
      return;
    }

    // GET /images/:id : 画像本体
    const match = req.method === "GET" ? IMAGE_ID_PATH.exec(path) : null;
    if (match) {
      const image = images.get(match[1]!);
      if (!image) {
        json(res, 404, { error: "not found" });
        return;
      }
      res.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": image.type,
        "Content-Length": image.data.length,
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "cross-origin",
        // ID は UUID で内容は不変
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(image.data);
      return;
    }

    json(res, 404, { error: "not found" });
  };
}
