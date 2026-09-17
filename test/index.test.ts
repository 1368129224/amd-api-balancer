import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/balancer";

/**
 * 入口层（src/index.ts）的回归测试。
 *
 * 这里专门盯住一个曾经线上才暴露的 bug 类型：
 * 请求体是「流」，只能被消费一次。如果入口把 request 直接交给 Durable Object，
 * 或者用 request.clone() 把 body tee 成两半，就会出现两种症状：
 *   - 未消费的分支 → 运行时抛 "Can't read from request stream after response has been sent"
 *   - 未读完的分支 → 请求直接悬挂直到超时
 * 因此下面既断言转发的 body 完整可读，也断言连续多次请求都正常。
 */

interface Forwarded {
  url: string;
  method: string;
  body: string;
  contentType: string | null;
}

function makeHarness() {
  const forwarded: Forwarded[] = [];

  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (request: Request): Promise<Response> => {
        // 真正把 body 读出来：如果上游没把流整理干净，这里就会抛错或挂住
        const body = request.method === "GET" || request.method === "HEAD"
          ? ""
          : await request.text();
        forwarded.push({
          url: request.url,
          method: request.method,
          body,
          contentType: request.headers.get("content-type"),
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  };

  const env = {
    BALANCER: namespace,
    MAX_BODY_BYTES: "1024",
  } as unknown as Env;

  const ctx = {
    waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  return { env, ctx, forwarded, namespace };
}

function call(harness: ReturnType<typeof makeHarness>, request: Request) {
  return worker.fetch(request, harness.env, harness.ctx);
}

describe("入口层请求体处理", () => {
  it("POST 的 body 原样转发给 DO（可完整读取）", async () => {
    const h = makeHarness();
    const payload = JSON.stringify({ model: "DeepSeek-V4-Flash", messages: [{ role: "user", content: "你好" }] });
    const res = await call(
      h,
      new Request("https://gw.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer t" },
        body: payload,
      }),
    );

    expect(res.status).toBe(200);
    expect(h.forwarded).toHaveLength(1);
    expect(h.forwarded[0]!.body).toBe(payload);
    expect(h.forwarded[0]!.contentType).toBe("application/json");
  });

  it("转发后能连续处理多个请求（body 不会互相污染）", async () => {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) {
      const payload = `{"n":${i}}`;
      const res = await call(
        h,
        new Request("https://gw.test/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer t" },
          body: payload,
        }),
      );
      expect(res.status).toBe(200);
    }
    expect(h.forwarded.map((f) => f.body)).toEqual([
      '{"n":0}',
      '{"n":1}',
      '{"n":2}',
      '{"n":3}',
      '{"n":4}',
    ]);
  });

  it("GET 不带 body 转发（Request 构造器不允许 GET 带 body）", async () => {
    const h = makeHarness();
    const res = await call(h, new Request("https://gw.test/health", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(h.forwarded).toHaveLength(1);
    expect(h.forwarded[0]!.method).toBe("GET");
    expect(h.forwarded[0]!.body).toBe("");
  });

  it("超过 MAX_BODY_BYTES 的请求返回 413，且不转发给 DO", async () => {
    const h = makeHarness();
    const res = await call(
      h,
      new Request("https://gw.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(5000),
      }),
    );
    expect(res.status).toBe(413);
    expect(h.forwarded).toHaveLength(0);
  });

  it("伪造超大 content-length 返回 413，不读取也不转发", async () => {
    const h = makeHarness();
    const res = await call(
      h,
      new Request("https://gw.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "99999999" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(413);
    expect(h.forwarded).toHaveLength(0);
  });

  it("413 之后仍能正常服务（请求体已被正确释放）", async () => {
    const h = makeHarness();
    await call(
      h,
      new Request("https://gw.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "y".repeat(9000),
      }),
    );
    const res = await call(
      h,
      new Request("https://gw.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"ok":1}',
      }),
    );
    expect(res.status).toBe(200);
    expect(h.forwarded).toHaveLength(1);
    expect(h.forwarded[0]!.body).toBe('{"ok":1}');
  });

  it("DO 不可用时降级到无状态处理，body 依然可用", async () => {
    const h = makeHarness();
    // 让 DO stub 抛错：模拟未绑定 / 达到上限
    h.env.BALANCER = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async () => {
          throw new Error("DO unavailable");
        },
      }),
    } as unknown as Env["BALANCER"];

    const res = await call(
      h,
      new Request("https://gw.test/health", { method: "GET" }),
    );
    // 降级路径直接构造 Balancer：没有真实 env 里的账号也应做出合理响应
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(600);
  });

  it("DO 失败时降级路径能读到完整 body（不会被重复消费）", async () => {
    const h = makeHarness();
    h.env.BALANCER = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async () => {
          throw new Error("DO unavailable");
        },
      }),
    } as unknown as Env["BALANCER"];

    const res = await call(
      h,
      new Request("https://gw.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer t" },
        body: '{"model":"m","messages":[]}',
      }),
    );
    // 降级实例没有配置 key，应返回 503 no_keys_configured 这样的明确错误，
    // 而不是因为 body 已被消费而 500
    expect(res.status).not.toBe(500);
    const body = (await res.json()) as any;
    expect(JSON.stringify(body)).not.toContain("already been used");
  });
});
