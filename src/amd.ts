import { isQuotaExhaustedMessage } from "./config";
import type { AccountConfig, Protocol, QuotaSnapshot } from "./types";

export const JSON_CONTENT = "application/json; charset=utf-8";

export interface UsageProbe {
  ok: boolean;
  status: number;
  snapshot?: QuotaSnapshot;
  error?: string;
}

/** 去掉密钥里的换行/空格，避免 secret 复制粘贴带来的隐形字符 */
export function normalizeKey(key: string): string {
  return key.replace(/[\s"']+|,\s*$/g, "").trim();
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** 兼容秒 / 毫秒两种 unix 时间戳 */
function fromUnix(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

function isoToMs(v: unknown): number | undefined {
  const s = str(v);
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function unwrapUsagePayload(body: unknown): Record<string, unknown> {
  const root = record(body);
  if (root.daily_cost_remaining_usd !== undefined || root.status !== undefined) return root;
  for (const key of ["data", "usage", "profile", "result", "model_usage"]) {
    const nested = record(root[key]);
    if (nested.daily_cost_remaining_usd !== undefined || nested.status !== undefined) {
      return nested;
    }
  }
  return root;
}

/** 调用平台额度接口 GET /api/profile/model-usage */
export async function fetchUsageSnapshot(
  account: AccountConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<UsageProbe> {
  const url = `${account.platformBase}/api/profile/model-usage`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${normalizeKey(account.apiKey)}`,
        accept: "application/json",
      },
      cf: { cacheTtl: 0 },
    });
  } catch (err) {
    return { ok: false, status: 0, error: `fetch failed: ${String(err)}` };
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, status: res.status, error: truncate(text || res.statusText, 240) };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, error: "usage response is not JSON" };
  }

  const payload = unwrapUsagePayload(body);
  const today = record(payload.today);
  const last30 = record(payload.last_30_days);
  const allTime = record(payload.all_time);

  const snapshot: QuotaSnapshot = {
    source: "usage-endpoint",
    status: str(payload.status),
    rpmLimit: num(payload.rpm_limit),
    dailyUsdLimit: num(payload.daily_cost_limit_usd),
    dailyUsdUsed: num(payload.daily_cost_used_usd),
    dailyUsdRemaining: num(payload.daily_cost_remaining_usd),
    dailyResetAtMs: isoToMs(payload.daily_reset_at),
    dailyResetTimezone: str(payload.daily_reset_timezone),
    todayRequests: num(today.requests),
    todayErrors: num(today.errors),
    todayTokens: num(today.total_tokens),
    todayCostUsd: num(today.cost),
    last30DaysCostUsd: num(last30.cost),
    allTimeCostUsd: num(allTime.cost),
    observedAtMs: Date.now(),
  };

  const byModelRaw = payload.by_model;
  if (Array.isArray(byModelRaw)) {
    snapshot.byModel = byModelRaw.map((m) => {
      const r = record(m);
      return {
        model: str(r.model) ?? "?",
        requests: num(r.requests) ?? 0,
        totalTokens: num(r.total_tokens) ?? 0,
        costUsd: num(r.cost) ?? 0,
      };
    });
  }

  // status 不是 ok 时（not_configured / not_available）额度字段通常缺失
  const hasQuota = snapshot.dailyUsdRemaining !== undefined;
  if (!hasQuota && snapshot.status && snapshot.status !== "ok") {
    return {
      ok: false,
      status: res.status,
      snapshot,
      error: `usage status=${snapshot.status}`,
    };
  }
  return { ok: hasQuota, status: res.status, snapshot, error: hasQuota ? undefined : "no quota fields in usage response" };
}

/**
 * 上游每个推理响应都会带 X-RateLimit-*-User-Daily-USD 头，
 * 用它把额度快照刷新成实时值（比轮询 usage 接口更准）。
 */
export function applyQuotaHeaders(
  snapshot: QuotaSnapshot | undefined,
  headers: Headers,
): QuotaSnapshot | undefined {
  const limit = num(headers.get("x-ratelimit-limit-user-daily-usd"));
  const used = num(headers.get("x-ratelimit-used-user-daily-usd"));
  const remaining = num(headers.get("x-ratelimit-remaining-user-daily-usd"));
  const reset = fromUnix(headers.get("x-ratelimit-reset-user-daily-usd"));
  const rpmLimit = num(headers.get("x-ratelimit-limit-user-rpm"));
  const rpmRemaining = num(headers.get("x-ratelimit-remaining-user-rpm"));

  if (
    limit === undefined &&
    used === undefined &&
    remaining === undefined &&
    rpmRemaining === undefined
  ) {
    return snapshot;
  }

  const base: QuotaSnapshot = snapshot ?? {
    source: "response-headers",
    observedAtMs: Date.now(),
  };
  const next: QuotaSnapshot = { ...base, source: "response-headers", observedAtMs: Date.now() };
  if (limit !== undefined) next.dailyUsdLimit = limit;
  if (used !== undefined) next.dailyUsdUsed = used;
  if (remaining !== undefined) {
    next.dailyUsdRemaining = remaining;
  } else if (limit !== undefined && used !== undefined) {
    next.dailyUsdRemaining = Math.max(0, limit - used);
  }
  if (reset !== undefined) next.dailyResetAtMs = reset;
  if (rpmLimit !== undefined) next.rpmLimit = rpmLimit;
  if (rpmRemaining !== undefined) next.rpmRemaining = rpmRemaining;
  return next;
}

export type FailureKind = "quota" | "rate" | "auth" | "server" | "network" | "client" | "none";

export interface Classified {
  kind: FailureKind;
  /** 是否应该换下一个 key 重试 */
  retryable: boolean;
  /** 该 key 是否永久失效（401/403） */
  fatal: boolean;
  cooldownSeconds: number;
  reason: string;
  retryAfterMs?: number;
}

export function truncate(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 从错误响应体里提取 message（兼容 OpenAI / Anthropic / detail 包装） */
export function extractErrorMessage(body: string): string {
  if (!body.trim()) return "";
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const err = record(parsed.error);
    const detail = record(parsed.detail);
    const inner = record(detail.error);
    return (
      str(err.message) ??
      str(parsed.message) ??
      str(inner.message) ??
      str(detail.message) ??
      str(parsed.error) ??
      str(parsed.detail) ??
      truncate(body, 200)
    );
  } catch {
    return truncate(body, 200);
  }
}

function parseRetryAfter(res: Response | null | undefined): number | undefined {
  const header = res?.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600) * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 3_600_000));
  return undefined;
}

export interface ClassifyInput {
  status: number;
  body: string;
  res?: Response | null;
  /** 该 key 当前额度快照，用于把 cooldown 对齐到周期重置时刻 */
  snapshot?: QuotaSnapshot;
  rateCooldownSeconds: number;
  serverCooldownSeconds: number;
  network?: boolean;
  networkError?: string;
}

/** 判断上游失败该冷却多久、是否换 key 重试 */
export function classifyFailure(input: ClassifyInput): Classified {
  const { status, body, res, snapshot } = input;
  const message = extractErrorMessage(body);
  const retryAfterMs = parseRetryAfter(res);

  if (input.network || status === 0) {
    return {
      kind: "network",
      retryable: true,
      fatal: false,
      cooldownSeconds: Math.max(1, Math.round(input.serverCooldownSeconds)),
      reason: truncate(input.networkError ?? "network error"),
    };
  }

  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      retryable: true,
      fatal: true,
      cooldownSeconds: 0,
      reason: message || `HTTP ${status} — key rejected`,
    };
  }

  if (status === 429) {
    const exhausted = isQuotaExhaustedMessage(message);
    if (exhausted) {
      // 额度耗尽：尽量对齐到周期重置时刻，否则回落到 Retry-After / 配置值
      if (snapshot?.dailyResetAtMs && snapshot.dailyResetAtMs > Date.now()) {
        const seconds = Math.ceil((snapshot.dailyResetAtMs - Date.now()) / 1000);
        return {
          kind: "quota",
          retryable: true,
          fatal: false,
          cooldownSeconds: Math.min(seconds, 90_000),
          reason: message || "daily usage limit exceeded",
          retryAfterMs: seconds * 1000,
        };
      }
      const fallback = Math.ceil((retryAfterMs ?? input.rateCooldownSeconds * 1000) / 1000);
      return {
        kind: "quota",
        retryable: true,
        fatal: false,
        cooldownSeconds: Math.max(fallback, 60),
        reason: message || "daily usage limit exceeded",
        retryAfterMs: retryAfterMs ?? fallback * 1000,
      };
    }
    const seconds = Math.ceil((retryAfterMs ?? input.rateCooldownSeconds * 1000) / 1000);
    return {
      kind: "rate",
      retryable: true,
      fatal: false,
      cooldownSeconds: Math.max(1, seconds),
      reason: message || "rate limited (rpm/concurrency)",
      retryAfterMs: retryAfterMs ?? seconds * 1000,
    };
  }

  if (status >= 500) {
    return {
      kind: "server",
      retryable: true,
      fatal: false,
      cooldownSeconds: Math.max(1, Math.round(input.serverCooldownSeconds)),
      reason: message || `HTTP ${status}`,
    };
  }

  // 400/404/413/422 等：请求本身的问题，换 key 也一样失败
  return {
    kind: "client",
    retryable: false,
    fatal: false,
    cooldownSeconds: 0,
    reason: message || `HTTP ${status}`,
  };
}

/** 构造转发给上游的请求头 */
export function buildUpstreamHeaders(opts: {
  account: AccountConfig;
  incoming: Headers;
  protocol: Protocol;
}): Headers {
  const out = new Headers();
  const skip = new Set([
    "authorization",
    "x-api-key",
    "host",
    "content-length",
    "connection",
    "accept-encoding",
    "cookie",
    "cf-connecting-ip",
    "cf-ray",
    "cf-ipcountry",
    "cf-visitor",
    "cf-worker",
    "cdn-loop",
    "true-client-ip",
    "x-real-ip",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-ratelimit-reset-user-daily-usd",
  ]);
  for (const [k, v] of opts.incoming) if (!skip.has(k.toLowerCase())) out.set(k, v);

  const key = normalizeKey(opts.account.apiKey);
  out.set("authorization", `Bearer ${key}`);
  if (opts.protocol === "anthropic") {
    // /v1/messages 走 x-api-key；Authorization 也一并给，兼容两种读法
    out.set("x-api-key", key);
    if (!out.has("anthropic-version")) out.set("anthropic-version", "2023-06-01");
  } else {
    out.delete("x-api-key");
  }
  out.set("accept-encoding", "identity");
  return out;
}
