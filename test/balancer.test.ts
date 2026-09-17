import { beforeEach, describe, expect, it, vi } from "vitest";
import { Balancer, type Env } from "../src/balancer";

const API = "https://upstream.test/radeon/api";
const PLATFORM = "https://platform.test";

interface Call {
  url: string;
  method: string;
  account: string;
  body: string;
}

interface Step {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** 模拟 fetch 抛出网络错误 */
  networkError?: string;
  /** SSE 流式响应 */
  stream?: string[];
}

interface UpstreamOptions {
  /** key → 该 key 的响应队列；用完后重复最后一个 */
  plan?: Record<string, Step[]>;
  /** key → 平台额度接口返回的「剩余额度」，默认 10 */
  remainingUsd?: Record<string, number>;
}

/** 测试里大量读取 JSON 响应；集中做一次类型断言，避免每个断言都被 unknown 卡住 */
async function asJson(res: Response): Promise<any> {
  return (await res.json()) as any;
}

function makeEnv(accounts: string, extra: Record<string, unknown> = {}): Env {
  return {
    AMD_ACCOUNTS: accounts,
    AMD_API_BASE: API,
    AMD_PLATFORM_BASE: PLATFORM,
    ...extra,
  } as unknown as Env;
}

function installFetch(opts: UpstreamOptions, calls: Call[]) {
  const plan = opts.plan ?? {};
  const remainingUsd = opts.remainingUsd ?? {};
  const counters = new Map<string, number>();

  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") ?? headers.get("x-api-key") ?? "";
    const apiKey = auth.replace(/^Bearer\s+/i, "");
    const sentBody = init?.body == null ? "" : "<binary>";
    calls.push({ url, method: init?.method ?? "GET", account: apiKey, body: sentBody });

    // 额度接口（Platform API）
    if (url.includes("/api/profile/model-usage")) {
      const remaining = remainingUsd[apiKey] ?? 10;
      return new Response(
        JSON.stringify({
          status: "ok",
          rpm_limit: 30,
          daily_cost_limit_usd: 10,
          daily_cost_used_usd: 10 - remaining,
          daily_cost_remaining_usd: remaining,
          daily_reset_timezone: "Asia/Shanghai",
          daily_reset_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
          today: { requests: 1, errors: 0, total_tokens: 10, cost: 10 - remaining },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // /v1/models：给额度探测兜底模型用
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "DeepSeek-V4-Flash" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const queue = plan[apiKey];
    if (!queue || !queue.length) {
      throw new Error(`unexpected upstream call for key ${apiKey} → ${url}`);
    }
    const idx = Math.min(counters.get(apiKey) ?? 0, queue.length - 1);
    counters.set(apiKey, idx + 1);
    const step = queue[idx]!;

    if (step.networkError) throw new Error(step.networkError);

    if (step.stream) {
      const chunks = step.stream;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(stream, {
        status: step.status,
        headers: { "content-type": "text/event-stream", ...(step.headers ?? {}) },
      });
    }

    const text = typeof step.body === "string" ? step.body : JSON.stringify(step.body ?? { ok: true });
    return new Response(text, {
      status: step.status,
      headers: { "content-type": "application/json", ...(step.headers ?? {}) },
    });
  });

  vi.stubGlobal("fetch", fake);
  return fake;
}

const okBody = {
  id: "chatcmpl-1",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
};

const quotaHeaders = (remaining: number) => ({
  "x-ratelimit-limit-user-rpm": "30",
  "x-ratelimit-remaining-user-rpm": "25",
  "x-ratelimit-limit-user-daily-usd": "10",
  "x-ratelimit-used-user-daily-usd": String(10 - remaining),
  "x-ratelimit-remaining-user-daily-usd": String(remaining),
  "x-ratelimit-reset-user-daily-usd": String(Math.floor((Date.now() + 3600_000) / 1000)),
});

function makeCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}

const chatRequest = (body: Record<string, unknown> = {}) =>
  new Request("https://balancer.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "DeepSeek-V4-Flash",
      messages: [{ role: "user", content: "hi" }],
      ...body,
    }),
  });

describe("Balancer 代理与故障切换", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("正常请求：转发到上游并注入额度头", async () => {
    const calls: Call[] = [];
    installFetch({ plan: { "rc-key-a": [{ status: 200, body: okBody, headers: quotaHeaders(8) }] } }, calls);
    const balancer = new Balancer();

    const res = await balancer.fetch(
      chatRequest(),
      makeEnv(JSON.stringify([{ label: "a", apiKey: "rc-key-a" }])),
      makeCtx(),
    );

    expect(res.status).toBe(200);
    const payload = await asJson(res);
    expect(payload.id).toBe("chatcmpl-1");
    expect(res.headers.get("x-amd-account")).toBe("a");
    expect(res.headers.get("x-amd-quota-remaining-usd")).toBe("8");
    expect(res.headers.get("x-amd-quota-limit-usd")).toBe("10");
    expect(res.headers.get("x-amd-pool-accounts")).toBe("1");

    const chat = calls.find((c) => c.url.includes("/v1/chat/completions"));
    expect(chat?.account).toBe("rc-key-a");
    expect(chat?.url).toBe(`${API}/v1/chat/completions`);
  });

  it("首个 key 额度耗尽(429) → 自动切到第二个 key，客户端无感", async () => {
    const calls: Call[] = [];
    installFetch(
      {
        plan: {
          "rc-key-a": [
            {
              status: 429,
              body: {
                error: {
                  message: "Daily usage limit exceeded: maximum $10 per period",
                  code: "rate_limit_exceeded",
                },
              },
              headers: { "retry-after": "1800" },
            },
          ],
          "rc-key-b": [{ status: 200, body: okBody, headers: quotaHeaders(7) }],
        },
      },
      calls,
    );
    const balancer = new Balancer();

    const res = await balancer.fetch(
      chatRequest(),
      makeEnv(
        JSON.stringify([
          { label: "a", apiKey: "rc-key-a" },
          { label: "b", apiKey: "rc-key-b" },
        ]),
      ),
      makeCtx(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-amd-account")).toBe("b");
    expect(res.headers.get("x-amd-attempt")).toBe("2");
    // a 先被尝试并因额度耗尽失败，随后自动换到 b
    expect(calls.filter((c) => c.url.includes("/v1/chat/completions")).map((c) => c.account)).toEqual([
      "rc-key-a",
      "rc-key-b",
    ]);
  });

  it("第一个 key 401 被自动禁用，后续请求不再尝试它", async () => {
    const calls: Call[] = [];
    installFetch(
      {
        plan: {
          "rc-key-a": [{ status: 401, body: { error: { message: "invalid api key" } } }],
          "rc-key-b": [
            { status: 200, body: okBody, headers: quotaHeaders(9) },
            { status: 200, body: okBody, headers: quotaHeaders(8.9) },
          ],
        },
      },
      calls,
    );
    const balancer = new Balancer();
    const env = makeEnv(
      JSON.stringify([
        { label: "a", apiKey: "rc-key-a" },
        { label: "b", apiKey: "rc-key-b" },
      ]),
    );

    const first = await balancer.fetch(chatRequest(), env, makeCtx());
    expect(first.status).toBe(200);
    expect(first.headers.get("x-amd-account")).toBe("b");

    const second = await balancer.fetch(chatRequest(), env, makeCtx());
    expect(second.status).toBe(200);
    expect(second.headers.get("x-amd-account")).toBe("b");

    // key a 只被调用过一次，之后被自动禁用
    expect(calls.filter((c) => c.account === "rc-key-a")).toHaveLength(1);
  });

  it("剩余额度最多的账号优先被选中", async () => {
    const calls: Call[] = [];
    installFetch(
      {
        plan: {
          "rc-key-a": [{ status: 200, body: okBody, headers: quotaHeaders(1) }],
          "rc-key-b": [{ status: 200, body: okBody, headers: quotaHeaders(9) }],
        },
        remainingUsd: { "rc-key-a": 1, "rc-key-b": 9 },
      },
      calls,
    );
    const balancer = new Balancer();
    const env = makeEnv(
      JSON.stringify([
        { label: "a", apiKey: "rc-key-a" },
        { label: "b", apiKey: "rc-key-b" },
      ]),
    );

    await balancer.fetch(new Request("https://balancer.test/v1/quota?refresh=1"), env, makeCtx());
    const res = await balancer.fetch(chatRequest(), env, makeCtx());
    expect(res.headers.get("x-amd-account")).toBe("b");
    expect(res.headers.get("x-amd-pool-remaining-usd")).toBe("10");
  });

  it("所有 key 都进入冷却后返回 429 + Retry-After", async () => {
    const calls: Call[] = [];
    const exhausted = {
      status: 429,
      body: { error: { message: "Daily usage limit exceeded", code: "rate_limit_exceeded" } },
      headers: { "retry-after": "1800" },
    };
    installFetch(
      {
        plan: {
          "rc-key-aaaa1111": [exhausted],
          "rc-key-bbbb2222": [exhausted],
        },
      },
      calls,
    );
    const env = makeEnv(
      JSON.stringify([
        { label: "a", apiKey: "rc-key-aaaa1111" },
        { label: "b", apiKey: "rc-key-bbbb2222" },
      ]),
    );
    const balancer = new Balancer();

    // 第一次：两个 key 都被判定额度耗尽，进入长冷却
    const first = await balancer.fetch(chatRequest(), env, makeCtx());
    expect(first.status).toBe(429);

    // 第二次：池子里已没有可用账号
    const res = await balancer.fetch(chatRequest(), env, makeCtx());
    expect(res.status).toBe(429);
    const payload = await asJson(res);
    expect(payload.error.code).toBe("all_keys_unavailable");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(payload.balancer.accounts).toBe(2);
  });

  it("上游 5xx 全部失败时把最后一个错误回传给客户端", async () => {
    const calls: Call[] = [];
    installFetch(
      {
        plan: {
          "rc-key-aaaa1111": [{ status: 503, body: "upstream down" }],
          "rc-key-bbbb2222": [{ status: 502, body: "bad gateway" }],
        },
      },
      calls,
    );
    const env = makeEnv(
      JSON.stringify([
        { label: "a", apiKey: "rc-key-aaaa1111" },
        { label: "b", apiKey: "rc-key-bbbb2222" },
      ]),
    );

    const res = await new Balancer().fetch(chatRequest(), env, makeCtx());
    expect(res.status).toBe(502);
    expect(res.headers.get("x-amd-keys-tried")).toBe("2");
  });

  it("400 参数错误原样返回，不触发换 key", async () => {
    const calls: Call[] = [];
    installFetch(
      {
        plan: {
          "rc-key-a": [{ status: 400, body: { error: { message: "model is required" } } }],
          "rc-key-b": [{ status: 200, body: okBody }],
        },
      },
      calls,
    );
    const balancer = new Balancer();

    const res = await balancer.fetch(
      chatRequest(),
      makeEnv(
        JSON.stringify([
          { label: "a", apiKey: "rc-key-a" },
          { label: "b", apiKey: "rc-key-b" },
        ]),
      ),
      makeCtx(),
    );

    expect(res.status).toBe(400);
    expect(await asJson(res)).toMatchObject({ error: { message: "model is required" } });
    expect(calls.filter((c) => c.url.includes("/v1/chat/completions"))).toHaveLength(1);
  });

  it("流式 SSE 透传且带额度头", async () => {
    const calls: Call[] = [];
    installFetch(
      {
        plan: {
          "rc-key-a": [
            {
              status: 200,
              stream: ['data: {"choices":[{"delta":{"content":"he"}}]}\n\n', "data: [DONE]\n\n"],
              headers: quotaHeaders(6),
            },
          ],
        },
      },
      calls,
    );
    const balancer = new Balancer();

    const res = await balancer.fetch(
      chatRequest({ stream: true }),
      makeEnv(JSON.stringify([{ label: "a", apiKey: "rc-key-a" }])),
      makeCtx(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-amd-account")).toBe("a");

    const text = await res.text();
    expect(text).toContain("data: [DONE]");
    expect(text).toContain('"content":"he"');
  });

  it("网络异常视为可重试并切换 key", async () => {
    const calls: Call[] = [];
    installFetch(
      {
        plan: {
          "rc-key-a": [{ status: 0, networkError: "ECONNRESET" }],
          "rc-key-b": [{ status: 200, body: okBody, headers: quotaHeaders(5) }],
        },
      },
      calls,
    );
    const balancer = new Balancer();

    const res = await balancer.fetch(
      chatRequest(),
      makeEnv(
        JSON.stringify([
          { label: "a", apiKey: "rc-key-a" },
          { label: "b", apiKey: "rc-key-b" },
        ]),
      ),
      makeCtx(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-amd-account")).toBe("b");
  });

  it("Anthropic /v1/messages 走 x-api-key 且透传 anthropic-beta", async () => {
    const calls: Call[] = [];
    installFetch({ plan: { "rc-key-a": [{ status: 200, body: { content: [{ text: "hi" }] } }] } }, calls);
    const balancer = new Balancer();

    const res = await balancer.fetch(
      new Request("https://balancer.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-beta": "prompt-caching" },
        body: JSON.stringify({
          model: "some-model",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      makeEnv(JSON.stringify([{ label: "a", apiKey: "rc-key-a" }])),
      makeCtx(),
    );

    expect(res.status).toBe(200);
    const call = calls.find((c) => c.url.includes("/v1/messages"));
    expect(call?.url).toBe(`${API}/v1/messages`);
    expect(call?.account).toBe("rc-key-a");
  });
});

describe("Balancer 认证与路由", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installFetch({}, []);
  });

  it("配置 ACCESS_TOKEN 后未带 token 返回 401", async () => {
    const env = makeEnv(JSON.stringify([{ label: "a", apiKey: "rc-key-a" }]), {
      ACCESS_TOKEN: "sekret",
    });
    const res = await new Balancer().fetch(chatRequest(), env, makeCtx());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("带正确 token 放行", async () => {
    const calls: Call[] = [];
    installFetch({ plan: { "rc-key-a": [{ status: 200, body: okBody }] } }, calls);
    const env = makeEnv(JSON.stringify([{ label: "a", apiKey: "rc-key-a" }]), {
      ACCESS_TOKEN: "sekret",
    });
    const res = await new Balancer().fetch(
      new Request("https://balancer.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sekret" },
        body: JSON.stringify({ model: "m", messages: [] }),
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
  });

  it("未配置任何 key 时返回 503 且带引导信息", async () => {
    const res = await new Balancer().fetch(chatRequest(), makeEnv(""), makeCtx());
    expect(res.status).toBe(503);
    const payload = await asJson(res);
    expect(payload.error.code).toBe("no_keys_configured");
    expect(payload.error.message).toContain("AMD_ACCOUNTS");
  });

  it("不支持的端点返回 404 说明", async () => {
    const res = await new Balancer().fetch(
      new Request("https://balancer.test/v1/embeddings", { method: "POST", body: "{}" }),
      makeEnv(JSON.stringify([{ label: "a", apiKey: "rc-key-a" }])),
      makeCtx(),
    );
    expect(res.status).toBe(404);
    expect((await asJson(res)).error.code).toBe("endpoint_not_supported");
  });

  it("看板返回 HTML", async () => {
    const res = await new Balancer().fetch(
      new Request("https://balancer.test/dashboard"),
      makeEnv(""),
      makeCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("AMD AI Key Balancer");
  });

  it("/health 报告账号数", async () => {
    const res = await new Balancer().fetch(
      new Request("https://balancer.test/health"),
      makeEnv(
        JSON.stringify([
          { label: "a", apiKey: "rc-key-a" },
          { label: "b", apiKey: "rc-key-b" },
        ]),
      ),
      makeCtx(),
    );
    expect(await asJson(res)).toMatchObject({ status: "ok", accounts: 2, schedulable: 2 });
  });

  // 这一组测试针对一个真实踩过的坑：在 CF 面板把密钥加成明文 Variables，
  // 下一次部署（含 Git 集成自动构建）会把它覆盖掉，表现为 accounts: 0。
  // 以前没有任何办法区分「值没到 env」和「值到了但解析失败」。
  describe("/health 的环境变量诊断", () => {
    const health = async (env: Env) => {
      const res = await new Balancer().fetch(
        new Request("https://balancer.test/health"),
        env,
        makeCtx(),
      );
      return asJson(res);
    };

    it("值缺失时标记为 false（就是被 wrangler 覆盖后的样子）", async () => {
      const body = await health(makeEnv(""));
      expect(body.accounts).toBe(0);
      expect(body.auth_required).toBe(false);
      expect(body.env).toMatchObject({ AMD_ACCOUNTS: false, ACCESS_TOKEN: false });
    });

    it("值存在时标记为 true", async () => {
      const body = await health(
        makeEnv(JSON.stringify([{ label: "a", apiKey: "rc-key-a" }]), {
          ACCESS_TOKEN: "tok",
        }),
      );
      expect(body.env).toMatchObject({ AMD_ACCOUNTS: true, ACCESS_TOKEN: true });
      expect(body.auth_required).toBe(true);
    });

    it("有值但解析不出账号时给出 hint", async () => {
      // 非法 JSON 会被退化成按行解析，最终解析不出合法账号
      const body = await health(makeEnv("not json at all"));
      expect(body.accounts).toBe(0);
      expect(body.env.AMD_ACCOUNTS).toBe(true);
      expect(body.accountsHint).toContain("解析出 0 个账号");
    });

    it("绝不泄露任何密钥值", async () => {
      const secret = "rc-super-secret-value-do-not-leak";
      const body = await health(
        makeEnv(JSON.stringify([{ label: "a", apiKey: secret }]), {
          ACCESS_TOKEN: "access-secret-value",
          ADMIN_TOKEN: "admin-secret-value",
        }),
      );
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("access-secret-value");
      expect(serialized).not.toContain("admin-secret-value");
      // 诊断字段的值只允许是布尔
      for (const v of Object.values(body.env as Record<string, unknown>)) {
        expect(typeof v).toBe("boolean");
      }
    });
  });
});

describe("Balancer 额度接口", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("/v1/quota 聚合所有账号额度", async () => {
    const calls: Call[] = [];
    installFetch({}, calls);
    const env = makeEnv(
      JSON.stringify([
        { label: "a", apiKey: "rc-key-aaaaaaaa" },
        { label: "b", apiKey: "rc-key-bbbbbbbb" },
      ]),
    );

    const res = await new Balancer().fetch(new Request("https://balancer.test/v1/quota"), env, makeCtx());
    expect(res.status).toBe(200);
    const report = await asJson(res);
    expect(report.accounts).toHaveLength(2);
    expect(report.totals.accounts).toBe(2);
    expect(report.totals.schedulable).toBe(2);
    expect(report.totals.dailyUsdRemaining).toBeCloseTo(20, 5);
    expect(report.accounts[0].keyMasked).toMatch(/…/);
    expect(report.accounts[0].quota.dailyResetTimezone).toBe("Asia/Shanghai");
  });

  it("额度耗尽的账号不可调度", async () => {
    const calls: Call[] = [];
    installFetch(
      {
        plan: { "rc-key-empty000": [{ status: 200, body: okBody, headers: quotaHeaders(0) }] },
        remainingUsd: { "rc-key-empty000": 0 },
      },
      calls,
    );
    const env = makeEnv(
      JSON.stringify([
        { label: "empty", apiKey: "rc-key-empty000" },
        { label: "fresh", apiKey: "rc-key-fresh000" },
      ]),
    );
    const balancer = new Balancer();

    // 首次请求按 label 顺序落到 empty，响应头把它的剩余额度刷成 0
    const warm = await balancer.fetch(chatRequest(), env, makeCtx());
    expect(warm.status).toBe(200);
    expect(warm.headers.get("x-amd-account")).toBe("empty");
    expect(warm.headers.get("x-amd-quota-remaining-usd")).toBe("0");

    const report = await asJson(
      await balancer.fetch(new Request("https://balancer.test/v1/quota"), env, makeCtx()),
    );
    const empty = report.accounts.find((a: { label: string }) => a.label === "empty");
    expect(empty.quota.dailyUsdRemaining).toBe(0);
    expect(empty.schedulable).toBe(false);
    expect(empty.skipReason).toContain("额度");
  });
});

describe("Balancer 管理接口", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("未配置 ADMIN_TOKEN 时拒绝管理接口", async () => {
    installFetch({}, []);
    const res = await new Balancer().fetch(
      new Request("https://balancer.test/admin/config"),
      makeEnv(""),
      makeCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("带 ADMIN_TOKEN 可读取配置，且不泄漏密钥", async () => {
    installFetch({}, []);
    const env = makeEnv(JSON.stringify([{ label: "a", apiKey: "rc-secret-key" }]), {
      ACCESS_TOKEN: "user-token",
      ADMIN_TOKEN: "admin-token",
    });

    const res = await new Balancer().fetch(
      new Request("https://balancer.test/admin/config", {
        headers: { authorization: "Bearer admin-token" },
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
    const payload = await asJson(res);
    expect(payload.accessTokenSet).toBe(true);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("rc-secret-key");
    expect(serialized).not.toContain("admin-token");
  });

  it("普通 token 不能访问管理接口", async () => {
    installFetch({}, []);
    const env = makeEnv(JSON.stringify([{ label: "a", apiKey: "rc-key-a" }]), {
      ACCESS_TOKEN: "user-token",
      ADMIN_TOKEN: "admin-token",
    });
    const res = await new Balancer().fetch(
      new Request("https://balancer.test/admin/accounts", {
        headers: { authorization: "Bearer user-token" },
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("可添加运行时账号，并提示未绑定 KV 时不持久", async () => {
    const calls: Call[] = [];
    installFetch({ plan: { "rc-new-key": [{ status: 200, body: okBody, headers: quotaHeaders(4) }] } }, calls);
    const env = makeEnv(JSON.stringify([{ label: "a", apiKey: "rc-key-a" }]), {
      ADMIN_TOKEN: "admin-token",
    });
    const balancer = new Balancer();

    const add = await balancer.fetch(
      new Request("https://balancer.test/admin/accounts", {
        method: "POST",
        headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
        body: JSON.stringify({ label: "new", apiKey: "rc-new-key" }),
      }),
      env,
      makeCtx(),
    );
    expect(add.status).toBe(201);
    const added = await asJson(add);
    // 直接实例化（无 DO state）时没有持久化后端，应给出提示
    expect(added.persisted).toBe(false);
    expect(added.warning).toContain("AMD_ACCOUNTS");

    const list = await asJson(
      await balancer.fetch(
        new Request("https://balancer.test/admin/accounts", {
          headers: { authorization: "Bearer admin-token" },
        }),
        env,
        makeCtx(),
      ),
    );
    expect(list.accounts.map((a: { label: string }) => a.label).sort()).toEqual(["a", "new"]);
    expect(list.accounts.find((a: { label: string }) => a.label === "new").runtime).toBe(true);
  });

  it("重复 label 会被拒绝", async () => {
    installFetch({}, []);
    const env = makeEnv(JSON.stringify([{ label: "a", apiKey: "rc-key-a" }]), {
      ADMIN_TOKEN: "admin-token",
    });
    const res = await new Balancer().fetch(
      new Request("https://balancer.test/admin/accounts", {
        method: "POST",
        headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
        body: JSON.stringify({ label: "a", apiKey: "rc-another" }),
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(409);
    expect((await asJson(res)).error.code).toBe("duplicate_label");
  });

  it("可停用账号，之后不再被调度", async () => {
    const calls: Call[] = [];
    installFetch(
      {
        plan: {
          "rc-key-aaaa1111": [{ status: 200, body: okBody, headers: quotaHeaders(9) }],
          "rc-key-bbbb2222": [{ status: 200, body: okBody, headers: quotaHeaders(1) }],
        },
        remainingUsd: { "rc-key-aaaa1111": 9, "rc-key-bbbb2222": 1 },
      },
      calls,
    );
    const env = makeEnv(
      JSON.stringify([
        { label: "a", apiKey: "rc-key-aaaa1111" },
        { label: "b", apiKey: "rc-key-bbbb2222" },
      ]),
      { ADMIN_TOKEN: "admin-token" },
    );
    const balancer = new Balancer();

    const res = await balancer.fetch(
      new Request("https://balancer.test/admin/accounts/a/enabled", {
        method: "POST",
        headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);

    const chat = await balancer.fetch(chatRequest(), env, makeCtx());
    expect(chat.headers.get("x-amd-account")).toBe("b");
    expect(calls.filter((c) => c.account === "rc-key-a")).toHaveLength(0);
  });

  it("绑定 KV 后运行时账号跨实例保留", async () => {
    const calls: Call[] = [];
    installFetch({ plan: { "rc-new-key": [{ status: 200, body: okBody, headers: quotaHeaders(3) }] } }, calls);

    // 极简内存 KV 实现
    const store = new Map<string, string>();
    const kv = {
      get: async <T,>(key: string): Promise<T | null> =>
        store.has(key) ? (JSON.parse(store.get(key)!) as T) : null,
      put: async (key: string, value: string): Promise<void> => {
        store.set(key, value);
      },
    };

    const env = makeEnv(JSON.stringify([{ label: "a", apiKey: "rc-key-a" }]), {
      ADMIN_TOKEN: "admin-token",
      BALANCER_KV: kv,
    });

    await new Balancer().fetch(
      new Request("https://balancer.test/admin/accounts", {
        method: "POST",
        headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
        body: JSON.stringify({ label: "new", apiKey: "rc-new-key" }),
      }),
      env,
      makeCtx(),
    );

    // 模拟换实例：内存全丢，只剩 KV
    const report = await asJson(
      await new Balancer().fetch(
        new Request("https://balancer.test/admin/accounts", {
          headers: { authorization: "Bearer admin-token" },
        }),
        env,
        makeCtx(),
      ),
    );
    expect(report.accounts.map((a: { label: string }) => a.label).sort()).toEqual(["a", "new"]);
    expect(report.persistent).toBe(true);
  });
});
