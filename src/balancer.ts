import {
  applyQuotaHeaders,
  buildUpstreamHeaders,
  classifyFailure,
  extractErrorMessage,
  fetchUsageSnapshot,
  JSON_CONTENT,
  normalizeKey,
  truncate,
  type Classified,
} from "./amd";
import {
  asString,
  maskKey,
  mergeAccounts,
  parseAccounts,
  readConfig,
  resolveRoute,
  type RuntimeConfig,
} from "./config";
import { renderDashboard } from "./dashboard";
import { RuntimeKeyStore, type KvLike } from "./kv";
import { redeploySelf } from "./redeploy";
import type {
  AccountConfig,
  AccountState,
  AccountView,
  Protocol,
  QuotaReport,
  QuotaSnapshot,
} from "./types";

export interface Env {
  AMD_ACCOUNTS?: string;
  AMD_API_KEYS?: string;
  AMD_API_KEY?: string;
  ACCESS_TOKEN?: string;
  ADMIN_TOKEN?: string;
  AMD_API_BASE?: string;
  AMD_PLATFORM_BASE?: string;
  BASE_PATH?: string;
  QUOTA_TTL_SECONDS?: string;
  MAX_KEY_ATTEMPTS?: string;
  RPM_LIMIT?: string;
  RATE_COOLDOWN_SECONDS?: string;
  SERVER_COOLDOWN_SECONDS?: string;
  QUOTA_PROBE_MIN_INTERVAL_SECONDS?: string;
  QUOTA_COOLDOWN_CAP_SECONDS?: string;
  MODELS_CACHE_SECONDS?: string;
  PROBE_MODEL?: string;
  MAX_BODY_BYTES?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_SCRIPT_NAME?: string;
  BALANCER: DurableObjectNamespace;
  BALANCER_KV?: KvLike;
  [key: string]: unknown;
}

const UPSTREAM_TIMEOUT_MS = 300_000;
const RPM_WINDOW_MS = 60_000;
const LEASE_MS = 6 * 60 * 1000;
const STICKY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PROBE_MODEL = "DeepSeek-V4-Flash";
const EVENT_LOG_SIZE = 50;

/** request.url 在 Worker 里始终合法，但解析失败时返回 null 而不是抛异常 */
function safeUrl(input: string | URL): URL | null {
  try {
    return input instanceof URL ? input : new URL(input);
  } catch {
    return null;
  }
}

interface EventEntry {
  atMs: number;
  event: string;
  label?: string;
  detail?: string;
}

interface BodySpec {
  hasBody: boolean;
  body?: ArrayBuffer;
}

interface AuthResult {
  level: "admin" | "access" | "open" | "denied";
  message?: string;
}

interface ProbeResult {
  probed: string[];
  failed: Array<{ label: string; error: string }>;
}

export class Balancer {
  private readonly env?: Env;
  private readonly state?: DurableObjectState;
  private states = new Map<string, AccountState>();
  private keyStore?: RuntimeKeyStore;
  private keyStoreEnvSig = "";
  private accounts: AccountConfig[] = [];
  private accountsSig = "";
  private modelsCache?: { atMs: number; status: number; headers: [string, string][]; body: string };
  private sticky = new Map<string, { label: string; atMs: number }>();
  private events: EventEntry[] = [];
  private refreshing?: Promise<ProbeResult>;
  private lastProbeAtMs = 0;
  private probeModel?: { id: string; atMs: number };

  /**
   * Durable Object 只会在实例化时拿到 (state, env)；之后调用 fetch(request) 时
   * 不会再传 env/ExecutionContext。所以这里把它们缓存下来，两条路径共用。
   */
  constructor(state?: DurableObjectState, env?: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * env/ctx 可以显式传入（Worker 入口、单元测试），
   * 也可以不传（Durable Object 运行时只会传 request）。
   */
  async fetch(request: Request, envArg?: Env, ctxArg?: ExecutionContext): Promise<Response> {
    const env = envArg ?? this.env;
    if (!env) {
      return jsonError(
        500,
        "env_missing",
        "Balancer 没有拿到运行时环境（env）。如果是直接实例化测试，请显式传入 env。",
      );
    }
    const ctx = ctxArg ?? this.ctxAdapter();
    const cfg = readConfig(env);
    const url = safeUrl(request.url);
    if (!url) return jsonError(400, "invalid_url", "无法解析请求 URL");

    if (request.method === "OPTIONS") return this.preflight(request);

    if (url.pathname.startsWith("/internal/")) {
      return this.handleInternal(request, env, cfg, url);
    }

    const route = resolveRoute(url.pathname, { basePath: cfg.basePath });

    // Worker 运行时要求：返回响应时如果请求体还没被读取，会在响应发出后抛
    // "Can't read from request stream after response has been sent"。
    // 下面这些分支不读 body，所以先显式丢弃，避免污染日志。
    const consumesBody =
      route.kind === "chat" ||
      route.kind === "messages" ||
      route.kind === "count_tokens" ||
      route.kind === "admin";
    if (!consumesBody) await discardBody(request);

    switch (route.kind) {
      case "dashboard":
        // 打开看板时后台刷新一次额度，页面拿到的是新鲜数据且不阻塞首屏
        ctx.waitUntil(
          this.probeAll(env, cfg, { force: false }).catch(() => {
            /* 后台刷新失败不影响看板 */
          }),
        );
        return renderDashboard();
      case "health":
        return this.handleHealth(env, cfg);
      case "quota":
        return this.handleQuota(request, env, cfg, url);
      case "admin":
        return this.handleAdmin(request, env, cfg, url);
      case "models":
        return this.handleModels(request, env, cfg, route.upstreamPath);
      case "chat":
      case "messages":
      case "count_tokens":
        return this.proxy(request, env, cfg, route.upstreamPath, route.protocol);
      case "not_supported":
        return jsonError(
          404,
          "endpoint_not_supported",
          `AMD 公共免费模型 API 不提供 ${route.upstreamPath}（官方仅开放 /v1/chat/completions、/v1/messages、/v1/models）`,
          "not_supported_error",
        );
      case "unknown":
      default:
        return jsonError(
          404,
          "unknown_path",
          `未知路径 ${url.pathname}。可用：/v1/chat/completions、/v1/messages、/v1/models、/v1/quota、/dashboard`,
        );
    }
  }

  // ── 认证 ──────────────────────────────────────────────────────

  /** Durable Object 里没有 ExecutionContext，用 state.waitUntil 顶上 */
  private ctxAdapter(): ExecutionContext {
    const state = this.state;
    const waitUntil = (promise: Promise<unknown>): void => {
      const safe = Promise.resolve(promise).catch(() => undefined);
      if (state?.waitUntil) state.waitUntil(safe);
      else void safe;
    };
    // SAFETY: 这里只用到 ExecutionContext 的 waitUntil / passThroughOnException，
    // 而 Worker 运行时不会对这两个成员做额外校验，因此用结构等价的对象代替即可。
    return {
      waitUntil,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
  }

  private auth(env: Env, request: Request, url: URL | null): AuthResult {
    const cfg = readConfig(env);
    if (!cfg.accessToken && !cfg.adminToken) return { level: "open" };

    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    const token =
      bearer ||
      request.headers.get("x-api-key")?.trim() ||
      request.headers.get("x-admin-token")?.trim() ||
      url?.searchParams.get("token")?.trim() ||
      "";

    if (token && cfg.adminToken && timingSafeEqual(token, cfg.adminToken)) {
      return { level: "admin" };
    }
    // 只配了 ADMIN_TOKEN 时，推理接口保持开放（ACCESS_TOKEN 才是推理接口的开关）
    if (!cfg.accessToken) return { level: "open" };
    if (token && timingSafeEqual(token, cfg.accessToken)) {
      return { level: "access" };
    }
    return {
      level: "denied",
      message: "缺少或错误的 token：请带 Authorization: Bearer <ACCESS_TOKEN>",
    };
  }

  private unauthorized(message: string): Response {
    return json(
      { error: { message, type: "authentication_error", code: "unauthorized" } },
      401,
      { "www-authenticate": 'Bearer realm="amd-api-balancer"' },
    );
  }

  // ── 账号解析与状态 ────────────────────────────────────────────

  private keyStoreFor(env: Env): RuntimeKeyStore {
    // 优先用显式绑定的 KV；否则退回 Durable Object 自带存储，
    // 这样通过管理接口添加的账号默认就能跨重启保留，不配 KV 也不会丢。
    const storage = this.state?.storage;
    const sig = `${String(env.CF_SCRIPT_NAME ?? "")}/${Boolean(env.BALANCER_KV)}/${Boolean(storage)}`;
    if (!this.keyStore || this.keyStoreEnvSig !== sig) {
      this.keyStore = RuntimeKeyStore.fromEnv(env, storage ? new DoStorageKv(storage) : undefined);
      this.keyStoreEnvSig = sig;
    }
    return this.keyStore;
  }

  private async resolveAccounts(env: Env): Promise<AccountConfig[]> {
    const base = parseAccounts(env);
    const store = this.keyStoreFor(env);
    const [overlay, removed] = await Promise.all([store.list(), store.removedLabels()]);
    const sig = JSON.stringify([
      base.map((a) => [a.label, a.apiKey, a.enabled, a.apiBase]),
      overlay.map((a) => [a.label, a.apiKey, a.enabled, a.apiBase]),
      removed,
    ]);
    if (sig !== this.accountsSig) {
      this.accountsSig = sig;
      this.accounts = mergeAccounts(base, overlay, new Set(removed));
      const live = new Set(this.accounts.map((a) => a.label));
      for (const label of [...this.states.keys()]) if (!live.has(label)) this.states.delete(label);
    }
    return this.accounts;
  }

  private stateFor(label: string): AccountState {
    let s = this.states.get(label);
    if (!s) {
      s = {
        quotaFetchedAtMs: 0,
        cooldownUntilMs: 0,
        disabled: false,
        leases: [],
        lastUsedAtMs: 0,
        recentRequests: [],
        totalRequests: 0,
        totalRetries: 0,
        totalErrors: 0,
      };
      this.states.set(label, s);
    }
    return s;
  }

  private sweepLeases(state: AccountState, now: number): void {
    if (!state.leases.length) return;
    state.leases = state.leases.filter((expiry) => expiry > now);
  }

  private acquire(account: AccountConfig, now: number): () => void {
    const state = this.stateFor(account.label);
    this.sweepLeases(state, now);
    state.leases.push(now + LEASE_MS);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const s = this.stateFor(account.label);
      s.leases.pop();
    };
  }

  private rpmLimitFor(state: AccountState, cfg: RuntimeConfig): number {
    return state.quota?.rpmLimit ?? cfg.rpmLimit;
  }

  private rpmUsed(state: AccountState, now: number): number {
    state.recentRequests = state.recentRequests.filter((t) => now - t < RPM_WINDOW_MS);
    return state.recentRequests.length;
  }

  /** 单账号是否可调度 + 原因 */
  private skipReason(
    account: AccountConfig,
    cfg: RuntimeConfig,
    now: number,
    state: AccountState,
  ): { skip: boolean; reason?: string; waitMs: number } {
    if (!account.enabled) return { skip: true, reason: "配置中已停用", waitMs: Infinity };
    if (state.disabled) {
      return { skip: true, reason: state.disableReason ?? "已禁用", waitMs: Infinity };
    }
    if (state.cooldownUntilMs > now) {
      return {
        skip: true,
        reason: state.cooldownReason ?? "冷却中",
        waitMs: state.cooldownUntilMs - now,
      };
    }
    this.sweepLeases(state, now);
    if (state.leases.length >= account.maxConcurrency) {
      return { skip: true, reason: `并发已达上限 ${account.maxConcurrency}`, waitMs: 1000 };
    }
    const rpmLimit = this.rpmLimitFor(state, cfg);
    if (this.rpmUsed(state, now) >= rpmLimit) {
      const oldest = state.recentRequests[0] ?? now;
      return {
        skip: true,
        reason: `本分钟请求数已达 ${rpmLimit}`,
        waitMs: Math.max(1000, oldest + RPM_WINDOW_MS - now),
      };
    }
    const remaining = state.quota?.dailyUsdRemaining;
    if (remaining !== undefined && remaining <= 0) {
      return { skip: true, reason: "今日额度已用尽", waitMs: this.resetWaitMs(state, now) };
    }
    return { skip: false, waitMs: 0 };
  }

  private resetWaitMs(state: AccountState, now: number, fallbackSeconds = 60): number {
    const reset = state.quota?.dailyResetAtMs;
    if (reset && reset > now) return reset - now;
    return fallbackSeconds * 1000;
  }

  /**
   * 候选排序：
   *  tier 0 已知剩余额度 > 0（剩余多的优先）
   *  tier 1 额度未知（先探测，按最久未使用）
   *  tier 2 已知额度耗尽（最后兜底）
   * 组内再按并发数、最后使用时间排序，天然实现「剩余额度最多优先」+ 轮询公平。
   */
  private candidateOrder(
    accounts: AccountConfig[],
    cfg: RuntimeConfig,
    now: number,
    exclude: Set<string>,
  ): { list: AccountConfig[]; waitMs: number } {
    let waitMs = Infinity;
    const scored: Array<{ account: AccountConfig; tier: number; remaining: number }> = [];

    for (const account of accounts) {
      if (exclude.has(account.label)) continue;
      const state = this.stateFor(account.label);
      const { skip, waitMs: w } = this.skipReason(account, cfg, now, state);
      if (skip) {
        if (Number.isFinite(w) && w < waitMs) waitMs = w;
        continue;
      }
      const remaining = state.quota?.dailyUsdRemaining;
      const tier = remaining === undefined ? 1 : remaining > 0 ? 0 : 2;
      scored.push({ account, tier, remaining: remaining ?? 0 });
    }

    scored.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (b.remaining !== a.remaining) return b.remaining - a.remaining;
      const sa = this.stateFor(a.account.label);
      const sb = this.stateFor(b.account.label);
      if (sa.leases.length !== sb.leases.length) return sa.leases.length - sb.leases.length;
      if (sa.lastUsedAtMs !== sb.lastUsedAtMs) return sa.lastUsedAtMs - sb.lastUsedAtMs;
      return a.account.label.localeCompare(b.account.label);
    });

    // 会话粘滞：同一客户端优先复用上次的账号（在 tier 0/1 内提升）
    return { list: scored.map((s) => s.account), waitMs };
  }

  private sessionId(request: Request): string {
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) return `ip:${ip}`;
    const cookie = request.headers.get("cookie");
    if (cookie) return `ck:${cookie.slice(0, 64)}`;
    const auth = request.headers.get("authorization") ?? request.headers.get("x-api-key");
    if (auth) return `tok:${auth.slice(-16)}`;
    return "anon";
  }

  private applySticky(
    list: AccountConfig[],
    request: Request,
    now: number,
  ): AccountConfig[] {
    if (list.length < 2) return list;
    const key = this.sessionId(request);
    const pinned = this.sticky.get(key);
    if (pinned && now - pinned.atMs < STICKY_TTL_MS) {
      const idx = list.findIndex((a) => a.label === pinned.label);
      if (idx > 0) {
        const [hit] = list.splice(idx, 1);
        if (hit) list.unshift(hit);
      }
    }
    return list;
  }

  private rememberSticky(request: Request, label: string, now: number): void {
    const key = this.sessionId(request);
    this.sticky.set(key, { label, atMs: now });
    if (this.sticky.size > 5000) {
      for (const [k, v] of this.sticky) {
        if (now - v.atMs > STICKY_TTL_MS) this.sticky.delete(k);
      }
    }
  }

  private log(event: string, label?: string, detail?: string): void {
    this.events.unshift({ atMs: Date.now(), event, label, detail });
    if (this.events.length > EVENT_LOG_SIZE) this.events.length = EVENT_LOG_SIZE;
  }

  // ── 代理 ──────────────────────────────────────────────────────

  private async proxy(
    request: Request,
    env: Env,
    cfg: RuntimeConfig,
    path: string,
    protocol: Protocol,
    opts: { buffer?: boolean } = {},
  ): Promise<Response> {
    const started = Date.now();
    const auth = this.auth(env, request, safeUrl(request.url));
    if (auth.level === "denied") return this.unauthorized(auth.message ?? "unauthorized");
    if (auth.level === "open" && !cfg.accessToken && !cfg.adminToken) {
      this.log("warn", undefined, "ACCESS_TOKEN 未配置，接口对外开放");
    }

    const accounts = await this.resolveAccounts(env);
    if (!accounts.length) {
      return jsonError(
        503,
        "no_keys_configured",
        "还没有配置任何 AMD API key。请执行：wrangler secret put AMD_ACCOUNTS，或在看板里添加账号",
      );
    }

    const body = await readBody(request, cfg);
    if (body instanceof Response) return body;

    const tried = new Set<string>();
    const maxAttempts = Math.max(1, Math.min(cfg.maxKeyAttempts, accounts.length));
    let lastFailure: { status: number; headers: [string, string][]; text: string; label: string } | null =
      null;
    let lastClassified: Classified | null = null;
    let poolWaitMs = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const now = Date.now();
      const { list, waitMs } = this.candidateOrder(accounts, cfg, now, tried);
      const ordered = this.applySticky(list, request, now);
      const account = ordered[0];
      if (!account) {
        poolWaitMs = Number.isFinite(waitMs) ? waitMs : 0;
        break;
      }
      tried.add(account.label);
      const release = this.acquire(account, now);

      let res: Response | undefined;
      let networkError: string | undefined;
      try {
        res = await this.dispatch(account, request, path, body, protocol);
      } catch (err) {
        networkError = err instanceof Error ? err.message : String(err);
      }

      if (res && res.ok) {
        if (attempt > 0) this.stateFor(account.label).totalRetries++;
        this.rememberSticky(request, account.label, now);
        const built = opts.buffer
          ? await this.bufferedResponse(res, account, release, attempt, cfg, now)
          : this.streamResponse(res, account, release, attempt, cfg, now);
        this.log("ok", account.label, `${path} ${res.status} ${Date.now() - started}ms`);
        return built;
      }

      const text = res ? await safeText(res) : "";
      const state = this.stateFor(account.label);
      const classified = classifyFailure({
        status: res?.status ?? 0,
        body: text,
        res,
        snapshot: state.quota,
        rateCooldownSeconds: cfg.rateCooldownSeconds,
        serverCooldownSeconds: cfg.serverCooldownSeconds,
        network: networkError !== undefined,
        networkError,
      });

      state.totalErrors++;
      state.lastError = classified.reason;
      state.lastStatus = res?.status;
      release();

      this.applyFailure(account.label, classified, cfg);
      lastClassified = classified;
      this.log(
        classified.fatal ? "fatal" : "failover",
        account.label,
        `${res?.status ?? "network"} ${classified.kind}: ${truncate(classified.reason, 160)}`,
      );

      if (res) {
        lastFailure = {
          status: res.status,
          headers: [...res.headers.entries()],
          text: text || JSON.stringify({ error: { message: classified.reason } }),
          label: account.label,
        };
      }

      if (!classified.retryable) break;
    }

    if (lastFailure) return this.replayFailure(lastFailure, accounts.length, tried.size);

    const waitSeconds = Math.max(1, Math.ceil(poolWaitMs / 1000) || 5);
    const reason =
      tried.size === 0
        ? `所有账号当前都不可用（${lastClassified?.reason ?? "冷却/限流/并发占满"}），请稍后重试`
        : `已尝试 ${tried.size} 个账号但都失败：${lastClassified?.reason ?? "未知错误"}`;
    return json(
      {
        error: {
          message: reason,
          type: "rate_limit_error",
          code: "all_keys_unavailable",
        },
        balancer: {
          accounts: accounts.length,
          tried: [...tried],
          retry_after_seconds: waitSeconds,
        },
      },
      429,
      { "retry-after": String(waitSeconds), "x-amd-pool-size": String(accounts.length) },
    );
  }

  private async dispatch(
    account: AccountConfig,
    request: Request,
    path: string,
    body: BodySpec,
    protocol: Protocol,
  ): Promise<Response> {
    const url = `${account.apiBase}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const method = request.method.toUpperCase();
    try {
      const init: RequestInit = {
        method,
        headers: buildUpstreamHeaders({ account, incoming: request.headers, protocol }),
        signal: controller.signal,
        redirect: "follow",
      };
      if (method !== "GET" && method !== "HEAD" && body.hasBody && body.body) {
        init.body = body.body;
      }
      return await fetch(url, init);
    } finally {
      clearTimeout(timer);
    }
  }

  private streamResponse(
    upstream: Response,
    account: AccountConfig,
    release: () => void,
    attempt: number,
    cfg: RuntimeConfig,
    now: number,
  ): Response {
    const meta = this.recordSuccess(upstream, account, attempt, cfg, now);
    const status = upstream.status;
    try {
      const headers = clientHeaders(upstream.headers, meta);
      if (upstream.body === null || status === 204 || status === 205 || status === 304) {
        release();
        return new Response(null, { status, statusText: upstream.statusText, headers });
      }
      return new Response(tapStream(upstream.body, release), {
        status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (err) {
      // 构建响应失败时必须归还并发租约，否则这个账号会被永久占住名额
      release();
      throw err;
    }
  }

  private async bufferedResponse(
    upstream: Response,
    account: AccountConfig,
    release: () => void,
    attempt: number,
    cfg: RuntimeConfig,
    now: number,
  ): Promise<Response> {
    const text = await safeText(upstream);
    const meta = this.recordSuccess(upstream, account, attempt, cfg, now);
    release();
    if (upstream.status === 200) {
      this.modelsCache = {
        atMs: now,
        status: upstream.status,
        headers: [...upstream.headers.entries()],
        body: text,
      };
    }
    return new Response(text, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: clientHeaders(upstream.headers, meta),
    });
  }

  /** 记录成功请求的用量/额度（额度来自响应头，实时且免费） */
  private recordSuccess(
    upstream: Response,
    account: AccountConfig,
    attempt: number,
    cfg: RuntimeConfig,
    now: number,
  ): MetaHeaders {
    const state = this.stateFor(account.label);
    const quota = applyQuotaHeaders(state.quota, upstream.headers);
    if (quota) {
      state.quota = quota;
      state.quotaFetchedAtMs = now;
      state.quotaError = undefined;
    }
    state.totalRequests++;
    state.lastUsedAtMs = now;
    state.lastStatus = upstream.status;
    state.recentRequests.push(now);
    state.recentRequests = state.recentRequests.filter((t) => now - t < RPM_WINDOW_MS);

    const remaining = state.quota?.dailyUsdRemaining;
    if (remaining !== undefined && remaining <= 0) {
      const seconds = Math.ceil(this.resetWaitMs(state, now) / 1000);
      this.cooldown(account.label, Math.min(seconds, cfg.quotaCooldownCapSeconds), "今日额度已用尽");
    }

    return {
      label: account.label,
      attempt: attempt + 1,
      quota: state.quota,
      pool: this.poolTotals(cfg, now),
    };
  }

  private poolTotals(cfg: RuntimeConfig, now: number): { remaining?: number; accounts: number } {
    let remaining: number | undefined;
    let seen = 0;
    for (const account of this.accounts) {
      const state = this.states.get(account.label);
      if (!state || this.skipReason(account, cfg, now, state).skip) continue;
      seen++;
      const r = state.quota?.dailyUsdRemaining;
      if (r !== undefined) remaining = (remaining ?? 0) + r;
    }
    return { remaining, accounts: seen };
  }

  private cooldown(label: string, seconds: number, reason: string): void {
    const state = this.stateFor(label);
    const capped = Math.max(1, Math.min(Math.round(seconds), 90 * 60));
    state.cooldownUntilMs = Date.now() + capped * 1000;
    state.cooldownReason = `${reason}（冷却 ${capped}s）`;
  }

  private applyFailure(label: string, classified: Classified, cfg: RuntimeConfig): void {
    const state = this.stateFor(label);
    if (classified.fatal) {
      state.disabled = true;
      state.disableReason = `${classified.reason}（自动禁用，修复后在管理接口启用）`;
      this.log("disabled", label, classified.reason);
      return;
    }
    if (classified.kind === "quota") {
      // 用响应头里的重置时刻标记额度耗尽，并写入快照，避免继续被调度
      if (classified.cooldownSeconds > 0) {
        const until = Date.now() + classified.cooldownSeconds * 1000;
        state.quota = {
          ...(state.quota ?? { source: "response-headers", observedAtMs: Date.now() }),
          dailyUsdRemaining: 0,
          ...(classified.retryAfterMs ? { dailyResetAtMs: until } : {}),
        };
      }
      this.cooldown(label, Math.min(classified.cooldownSeconds, cfg.quotaCooldownCapSeconds), classified.reason);
      return;
    }
    if (classified.cooldownSeconds > 0) {
      this.cooldown(label, classified.cooldownSeconds, classified.reason);
    }
  }

  private replayFailure(
    failure: { status: number; headers: [string, string][]; text: string; label: string },
    poolSize: number,
    triedCount: number,
  ): Response {
    const headers = new Headers();
    for (const [k, v] of failure.headers) {
      const lower = k.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === "www-authenticate" || lower === "set-cookie") continue;
      headers.set(k, v);
    }
    headers.set("content-type", headers.get("content-type") ?? JSON_CONTENT);
    headers.set("x-amd-account", failure.label);
    headers.set("x-amd-pool-size", String(poolSize));
    headers.set("x-amd-keys-tried", String(triedCount));
    return new Response(failure.text, { status: failure.status, headers });
  }

  // ── GET /v1/models ────────────────────────────────────────────

  private async handleModels(request: Request, env: Env, cfg: RuntimeConfig, path: string): Promise<Response> {
    const now = Date.now();
    const cache = this.modelsCache;
    if (cache && now - cache.atMs < cfg.modelsCacheSeconds * 1000) {
      const headers = new Headers(cache.headers);
      headers.set("x-amd-models-cache", "hit");
      headers.set("cache-control", `public, max-age=${cfg.modelsCacheSeconds}`);
      return new Response(cache.body, { status: cache.status, headers });
    }
    const res = await this.proxy(request, env, cfg, path, "openai", { buffer: true });
    res.headers.set("x-amd-models-cache", res.ok ? "miss" : "error");
    return res;
  }

  // ── 内部接口（cron / 额度刷新）────────────────────────────────

  private async handleInternal(
    request: Request,
    env: Env,
    cfg: RuntimeConfig,
    url: URL,
  ): Promise<Response> {
    if (request.headers.get("x-balancer-internal") !== "1") {
      return jsonError(404, "not_found", "not found");
    }
    const action = url.pathname.replace("/internal/", "");
    if (action === "refresh") {
      const result = await this.probeAll(env, cfg, { force: url.searchParams.get("force") === "1" });
      return json({ ok: true, ...result }, 200);
    }
    return jsonError(404, "not_found", "not found");
  }

  // ── 额度 ──────────────────────────────────────────────────────

  /**
   * 诊断用：只报告「哪些环境变量被注入了」，绝不输出值。
   *
   * /health 是公开且无需鉴权的，输出值就等于泄露 API key，所以这里只给布尔值。
   *
   * 为什么值得单独暴露：在 CF 面板把密钥加成明文 Variables 时，下一次部署
   * （包括 Git 集成触发的自动构建）会把它们覆盖掉，表现为 accounts: 0 /
   * auth_required: false，非常容易被误判成代码 bug。看一眼这里就能区分
   * 「值没到 env」和「值到了但解析失败」。
   */
  private envPresence(env: Env): Record<string, boolean> {
    const names = [
      "AMD_ACCOUNTS",
      "AMD_API_KEYS",
      "AMD_API_KEY",
      "ACCESS_TOKEN",
      "ADMIN_TOKEN",
    ] as const;
    const out: Record<string, boolean> = {};
    for (const name of names) out[name] = asString(env[name]).trim().length > 0;
    return out;
  }

  private async handleHealth(env: Env, cfg: RuntimeConfig): Promise<Response> {
    const now = Date.now();
    const accounts = await this.resolveAccounts(env);
    const hint =
      accounts.length === 0 && asString(env.AMD_ACCOUNTS).trim().length > 0
        ? "AMD_ACCOUNTS 有值但解析出 0 个账号：检查是否为合法 JSON、key 是否含 '-'"
        : undefined;
    return json({
      status: "ok",
      accounts: accounts.length,
      schedulable: accounts.filter((a) => !this.skipReason(a, cfg, now, this.stateFor(a.label)).skip)
        .length,
      auth_required: Boolean(cfg.accessToken || cfg.adminToken),
      upstream: cfg.apiBase,
      env: this.envPresence(env),
      ...(hint ? { accountsHint: hint } : {}),
      time: new Date(now).toISOString(),
    });
  }

  private async handleQuota(
    request: Request,
    env: Env,
    cfg: RuntimeConfig,
    url: URL,
  ): Promise<Response> {
    const auth = this.auth(env, request, url);
    if (auth.level === "denied") return this.unauthorized(auth.message ?? "unauthorized");

    if (url.searchParams.get("refresh") === "1" || url.searchParams.get("probe") === "1") {
      const force = url.searchParams.get("probe") === "1" || url.searchParams.get("force") === "1";
      const task = this.probeAll(env, cfg, { force });
      if (!force) {
        // 后台刷新 + 等待，避免并发刷新打爆上游
        await task;
      } else {
        await task;
      }
    } else {
      // 顺带刷新过期快照（不阻塞太久）
      await this.probeAll(env, cfg, { force: false, maxAccounts: 4 });
    }

    const report = await this.buildReport(env, cfg);
    return json(report, 200, { "cache-control": "no-store" });
  }

  /** 只读的额度探测：平台 usage 接口（免费），失败时用 max_tokens=1 的极小请求兜底 */
  private async probeAccount(
    account: AccountConfig,
    cfg: RuntimeConfig,
    now: number,
  ): Promise<{ ok: boolean; error?: string; snapshot?: QuotaSnapshot }> {
    const state = this.stateFor(account.label);
    const usage = await fetchUsageSnapshot(account);
    if (usage.snapshot) {
      state.quota = usage.snapshot;
      state.quotaFetchedAtMs = now;
    }
    if (usage.ok && usage.snapshot) {
      state.quotaError = undefined;
      state.disabled = false;
      state.disableReason = undefined;
      state.cooldownUntilMs = 0;
      state.cooldownReason = undefined;
      if ((usage.snapshot.dailyUsdRemaining ?? 1) <= 0) {
        const seconds = Math.ceil(this.resetWaitMs(state, now) / 1000);
        this.cooldown(account.label, Math.min(seconds, cfg.quotaCooldownCapSeconds), "今日额度已用尽");
      }
      return { ok: true, snapshot: usage.snapshot };
    }

    if (usage.status === 401 || usage.status === 403) {
      const classified = classifyFailure({
        status: usage.status,
        body: usage.error ?? "",
        snapshot: state.quota,
        rateCooldownSeconds: cfg.rateCooldownSeconds,
        serverCooldownSeconds: cfg.serverCooldownSeconds,
      });
      this.applyFailure(account.label, classified, cfg);
      state.quotaError = usage.error;
      return { ok: false, error: usage.error ?? `HTTP ${usage.status}` };
    }

    // usage 接口不可用：用一次极小推理请求读 X-RateLimit-* 响应头
    if (now - this.lastProbeAtMs < cfg.quotaProbeMinIntervalSeconds * 1000) {
      state.quotaError = usage.error ?? state.quotaError;
      return { ok: false, error: usage.error ?? "usage 接口不可用（跳过主动探测，避免刷限流）" };
    }
    this.lastProbeAtMs = now;

    const model = await this.resolveProbeModel(account, cfg);
    const probeBody: BodySpec = {
      hasBody: true,
      body: new TextEncoder().encode(
        JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
      ).buffer as ArrayBuffer,
    };
    const probeReq = new Request(`${cfg.apiBase}/v1/chat/completions`, { method: "POST" });
    try {
      const res = await this.dispatch(account, probeReq, "/v1/chat/completions", probeBody, "openai");
      const text = await safeText(res);
      if (res.ok) {
        const quota = applyQuotaHeaders(state.quota, res.headers);
        if (quota) {
          state.quota = quota;
          state.quotaFetchedAtMs = now;
        }
        state.quotaError = usage.error;
        state.lastStatus = res.status;
        return { ok: true, snapshot: state.quota };
      }
      const classified = classifyFailure({
        status: res.status,
        body: text,
        res,
        snapshot: state.quota,
        rateCooldownSeconds: cfg.rateCooldownSeconds,
        serverCooldownSeconds: cfg.serverCooldownSeconds,
      });
      state.lastStatus = res.status;
      state.lastError = classified.reason;
      this.applyFailure(account.label, classified, cfg);
      state.quotaError = usage.error ?? classified.reason;
      return { ok: false, error: `${res.status} ${truncate(extractErrorMessage(text) || classified.reason, 200)}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.quotaError = message;
      return { ok: false, error: message };
    }
  }

  private async resolveProbeModel(account: AccountConfig, cfg: RuntimeConfig): Promise<string> {
    if (cfg.probeModel) return cfg.probeModel;
    const cached = this.probeModel;
    if (cached && Date.now() - cached.atMs < 10 * 60 * 1000) return cached.id;
    const fallback = this.modelsCache?.body ? firstModelId(this.modelsCache.body) : undefined;
    if (fallback) {
      this.probeModel = { id: fallback, atMs: Date.now() };
      return fallback;
    }
    try {
      const res = await fetch(`${account.apiBase}/v1/models`, {
        headers: buildUpstreamHeaders({ account, incoming: new Headers(), protocol: "openai" }),
      });
      if (res.ok) {
        const text = await res.text();
        const id = firstModelId(text);
        if (id) {
          this.probeModel = { id, atMs: Date.now() };
          return id;
        }
      }
    } catch {
      // 忽略：用默认模型兜底
    }
    return DEFAULT_PROBE_MODEL;
  }

  private async probeAll(
    env: Env,
    cfg: RuntimeConfig,
    opts: { force?: boolean; maxAccounts?: number } = {},
  ): Promise<ProbeResult> {
    if (this.refreshing) {
      await this.refreshing;
      return { probed: [], failed: [] };
    }
    const run = async (): Promise<ProbeResult> => {
      const now = Date.now();
      const accounts = await this.resolveAccounts(env);
      const ttlMs = cfg.quotaTtlSeconds * 1000;
      let targets = accounts.filter((a) => {
        if (!a.enabled) return false;
        const state = this.stateFor(a.label);
        if (state.disabled) return false;
        return opts.force || now - state.quotaFetchedAtMs > ttlMs;
      });
      if (opts.maxAccounts && targets.length > opts.maxAccounts) {
        targets = targets
          .slice()
          .sort((a, b) => this.stateFor(a.label).quotaFetchedAtMs - this.stateFor(b.label).quotaFetchedAtMs)
          .slice(0, opts.maxAccounts);
      }
      const probed: string[] = [];
      const failed: Array<{ label: string; error: string }> = [];
      await Promise.all(
        targets.map(async (account) => {
          try {
            const result = await this.probeAccount(account, cfg, Date.now());
            if (result.ok) {
              probed.push(account.label);
            } else {
              failed.push({ label: account.label, error: result.error ?? "unknown" });
            }
          } catch (err) {
            failed.push({ label: account.label, error: String(err) });
          }
          return account.label;
        }),
      );
      if (failed.length) {
        this.log("probe-failed", undefined, failed.map((f) => `${f.label}: ${f.error}`).join("; ").slice(0, 300));
      }
      return { probed, failed };
    };
    this.refreshing = run().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async buildReport(env: Env, cfg: RuntimeConfig): Promise<QuotaReport> {
    const now = Date.now();
    const accounts = await this.resolveAccounts(env);
    const store = this.keyStoreFor(env);
    const hidden = await store.removedLabels();

    const views: AccountView[] = accounts.map((account) => {
      const state = this.stateFor(account.label);
      const skip = this.skipReason(account, cfg, now, state);
      const quota = state.quota ?? null;
      return {
        label: account.label,
        keyMasked: maskKey(account.apiKey),
        enabled: account.enabled,
        runtime: Boolean(account.runtime),
        disabled: state.disabled,
        disableReason: state.disableReason,
        coolingDown: state.cooldownUntilMs > now,
        cooldownReason: state.cooldownReason,
        cooldownRemainingSeconds: Math.max(0, Math.ceil((state.cooldownUntilMs - now) / 1000)),
        inFlight: state.leases.length,
        maxConcurrency: account.maxConcurrency,
        lastUsedAtMs: state.lastUsedAtMs,
        totalRequests: state.totalRequests,
        totalRetries: state.totalRetries,
        totalErrors: state.totalErrors,
        lastError: state.lastError ?? state.quotaError,
        lastStatus: state.lastStatus,
        apiBase: account.apiBase,
        quota,
        quotaAgeSeconds: state.quotaFetchedAtMs ? Math.round((now - state.quotaFetchedAtMs) / 1000) : null,
        schedulable: !skip.skip,
        skipReason: skip.reason,
      };
    });

    const schedulable = views.filter((v) => v.schedulable);
    const sum = (pick: (v: AccountView) => number | undefined): number | undefined => {
      let total: number | undefined;
      for (const v of views) {
        const value = pick(v);
        if (value !== undefined) total = (total ?? 0) + value;
      }
      return total;
    };
    const resetTimes = views
      .map((v) => v.quota?.dailyResetAtMs)
      .filter((v): v is number => typeof v === "number" && v > now);

    return {
      generatedAtMs: now,
      quotaTtlSeconds: cfg.quotaTtlSeconds,
      totals: {
        accounts: views.length,
        schedulable: schedulable.length,
        dailyUsdLimit: sum((v) => v.quota?.dailyUsdLimit),
        dailyUsdUsed: sum((v) => v.quota?.dailyUsdUsed),
        dailyUsdRemaining: sum((v) => v.quota?.dailyUsdRemaining),
        earliestResetAtMs: resetTimes.length ? Math.min(...resetTimes) : undefined,
        todayRequests: sum((v) => v.quota?.todayRequests) ?? 0,
        todayTokens: sum((v) => v.quota?.todayTokens) ?? 0,
      },
      accounts: views,
      hiddenAccounts: hidden,
      runtimeAccounts: views.filter((v) => v.runtime).map((v) => v.label),
      probeModel: this.probeModel?.id,
    };
  }

  // ── 管理接口 ──────────────────────────────────────────────────

  private async handleAdmin(
    request: Request,
    env: Env,
    cfg: RuntimeConfig,
    url: URL,
  ): Promise<Response> {
    const auth = this.auth(env, request, url);
    if (auth.level !== "admin") {
      return this.unauthorized(
        auth.level === "denied"
          ? "管理接口需要 ADMIN_TOKEN（Authorization: Bearer <ADMIN_TOKEN>）"
          : "需要配置 ADMIN_TOKEN 才能使用管理接口",
      );
    }

    const path = url.pathname.replace(/^\/admin/, "").replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    const payload = method === "GET" || method === "DELETE" ? {} : await readJson(request);
    // GET/DELETE 也允许带 body，这里不解析但必须丢弃，否则运行时会报错
    if (method === "GET" || method === "DELETE") await discardBody(request);

    // 管理接口一律不使用缓存账号列表
    const base = parseAccounts(env);
    const store = this.keyStoreFor(env);

    if (path === "/accounts" && method === "GET") {
      const report = await this.buildReport(env, cfg);
      return json({
        accounts: report.accounts.map((a) => ({
          label: a.label,
          keyMasked: a.keyMasked,
          runtime: a.runtime,
          enabled: a.enabled,
          disabled: a.disabled,
          coolingDown: a.coolingDown,
          schedulable: a.schedulable,
          skipReason: a.skipReason,
          dailyUsdRemaining: a.quota?.dailyUsdRemaining,
        })),
        hiddenAccounts: report.hiddenAccounts,
        persistent: store.persistent,
      });
    }

    if (path === "/accounts" && method === "POST") {
      const apiKey = normalizeKey(String(payload.apiKey ?? ""));
      if (!apiKey) return jsonError(400, "invalid_request", "缺少 apiKey");
      if (!apiKey.startsWith("rc-")) {
        // 不阻断：兼容未来前缀变化，但给出提示
        this.log("warn", undefined, `key 前缀不是 rc-，已按原样使用`);
      }
      const label = String(payload.label ?? "").trim() || `runtime-${maskKey(apiKey).slice(0, 8)}`;
      if (base.some((a) => a.label === label) || (await store.list()).some((a) => a.label === label)) {
        return jsonError(409, "duplicate_label", `账号 ${label} 已存在，请换一个 label 或先删除`);
      }
      const account: AccountConfig = {
        label,
        apiKey,
        apiBase: String(payload.apiBase ?? "").trim() || cfg.apiBase,
        platformBase: String(payload.platformBase ?? "").trim() || cfg.platformBase,
        enabled: payload.enabled === undefined ? true : Boolean(payload.enabled),
        maxConcurrency: Number(payload.maxConcurrency) > 0 ? Math.floor(Number(payload.maxConcurrency)) : 6,
        runtime: true,
      };
      const probe = await this.probeAccount(account, cfg, Date.now());
      await store.upsert(account);
      this.accountsSig = "";
      this.log("account-added", label, probe.ok ? "额度探测成功" : `已添加，但探测失败：${probe.error}`);
      return json(
        {
          ok: true,
          message: probe.ok ? `已添加 ${label} 并探测到额度` : `已添加 ${label}（额度暂未取到：${probe.error}）`,
          label,
          persisted: store.persistent,
          quota: probe.snapshot ?? null,
          warning: store.persistent
            ? undefined
            : "账号只存在于当前实例内存，重启/换实例后会失效。请用 wrangler secret put AMD_ACCOUNTS 持久化",
        },
        201,
      );
    }

    if (path === "/accounts/delete" && method === "POST") {
      const label = String(payload.label ?? "").trim();
      if (!label) return jsonError(400, "invalid_request", "缺少 label");
      const secretLabels = new Set(base.map((a) => a.label));
      const existed = await store.remove(label, secretLabels);
      this.accountsSig = "";
      this.states.delete(label);
      this.log("account-removed", label, secretLabels.has(label) ? "secret 账号已隐藏" : "已删除");
      return json(
        {
          ok: existed,
          message: !existed
            ? `没有找到账号 ${label}`
            : secretLabels.has(label)
              ? `已隐藏 secret 账号 ${label}（secret 内容未改动；用 admin/accounts/restore 恢复）`
              : `已删除运行时账号 ${label}`,
        },
        existed ? 200 : 404,
      );
    }

    const enableMatch = path.match(/^\/accounts\/(.+)\/enabled$/);
    if (enableMatch && method === "POST") {
      const label = decodeURIComponent(enableMatch[1] ?? "");
      const enabled = Boolean(payload.enabled);
      const ok = await store.setEnabled(label, enabled, base);
      this.accountsSig = "";
      const state = this.stateFor(label);
      if (enabled) {
        await store.restore(label);
        state.disabled = false;
        state.disableReason = undefined;
        state.cooldownUntilMs = 0;
        state.cooldownReason = undefined;
      }
      this.log(enabled ? "account-enabled" : "account-disabled", label);
      return json({ ok, message: ok ? `${label} 已${enabled ? "启用" : "停用"}` : `未找到 ${label}` }, ok ? 200 : 404);
    }

    const resetMatch = path.match(/^\/accounts\/(.+)\/reset$/);
    if (resetMatch && method === "POST") {
      const label = decodeURIComponent(resetMatch[1] ?? "");
      const state = this.stateFor(label);
      state.disabled = false;
      state.disableReason = undefined;
      state.cooldownUntilMs = 0;
      state.cooldownReason = undefined;
      state.lastError = undefined;
      state.quotaFetchedAtMs = 0;
      this.log("account-reset", label);
      return json({ ok: true, message: `${label} 的冷却/禁用状态已清除` });
    }

    if (path === "/accounts/restore" && method === "POST") {
      const label = String(payload.label ?? "").trim();
      const ok = await store.restore(label);
      this.accountsSig = "";
      return json({ ok, message: ok ? `${label} 已恢复显示` : `${label} 不在隐藏列表中` }, ok ? 200 : 404);
    }

    if (path === "/refresh" && method === "POST") {
      const result = await this.probeAll(env, cfg, { force: true });
      const report = await this.buildReport(env, cfg);
      this.log("refresh", undefined, `probed=${result.probed.length} failed=${result.failed.length}`);
      return json({ ok: true, message: `已探测 ${result.probed.length} 个账号`, ...result, totals: report.totals });
    }

    if (path === "/test" && method === "POST") {
      const label = String(payload.label ?? "").trim();
      const accounts = await this.resolveAccounts(env);
      const account = accounts.find((a) => a.label === label);
      if (!account) return jsonError(404, "not_found", `未找到账号 ${label}`);
      const result = await this.probeAccount(account, cfg, Date.now());
      const report = await this.buildReport(env, cfg);
      const view = report.accounts.find((a) => a.label === label);
      return json({ ok: result.ok, label, quota: result.snapshot ?? null, error: result.error, state: view });
    }

    if (path === "/config" && method === "GET") {
      const report = await this.buildReport(env, cfg);
      return json({
        upstream: cfg.apiBase,
        platform: cfg.platformBase,
        basePath: cfg.basePath,
        quotaTtlSeconds: cfg.quotaTtlSeconds,
        maxKeyAttempts: cfg.maxKeyAttempts,
        rpmLimit: cfg.rpmLimit,
        accessTokenSet: Boolean(cfg.accessToken),
        adminTokenSet: Boolean(cfg.adminToken),
        cfApiTokenSet: Boolean(cfg.cfApiToken),
        cfAccountIdSet: Boolean(cfg.cfAccountId),
        scriptName: cfg.cfScriptName,
        kvBound: this.keyStoreFor(env).persistent,
        probeModel: report.probeModel ?? cfg.probeModel ?? null,
        accounts: report.totals,
      });
    }

    if (path === "/events" && method === "GET") {
      return json({ events: this.events });
    }

    if (path === "/redeploy" && method === "POST") {
      const result = await redeploySelf(cfg.cfApiToken, cfg.cfAccountId, cfg.cfScriptName);
      this.log("redeploy", undefined, result.message);
      return json(result, result.ok ? 200 : 502);
    }

    return jsonError(404, "unknown_admin_path", `未知管理路径 ${path}`);
  }

  private preflight(request: Request): Response {
    const origin = request.headers.get("origin") ?? "*";
    const requested = request.headers.get("access-control-request-headers");
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers":
          requested ?? "authorization, content-type, x-api-key, anthropic-version, anthropic-beta",
        "access-control-max-age": "86400",
        vary: "origin",
      },
    });
  }
}

// ── 工具函数 ────────────────────────────────────────────────────

/** 把 Durable Object 存储包装成 KvLike，语义对齐 Workers KV（存字符串、读时 JSON 解析） */
class DoStorageKv implements KvLike {
  constructor(private storage: DurableObjectStorage) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.storage.get<unknown>(key);
    if (raw === undefined || raw === null) return null;
    if (typeof raw === "string") {
      // SAFETY: RuntimeKeyStore 写入时用 JSON.stringify，这里按同样的约定还原；
      // 解析失败说明数据损坏，当作「没有存过」处理而不是抛错。
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    }
    return raw as T;
  }

  async put(key: string, value: string): Promise<void> {
    await this.storage.put(key, value);
  }
}

interface MetaHeaders {
  label: string;
  attempt: number;
  quota?: QuotaSnapshot;
  pool: { remaining?: number; accounts: number };
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

function clientHeaders(upstream: Headers, meta: MetaHeaders): Headers {
  const headers = new Headers();
  for (const [k, v] of upstream) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "set-cookie" || lower === "www-authenticate") continue;
    headers.set(k, v);
  }
  headers.set("x-amd-account", meta.label);
  headers.set("x-amd-attempt", String(meta.attempt));
  headers.delete("x-amd-models-cache");
  if (meta.quota) {
    if (meta.quota.dailyUsdRemaining !== undefined)
      headers.set("x-amd-quota-remaining-usd", String(round(meta.quota.dailyUsdRemaining)));
    if (meta.quota.dailyUsdUsed !== undefined)
      headers.set("x-amd-quota-used-usd", String(round(meta.quota.dailyUsdUsed)));
    if (meta.quota.dailyUsdLimit !== undefined)
      headers.set("x-amd-quota-limit-usd", String(round(meta.quota.dailyUsdLimit)));
    if (meta.quota.dailyResetAtMs !== undefined)
      headers.set("x-amd-quota-reset-at", new Date(meta.quota.dailyResetAtMs).toISOString());
    if (meta.quota.rpmRemaining !== undefined)
      headers.set("x-amd-quota-rpm-remaining", String(meta.quota.rpmRemaining));
  }
  if (meta.pool.remaining !== undefined) {
    headers.set("x-amd-pool-remaining-usd", String(round(meta.pool.remaining)));
  }
  headers.set("x-amd-pool-accounts", String(meta.pool.accounts));
  headers.set(
    "access-control-expose-headers",
    [
      "x-amd-account",
      "x-amd-attempt",
      "x-amd-quota-remaining-usd",
      "x-amd-quota-used-usd",
      "x-amd-quota-limit-usd",
      "x-amd-quota-reset-at",
      "x-amd-quota-rpm-remaining",
      "x-amd-pool-remaining-usd",
      "x-amd-pool-accounts",
      "x-ratelimit-limit-user-rpm",
      "x-ratelimit-remaining-user-rpm",
      "x-ratelimit-limit-user-daily-usd",
      "x-ratelimit-used-user-daily-usd",
      "x-ratelimit-remaining-user-daily-usd",
      "x-ratelimit-reset-user-daily-usd",
      "retry-after",
    ].join(", "),
  );
  headers.set("access-control-allow-origin", "*");
  return headers;
}

function round(value: number): number {
  return Math.round(value * 100000) / 100000;
}

/** 让流式响应结束后释放并发租约（客户端中断同样触发） */
function tapStream(
  body: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone();
  };
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    flush: finish,
  });
  body.pipeTo(writable).catch(finish).finally(finish);
  return readable;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * 丢弃尚未读取的请求体。
 * 返回响应前如果请求体没被消费，Worker 运行时会抛
 * "Can't read from request stream after response has been sent"。
 * cancel() 比读干净更省流量，对空 body / 已读 body 都安全。
 */
async function discardBody(request: Request): Promise<void> {
  const body = request.body;
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    /* 已经读过或已关闭，忽略 */
  }
}

async function readBody(request: Request, cfg: RuntimeConfig): Promise<BodySpec | Response> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || !request.body) return { hasBody: false };
  const header = Number(request.headers.get("content-length") ?? "0");
  const limit = cfg.maxBodyBytes;
  if (Number.isFinite(header) && header > limit) {
    // 不读 body 就返回了，必须丢弃，否则运行时会在响应后抛错
    await discardBody(request);
    return jsonError(413, "payload_too_large", `请求体过大（> ${limit} 字节）`);
  }
  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > limit) {
      return jsonError(413, "payload_too_large", `请求体过大（> ${limit} 字节）`);
    }
    return { hasBody: true, body };
  } catch (err) {
    return jsonError(400, "invalid_body", `无法读取请求体：${String(err)}`);
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function firstModelId(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { data?: Array<{ id?: string }> };
    const first = parsed.data?.[0]?.id;
    return typeof first === "string" ? first : undefined;
  } catch {
    return undefined;
  }
}

export function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": JSON_CONTENT, "cache-control": "no-store", ...(extra ?? {}) },
  });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  type = "invalid_request_error",
): Response {
  return json({ error: { message, type, code } }, status);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
