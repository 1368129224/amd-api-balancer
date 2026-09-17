import { describe, expect, it } from "vitest";
import {
  applyQuotaHeaders,
  buildUpstreamHeaders,
  classifyFailure,
  extractErrorMessage,
  fetchUsageSnapshot,
  normalizeKey,
  truncate,
} from "../src/amd";
import type { AccountConfig, QuotaSnapshot } from "../src/types";

const account: AccountConfig = {
  label: "a",
  apiKey: "rc-test-key",
  apiBase: "https://developer.amd.com.cn/radeon/api",
  platformBase: "https://radeon-global.anruicloud.com",
  enabled: true,
  maxConcurrency: 6,
};

describe("normalizeKey", () => {
  it("去掉空白、引号与尾逗号", () => {
    expect(normalizeKey('  "rc-abc" \n')).toBe("rc-abc");
    expect(normalizeKey("rc-abc, ")).toBe("rc-abc");
  });
});

describe("fetchUsageSnapshot", () => {
  const payload = {
    status: "ok",
    rpm_limit: 30,
    daily_cost_limit_usd: 10,
    daily_cost_used_usd: 1.8412,
    daily_cost_remaining_usd: 8.1588,
    daily_reset_timezone: "Asia/Shanghai",
    daily_reset_at: "2026-08-26T00:00:00+08:00",
    today: {
      requests: 142,
      errors: 3,
      total_tokens: 88214,
      prompt_tokens: 31002,
      completion_tokens: 57212,
      cost: 1.8412,
      last_request_at: "2026-08-25T14:22:07+08:00",
    },
    last_30_days: { requests: 2840, total_tokens: 1904221, cost: 39.77 },
    all_time: { requests: 9120, total_tokens: 6210443, cost: 128.44 },
    by_model: [{ model: "DeepSeek-V4-Flash", requests: 120, total_tokens: 74001, cost: 1.55 }],
  };

  it("解析官方 usage 响应", async () => {
    const fake = (async () =>
      new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    const probe = await fetchUsageSnapshot(account, fake);
    expect(probe.ok).toBe(true);
    const s = probe.snapshot!;
    expect(s.status).toBe("ok");
    expect(s.rpmLimit).toBe(30);
    expect(s.dailyUsdLimit).toBe(10);
    expect(s.dailyUsdRemaining).toBeCloseTo(8.1588);
    expect(s.dailyResetTimezone).toBe("Asia/Shanghai");
    expect(s.dailyResetAtMs).toBe(Date.parse("2026-08-26T00:00:00+08:00"));
    expect(s.todayRequests).toBe(142);
    expect(s.todayTokens).toBe(88214);
    expect(s.byModel?.[0]?.model).toBe("DeepSeek-V4-Flash");
  });

  it("请求 url 与鉴权头正确", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = String(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchUsageSnapshot(account, fake);
    expect(seenUrl).toBe("https://radeon-global.anruicloud.com/api/profile/model-usage");
    expect(seenAuth).toBe("Bearer rc-test-key");
  });

  it("status=not_configured 时返回失败但保留快照", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ status: "not_configured" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const probe = await fetchUsageSnapshot(account, fake);
    expect(probe.ok).toBe(false);
    expect(probe.snapshot?.status).toBe("not_configured");
    expect(probe.error).toContain("not_configured");
  });

  it("401 返回失败", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ error: { message: "invalid key" } }), {
        status: 401,
      })) as unknown as typeof fetch;
    const probe = await fetchUsageSnapshot(account, fake);
    expect(probe.ok).toBe(false);
    expect(probe.status).toBe(401);
  });

  it("网络异常不会抛出", async () => {
    const fake = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const probe = await fetchUsageSnapshot(account, fake);
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain("boom");
  });
});

describe("applyQuotaHeaders", () => {
  it("从响应头读取额度计数", () => {
    const headers = new Headers({
      "x-ratelimit-limit-user-rpm": "30",
      "x-ratelimit-remaining-user-rpm": "17",
      "x-ratelimit-limit-user-daily-usd": "10",
      "x-ratelimit-used-user-daily-usd": "2.5",
      "x-ratelimit-remaining-user-daily-usd": "7.5",
      "x-ratelimit-reset-user-daily-usd": "1787000000",
    });
    const snapshot = applyQuotaHeaders(undefined, headers);
    expect(snapshot?.dailyUsdLimit).toBe(10);
    expect(snapshot?.dailyUsdUsed).toBe(2.5);
    expect(snapshot?.dailyUsdRemaining).toBe(7.5);
    expect(snapshot?.rpmRemaining).toBe(17);
    expect(snapshot?.rpmLimit).toBe(30);
    expect(snapshot?.dailyResetAtMs).toBe(1787000000 * 1000);
    expect(snapshot?.source).toBe("response-headers");
  });

  it("缺少 remaining 时用 limit - used 推算", () => {
    const headers = new Headers({
      "x-ratelimit-limit-user-daily-usd": "10",
      "x-ratelimit-used-user-daily-usd": "9.25",
    });
    expect(applyQuotaHeaders(undefined, headers)?.dailyUsdRemaining).toBeCloseTo(0.75);
  });

  it("毫秒级 reset 时间戳也能识别", () => {
    const headers = new Headers({
      "x-ratelimit-remaining-user-daily-usd": "1",
      "x-ratelimit-reset-user-daily-usd": "1787000000000",
    });
    expect(applyQuotaHeaders(undefined, headers)?.dailyResetAtMs).toBe(1787000000000);
  });

  it("没有任何相关头时返回原快照", () => {
    const original: QuotaSnapshot = { source: "usage-endpoint", observedAtMs: 1 };
    expect(applyQuotaHeaders(original, new Headers())).toBe(original);
    expect(applyQuotaHeaders(undefined, new Headers())).toBeUndefined();
  });

  it("保留 usage 接口拿到的其它字段", () => {
    const original: QuotaSnapshot = {
      source: "usage-endpoint",
      observedAtMs: 1,
      todayRequests: 5,
      dailyResetTimezone: "Asia/Shanghai",
    };
    const next = applyQuotaHeaders(
      original,
      new Headers({ "x-ratelimit-remaining-user-daily-usd": "3" }),
    );
    expect(next?.todayRequests).toBe(5);
    expect(next?.dailyResetTimezone).toBe("Asia/Shanghai");
    expect(next?.source).toBe("response-headers");
  });
});

describe("classifyFailure", () => {
  const base = { rateCooldownSeconds: 30, serverCooldownSeconds: 5 };

  it("401 判定为永久失效", () => {
    const c = classifyFailure({
      ...base,
      status: 401,
      body: JSON.stringify({ error: { message: "invalid api key" } }),
    });
    expect(c.kind).toBe("auth");
    expect(c.fatal).toBe(true);
    expect(c.retryable).toBe(true);
  });

  it("429 分钟级限流使用 Retry-After", () => {
    const c = classifyFailure({
      ...base,
      status: 429,
      body: "",
      res: new Response("", { headers: { "retry-after": "60" } }),
    });
    expect(c.kind).toBe("rate");
    expect(c.fatal).toBe(false);
    expect(c.cooldownSeconds).toBe(60);
    expect(c.retryAfterMs).toBe(60_000);
  });

  it("429 + 每日额度耗尽 → quota，并对齐重置时刻", () => {
    const resetAt = Date.now() + 3600_000;
    const c = classifyFailure({
      ...base,
      status: 429,
      body: JSON.stringify({
        error: { message: "Daily usage limit exceeded: maximum $10 per period", code: "rate_limit_exceeded" },
      }),
      snapshot: { source: "usage-endpoint", observedAtMs: 0, dailyResetAtMs: resetAt },
    });
    expect(c.kind).toBe("quota");
    expect(c.cooldownSeconds).toBeGreaterThan(3500);
    expect(c.cooldownSeconds).toBeLessThanOrEqual(3600);
  });

  it("429 额度耗尽且无重置时刻时至少冷却 60s", () => {
    const c = classifyFailure({
      ...base,
      status: 429,
      body: JSON.stringify({ error: { message: "Quota exceeded" } }),
    });
    expect(c.kind).toBe("quota");
    expect(c.cooldownSeconds).toBeGreaterThanOrEqual(60);
  });

  it("并发限流的 Retry-After: 1 只短暂冷却", () => {
    const c = classifyFailure({
      ...base,
      status: 429,
      body: "",
      res: new Response("", { headers: { "retry-after": "1" } }),
    });
    expect(c.kind).toBe("rate");
    expect(c.cooldownSeconds).toBe(1);
  });

  it("5xx 走短冷却", () => {
    const c = classifyFailure({ ...base, status: 503, body: "upstream down" });
    expect(c.kind).toBe("server");
    expect(c.cooldownSeconds).toBe(5);
    expect(c.retryable).toBe(true);
  });

  it("400 不换 key 重试", () => {
    const c = classifyFailure({
      ...base,
      status: 400,
      body: JSON.stringify({ error: { message: "model is required" } }),
    });
    expect(c.kind).toBe("client");
    expect(c.retryable).toBe(false);
  });

  it("网络错误视为可重试", () => {
    const c = classifyFailure({ ...base, status: 0, body: "", network: true, networkError: "ECONNRESET" });
    expect(c.kind).toBe("network");
    expect(c.retryable).toBe(true);
  });
});

describe("extractErrorMessage", () => {
  it("OpenAI 风格", () => {
    expect(extractErrorMessage(JSON.stringify({ error: { message: "bad model" } }))).toBe("bad model");
  });

  it("Anthropic 风格", () => {
    expect(
      extractErrorMessage(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } })),
    ).toBe("slow down");
  });

  it("平台准入的 detail 包装", () => {
    expect(
      extractErrorMessage(JSON.stringify({ detail: { error: { message: "concurrency exceeded" } } })),
    ).toBe("concurrency exceeded");
  });

  it("非 JSON 文本", () => {
    expect(extractErrorMessage("plain failure")).toBe("plain failure");
    expect(extractErrorMessage("")).toBe("");
  });
});

describe("truncate", () => {
  it("压平空白并截断", () => {
    expect(truncate("a\n  b   c")).toBe("a b c");
    expect(truncate("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });
});

describe("buildUpstreamHeaders", () => {
  it("替换鉴权头且不泄漏客户端 token", () => {
    const incoming = new Headers({
      authorization: "Bearer client-token",
      "x-api-key": "client-key",
      "content-type": "application/json",
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "9.9.9.9",
      host: "example.com",
    });
    const out = buildUpstreamHeaders({ account, incoming, protocol: "openai" });
    expect(out.get("authorization")).toBe("Bearer rc-test-key");
    expect(out.get("x-api-key")).toBeNull();
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("cf-connecting-ip")).toBeNull();
    expect(out.get("x-forwarded-for")).toBeNull();
    expect(out.get("host")).toBeNull();
  });

  it("anthropic 协议补 x-api-key 与 anthropic-version，并透传客户端版本", () => {
    const out = buildUpstreamHeaders({
      account,
      incoming: new Headers({ "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching" }),
      protocol: "anthropic",
    });
    expect(out.get("x-api-key")).toBe("rc-test-key");
    expect(out.get("authorization")).toBe("Bearer rc-test-key");
    expect(out.get("anthropic-version")).toBe("2023-06-01");
    expect(out.get("anthropic-beta")).toBe("prompt-caching");
  });

  it("默认补 anthropic-version", () => {
    const out = buildUpstreamHeaders({ account, incoming: new Headers(), protocol: "anthropic" });
    expect(out.get("anthropic-version")).toBe("2023-06-01");
  });
});
