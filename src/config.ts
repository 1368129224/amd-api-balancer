import {
  DEFAULT_API_BASE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PLATFORM_BASE,
  DEFAULT_QUOTA_TTL_SECONDS,
  DEFAULT_RPM_LIMIT,
  type AccountConfig,
  type Protocol,
} from "./types";

export interface RuntimeConfig {
  apiBase: string;
  platformBase: string;
  /** 调用推理/额度接口所需的 token；为空表示不校验 */
  accessToken: string;
  adminToken: string;
  quotaTtlSeconds: number;
  maxKeyAttempts: number;
  /** RPM 兜底上限（读不到上游 rpm_limit 时使用） */
  rpmLimit: number;
  /** 429 未给 Retry-After 时的默认冷却秒数 */
  rateCooldownSeconds: number;
  /** 5xx 的短冷却秒数 */
  serverCooldownSeconds: number;
  /** usage 接口取不到时，两次探测的最小间隔秒数 */
  quotaProbeMinIntervalSeconds: number;
  cfApiToken: string;
  cfAccountId: string;
  cfScriptName: string;
  modelsCacheSeconds: number;
  /** Worker 部署在子路径下时（如 example.com/amd/v1/...）的路径前缀 */
  basePath: string;
  /** 额度耗尽账号的冷却上限（秒） */
  quotaCooldownCapSeconds: number;
  /** 请求体上限（字节），默认 32MiB */
  maxBodyBytes: number;
  /** 主动探测使用的模型；为空则自动从 /v1/models 取第一个 */
  probeModel: string;
}

export function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readConfig(env: Record<string, unknown>): RuntimeConfig {
  const get = (k: string): string | undefined => {
    const v = env[k];
    return typeof v === "string" ? v : undefined;
  };
  return {
    apiBase: trim((get("AMD_API_BASE") ?? "").replace(/\/+$/, "")) || DEFAULT_API_BASE,
    platformBase:
      trim((get("AMD_PLATFORM_BASE") ?? "").replace(/\/+$/, "")) || DEFAULT_PLATFORM_BASE,
    accessToken: trim(get("ACCESS_TOKEN")),
    adminToken: trim(get("ADMIN_TOKEN")) || trim(get("ACCESS_TOKEN")),
    quotaTtlSeconds: num(get("QUOTA_TTL_SECONDS"), DEFAULT_QUOTA_TTL_SECONDS),
    maxKeyAttempts: Math.max(1, num(get("MAX_KEY_ATTEMPTS"), 3)),
    rpmLimit: num(get("RPM_LIMIT"), DEFAULT_RPM_LIMIT),
    rateCooldownSeconds: num(get("RATE_COOLDOWN_SECONDS"), 30),
    serverCooldownSeconds: num(get("SERVER_COOLDOWN_SECONDS"), 5),
    quotaProbeMinIntervalSeconds: num(get("QUOTA_PROBE_MIN_INTERVAL_SECONDS"), 10),
    cfApiToken: trim(get("CF_API_TOKEN")),
    cfAccountId: trim(get("CF_ACCOUNT_ID")),
    cfScriptName: trim(get("CF_SCRIPT_NAME")) || "amd-api-balancer",
    modelsCacheSeconds: num(get("MODELS_CACHE_SECONDS"), 120),
    basePath: trim(get("BASE_PATH")).replace(/\/+$/, ""),
    quotaCooldownCapSeconds: num(get("QUOTA_COOLDOWN_CAP_SECONDS"), 6 * 3600),
    maxBodyBytes: num(get("MAX_BODY_BYTES"), 32 * 1024 * 1024),
    probeModel: trim(get("PROBE_MODEL")),
  };
}

function trim(v: string | undefined): string {
  return (v ?? "").trim();
}

export function asString(v: unknown): string {
  if (typeof v === "string") return v;
  // JSON 里数字/布尔字段（如 maxConcurrency: 2）在配置里很常见
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

interface RawAccountEntry {
  label?: unknown;
  name?: unknown;
  apiKey?: unknown;
  key?: unknown;
  token?: unknown;
  apiBase?: unknown;
  baseUrl?: unknown;
  platformBase?: unknown;
  enabled?: unknown;
  maxConcurrency?: unknown;
}

/**
 * 解析账号配置。支持三种写法：
 *  1. JSON 数组：[{"label":"a","apiKey":"rc-..."}]
 *  2. JSON 对象：{"accounts":[...], "apiBase":"..."}
 *  3. 纯文本：每行一个 key，可用 `label=rc-xxx` 命名
 * 兼容 AMD_ACCOUNTS（首选）与旧名 AMD_API_KEYS。
 */
export function parseAccounts(env: Record<string, unknown>): AccountConfig[] {
  const cfg = readConfig(env);
  const raw =
    asString(env.AMD_ACCOUNTS) || asString(env.AMD_API_KEYS) || asString(env.AMD_API_KEY);
  if (!raw.trim()) return [];

  const entries = parseEntries(raw);
  const out: AccountConfig[] = [];
  const seen = new Set<string>();

  entries.forEach((entry, i) => {
    const apiKey =
      trim(asString(entry.apiKey)) || trim(asString(entry.key)) || trim(asString(entry.token));
    if (!apiKey || !apiKey.includes("-")) return;
    if (seen.has(apiKey)) return;
    seen.add(apiKey);

    const label = uniqueLabel(
      trim(asString(entry.label)) || trim(asString(entry.name)) || autoLabel(apiKey, i),
      seen,
    );
    seen.add(label);
    out.push({
      label,
      apiKey,
      apiBase: trim(asString(entry.apiBase)) || trim(asString(entry.baseUrl)) || cfg.apiBase,
      platformBase: trim(asString(entry.platformBase)) || cfg.platformBase,
      enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
      maxConcurrency: Math.max(
        1,
        Math.floor(num(asString(entry.maxConcurrency), DEFAULT_MAX_CONCURRENCY)),
      ),
    });
  });

  return out;
}

function parseEntries(raw: string): RawAccountEntry[] {
  const text = raw.trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text
        .split(/[\n,]/)
        .map((s) => s.replace(/[\[\]"]/g, "").trim())
        .filter(Boolean)
        .map((apiKey) => ({ apiKey }));
    }
    if (Array.isArray(parsed)) return parsed as RawAccountEntry[];
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const list = obj.accounts ?? obj.keys ?? obj.AMD_ACCOUNTS;
      if (Array.isArray(list)) return list as RawAccountEntry[];
      // {"acct-a": "rc-xxx"} 这种 map 写法
      return Object.entries(obj)
        .filter(([, v]) => typeof v === "string")
        .map(([label, apiKey]) => ({ label, apiKey: apiKey as string }));
    }
    return [];
  }
  return text
    .split(/[\n,;]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const eq = line.indexOf("=");
      if (eq > 0) {
        return { label: line.slice(0, eq).trim(), apiKey: line.slice(eq + 1).trim() };
      }
      const colon = line.indexOf(":");
      // key 本体不会包含 `:`，因此首个冒号可安全当作 label 分隔符
      if (colon > 0) {
        return { label: line.slice(0, colon).trim(), apiKey: line.slice(colon + 1).trim() };
      }
      return { apiKey: line };
    });
}

function autoLabel(apiKey: string, index: number): string {
  const tail = apiKey.slice(-4);
  return tail ? `acct-${index + 1}-${tail}` : `acct-${index + 1}`;
}

function uniqueLabel(label: string, seen: Set<string>): string {
  if (!seen.has(label)) return label;
  let i = 2;
  while (seen.has(`${label}-${i}`)) i++;
  return `${label}-${i}`;
}

/** 运行时叠加层账号（管理接口临时添加）合并到 secret 账号之上 */
export function mergeAccounts(
  base: AccountConfig[],
  overlay: AccountConfig[],
  removed: Set<string>,
): AccountConfig[] {
  const map = new Map<string, AccountConfig>();
  for (const a of base) if (!removed.has(a.label)) map.set(a.label, a);
  for (const a of overlay) {
    if (removed.has(a.label)) continue;
    map.set(a.label, { ...a, runtime: true });
  }
  return [...map.values()];
}

export function maskKey(apiKey: string): string {
  if (apiKey.length <= 10) return `${apiKey.slice(0, 2)}****`;
  return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
}

export interface RouteInfo {
  kind:
    | "chat"
    | "messages"
    | "count_tokens"
    | "models"
    | "quota"
    | "not_supported"
    | "health"
    | "dashboard"
    | "admin"
    | "unknown";
  protocol: Protocol;
  /** 转发到 apiBase 之后的路径，例如 /v1/chat/completions */
  upstreamPath: string;
  proxyable: boolean;
}

const PROXY_ROUTES: Record<string, RouteInfo["kind"]> = {
  "/v1/chat/completions": "chat",
  "/v1/chat/completion": "chat",
  "/v1/messages": "messages",
  "/v1/messages/count_tokens": "count_tokens",
  "/v1/models": "models",
  "/v1/model": "models",
};

/** 官方公共免费接口不提供的路径（直接告知，不再打上游） */
const UNSUPPORTED_PATHS: Record<string, string> = {
  "/v1/embeddings": "embeddings",
  "/v1/embedding": "embeddings",
  "/v1/completions": "legacy completions",
  "/v1/completion": "legacy completions",
  "/v1/responses": "responses",
  "/v1/images/generations": "images",
  "/v1/audio/speech": "audio",
};

/** 把 Worker 上的路径（可能带自定义前缀）解析成上游路径 */
export function resolveRoute(
  pathname: string,
  opts: { basePath?: string } = {},
): RouteInfo {
  const base = (opts.basePath ?? "").replace(/\/+$/, "");
  let rel = pathname;
  if (base && (rel === base || rel.startsWith(`${base}/`))) {
    rel = rel.slice(base.length) || "/";
  }
  // 上游同时提供 /v1/... 与 /api/v1/...，统一成 /v1/...
  rel = rel.replace(/^\/api(?=\/v1\/)/, "");

  const canonical = rel.replace(/\/+$/, "") || "/";

  if (UNSUPPORTED_PATHS[canonical]) {
    return {
      kind: "not_supported",
      protocol: "openai",
      upstreamPath: canonical,
      proxyable: false,
    };
  }

  const kind = PROXY_ROUTES[canonical];
  if (kind) {
    const protocol: Protocol = kind === "messages" || kind === "count_tokens" ? "anthropic" : "openai";
    return { kind, protocol, upstreamPath: canonical, proxyable: true };
  }
  if (canonical === "/v1/quota" || canonical === "/quota") {
    return { kind: "quota", protocol: "openai", upstreamPath: canonical, proxyable: false };
  }
  if (canonical === "/health" || canonical === "/healthz") {
    return { kind: "health", protocol: "openai", upstreamPath: canonical, proxyable: false };
  }
  if (canonical === "/" || canonical === "/dashboard" || canonical === "/ui") {
    return { kind: "dashboard", protocol: "openai", upstreamPath: canonical, proxyable: false };
  }
  if (canonical.startsWith("/admin/")) {
    return { kind: "admin", protocol: "openai", upstreamPath: canonical, proxyable: false };
  }
  return { kind: "unknown", protocol: "openai", upstreamPath: canonical, proxyable: false };
}

export function isQuotaExhaustedMessage(message: string): boolean {
  return /daily usage limit|quota exceeded|spend cap|insufficient (credit|quota|balance)|out of (credit|budget)|usage limit exceeded/i.test(
    message,
  );
}
