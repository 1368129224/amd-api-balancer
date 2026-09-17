/** 上游 AMD AI (Radeon Cloud) 公共免费模型 API 默认地址 */
export const DEFAULT_API_BASE = "https://developer.amd.com.cn/radeon/api";
/** 平台 API（额度查询 /api/profile/model-usage）默认地址 */
export const DEFAULT_PLATFORM_BASE = "https://radeon-global.anruicloud.com";

export const DEFAULT_MAX_CONCURRENCY = 6; // 官方每 key 并发上限 8，留 2 余量
export const DEFAULT_RPM_LIMIT = 20; // gateway 每账号每分钟请求数
export const DEFAULT_MAX_KEY_ATTEMPTS = 3;
export const DEFAULT_QUOTA_TTL_SECONDS = 60;

export type Protocol = "openai" | "anthropic";

export interface AccountConfig {
  label: string;
  apiKey: string;
  apiBase: string;
  platformBase: string;
  enabled: boolean;
  maxConcurrency: number;
  /** true = 来自运行时管理接口（非 secret），进程重启后丢失 */
  runtime?: boolean;
}

export interface QuotaSnapshot {
  /** 数据来源 */
  source: "usage-endpoint" | "response-headers";
  /** usage 接口的 status 字段：ok | not_configured | not_available */
  status?: string;
  rpmLimit?: number;
  rpmRemaining?: number;
  dailyUsdLimit?: number;
  dailyUsdUsed?: number;
  dailyUsdRemaining?: number;
  /** 本额度周期重置时刻（毫秒 epoch） */
  dailyResetAtMs?: number;
  dailyResetTimezone?: string;
  todayRequests?: number;
  todayErrors?: number;
  todayTokens?: number;
  todayCostUsd?: number;
  last30DaysCostUsd?: number;
  allTimeCostUsd?: number;
  byModel?: Array<{ model: string; requests: number; totalTokens: number; costUsd: number }>;
  /** 本地观测时间（毫秒 epoch） */
  observedAtMs: number;
}

export interface AccountState {
  quota?: QuotaSnapshot;
  quotaFetchedAtMs: number;
  quotaError?: string;
  cooldownUntilMs: number;
  cooldownReason?: string;
  /** true = 判定为永久失效（401/403），除非管理员手动启用 */
  disabled: boolean;
  disableReason?: string;
  /** 每个在途调度租约的过期时刻（毫秒）；长度 = 当前并发数 */
  leases: number[];
  lastUsedAtMs: number;
  /** 最近请求时间戳（毫秒），用于本地 RPM 限速 */
  recentRequests: number[];
  totalRequests: number;
  totalRetries: number;
  totalErrors: number;
  lastError?: string;
  lastStatus?: number;
}

export interface AccountView {
  label: string;
  keyMasked: string;
  enabled: boolean;
  runtime: boolean;
  disabled: boolean;
  disableReason?: string;
  coolingDown: boolean;
  cooldownReason?: string;
  cooldownRemainingSeconds: number;
  inFlight: number;
  maxConcurrency: number;
  lastUsedAtMs: number;
  totalRequests: number;
  totalRetries: number;
  totalErrors: number;
  lastError?: string;
  lastStatus?: number;
  apiBase: string;
  quota: QuotaSnapshot | null;
  quotaAgeSeconds: number | null;
  /** 是否可被调度 */
  schedulable: boolean;
  /** 不可调度原因 */
  skipReason?: string;
}

export interface QuotaReport {
  generatedAtMs: number;
  quotaTtlSeconds: number;
  totals: {
    accounts: number;
    schedulable: number;
    dailyUsdLimit?: number;
    dailyUsdUsed?: number;
    dailyUsdRemaining?: number;
    earliestResetAtMs?: number;
    todayRequests: number;
    todayTokens: number;
  };
  accounts: AccountView[];
  /** 被管理接口隐藏的 secret 账号 label */
  hiddenAccounts: string[];
  /** 运行时添加（非 secret KV 持久）的账号 label */
  runtimeAccounts: string[];
  /** 探测/列表使用的模型 */
  probeModel?: string;
}
