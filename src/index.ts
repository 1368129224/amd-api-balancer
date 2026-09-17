import { Balancer, json, type Env } from "./balancer";
import { readConfig } from "./config";

export { Balancer };
export type { Env };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 先把请求体完整读出来，再用它重建一个 Request 转发给 Durable Object。
    //
    // 为什么不直接把 request 交给 DO：body 是一条流，交给 DO 后外层 Worker 这条流
    // 不会被消费，运行时会报 "Can't read from request stream after response has been
    // sent"（表现为请求偶发 500）。为什么不 request.clone()：clone 会把 body tee 成
    // 两个分支，只要其中一个分支没被读完且没取消，请求就会悬挂直到超时。
    // 读成 ArrayBuffer 后外层流已彻底消费，DO 拿到的是一个全新的、完整的请求。
    let body: ArrayBuffer | undefined;
    try {
      body = await readRequestBody(request, readConfig(env).maxBodyBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return json(
          { error: { message: err.message, type: "invalid_request_error", code: "payload_too_large" } },
          413,
        );
      }
      return json(
        {
          error: {
            message: `无法读取请求体：${err instanceof Error ? err.message : String(err)}`,
            type: "invalid_request_error",
            code: "invalid_body",
          },
        },
        400,
      );
    }

    try {
      const stub = env.BALANCER.get(env.BALANCER.idFromName("default"));
      return await stub.fetch(rebuildRequest(request, body));
    } catch (err) {
      // Durable Object 不可用（未绑定 / 已达上限）时退化为无状态单实例处理。
      // 注意：此时 env.BALANCER 可能也是不可用的，所以直接构造实例。
      const message = err instanceof Error ? err.message : String(err);
      try {
        return await new Balancer().fetch(rebuildRequest(request, body), env, ctx);
      } catch (inner) {
        return json(
          {
            error: {
              message: `balancer 初始化失败：${message}；降级处理也失败：${String(inner)}`,
              type: "internal_error",
              code: "balancer_unavailable",
            },
          },
          500,
        );
      }
    }
  },

  /** Cron：定期刷新额度，让看板与调度始终有新鲜数据 */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = env.BALANCER.get(env.BALANCER.idFromName("default"));
    const request = new Request("https://internal/internal/refresh", {
      method: "POST",
      headers: { "x-balancer-internal": "1" },
    });
    ctx.waitUntil(
      stub.fetch(request).then(
        () => undefined,
        () => undefined,
      ),
    );
  },
};

/**
 * 读取请求体，同时强制大小上限。
 *
 * 必须先看 content-length（超大请求直接拒绝，不浪费带宽），
 * 再边读边累计字节数——因为 content-length 可以被伪造或缺失，
 * 而入口处一次性 arrayBuffer() 会让 MAX_BODY_BYTES 形同虚设。
 */
async function readRequestBody(request: Request, maxBytes: number): Promise<ArrayBuffer | undefined> {
  const method = request.method.toUpperCase();
  // 注意：GET/HEAD 按规范没有 body
  if (method === "GET" || method === "HEAD") return undefined;
  const stream = request.body;
  if (!stream) return undefined;

  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await stream.cancel().catch(() => undefined);
    throw new PayloadTooLargeError(maxBytes);
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

class PayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`请求体过大（> ${limit} 字节）`);
    this.name = "PayloadTooLargeError";
  }
}

/** 用已读出的 body 重建请求，保证可以安全地重复转发（DO 失败时还能降级重试） */
function rebuildRequest(request: Request, body: ArrayBuffer | undefined): Request {
  const method = request.method.toUpperCase();
  // 注意：Request 构造器对 GET/HEAD 带 body 会直接抛 TypeError
  const hasBody = body !== undefined && method !== "GET" && method !== "HEAD";
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? body : undefined,
    redirect: request.redirect,
  });
}
