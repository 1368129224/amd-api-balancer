import { describe, expect, it } from "vitest";
import {
  maskKey,
  mergeAccounts,
  num,
  parseAccounts,
  readConfig,
  resolveRoute,
} from "../src/config";

const env = (extra: Record<string, unknown> = {}) => ({ ...extra }) as Record<string, unknown>;

describe("parseAccounts", () => {
  it("解析 JSON 数组", () => {
    const accounts = parseAccounts(
      env({
        AMD_ACCOUNTS: JSON.stringify([
          { label: "a", apiKey: "rc-aaa" },
          { label: "b", apiKey: "rc-bbb", enabled: false, maxConcurrency: 2 },
        ]),
      }),
    );
    expect(accounts).toHaveLength(2);
    expect(accounts[0]?.label).toBe("a");
    expect(accounts[0]?.enabled).toBe(true);
    expect(accounts[0]?.apiBase).toBe("https://developer.amd.com.cn/radeon/api");
    expect(accounts[1]?.enabled).toBe(false);
    expect(accounts[1]?.maxConcurrency).toBe(2);
  });

  it("解析 {accounts:[...]} 包装形式", () => {
    const accounts = parseAccounts(
      env({ AMD_ACCOUNTS: JSON.stringify({ accounts: [{ label: "x", apiKey: "rc-x" }] }) }),
    );
    expect(accounts.map((a) => a.label)).toEqual(["x"]);
  });

  it("解析 label=key 纯文本形式并兼容换行/逗号分隔", () => {
    const accounts = parseAccounts(env({ AMD_ACCOUNTS: "acct-a=rc-1\nacct-b=rc-2,acct-c=rc-3" }));
    expect(accounts.map((a) => [a.label, a.apiKey])).toEqual([
      ["acct-a", "rc-1"],
      ["acct-b", "rc-2"],
      ["acct-c", "rc-3"],
    ]);
  });

  it("纯 key 列表自动生成 label 且同名去重", () => {
    const accounts = parseAccounts(env({ AMD_ACCOUNTS: "rc-aaaa1111\nrc-bbbb2222" }));
    expect(accounts).toHaveLength(2);
    expect(accounts[0]?.label).toMatch(/^acct-1-/);
    expect(accounts[1]?.label).toMatch(/^acct-2-/);
  });

  it("去重相同 key，忽略空值与裸 token", () => {
    const accounts = parseAccounts(
      env({
        AMD_ACCOUNTS: JSON.stringify([
          { label: "a", apiKey: "rc-same" },
          { label: "b", apiKey: "rc-same" },
          { label: "c", apiKey: "" },
        ]),
      }),
    );
    expect(accounts).toHaveLength(1);
  });

  it("兼容 AMD_API_KEYS / AMD_API_KEY 旧名", () => {
    expect(parseAccounts(env({ AMD_API_KEYS: "rc-legacy1" }))).toHaveLength(1);
    expect(parseAccounts(env({ AMD_API_KEY: "rc-legacy2" }))).toHaveLength(1);
  });

  it("没有配置时返回空数组", () => {
    expect(parseAccounts(env())).toEqual([]);
  });
});

describe("readConfig", () => {
  it("默认值", () => {
    const cfg = readConfig(env());
    expect(cfg.apiBase).toBe("https://developer.amd.com.cn/radeon/api");
    expect(cfg.platformBase).toBe("https://radeon-global.anruicloud.com");
    expect(cfg.quotaTtlSeconds).toBe(60);
    expect(cfg.maxKeyAttempts).toBe(3);
    expect(cfg.rpmLimit).toBe(20);
    expect(cfg.basePath).toBe("");
  });

  it("覆盖 + 去掉末尾斜杠", () => {
    const cfg = readConfig(
      env({
        AMD_API_BASE: "https://example.com/api/",
        AMD_PLATFORM_BASE: "https://platform.example.com/",
        QUOTA_TTL_SECONDS: "15",
        BASE_PATH: "/amd/",
        ACCESS_TOKEN: "tok",
        ADMIN_TOKEN: "adm",
      }),
    );
    expect(cfg.apiBase).toBe("https://example.com/api");
    expect(cfg.platformBase).toBe("https://platform.example.com");
    expect(cfg.quotaTtlSeconds).toBe(15);
    expect(cfg.basePath).toBe("/amd");
    expect(cfg.accessToken).toBe("tok");
    expect(cfg.adminToken).toBe("adm");
  });

  it("非法数字回落到默认值", () => {
    expect(num("abc", 7)).toBe(7);
    expect(num("-1", 7)).toBe(7);
    expect(num("", 7)).toBe(7);
    expect(num("0", 7)).toBe(0);
  });
});

describe("mergeAccounts", () => {
  const base = [
    { label: "a", apiKey: "rc-a", apiBase: "u", platformBase: "p", enabled: true, maxConcurrency: 6 },
  ];
  const overlay = [
    { label: "b", apiKey: "rc-b", apiBase: "u", platformBase: "p", enabled: true, maxConcurrency: 6 },
  ];

  it("叠加运行时账号", () => {
    const merged = mergeAccounts(base, overlay, new Set());
    expect(merged.map((a) => a.label)).toEqual(["a", "b"]);
    expect(merged[1]?.runtime).toBe(true);
  });

  it("removed 集合隐藏 secret 账号", () => {
    expect(mergeAccounts(base, overlay, new Set(["a"])).map((a) => a.label)).toEqual(["b"]);
  });

  it("运行时账号可覆盖同名 secret 账号", () => {
    const merged = mergeAccounts(
      base,
      [{ ...overlay[0]!, label: "a", apiKey: "rc-a2" }],
      new Set(),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.apiKey).toBe("rc-a2");
  });
});

describe("maskKey", () => {
  it("隐藏中间部分", () => {
    expect(maskKey("rc-4f8a19c7e02b6d3a5c81f70e9b2d4a6c38e5b1907f2c4d8a")).toBe("rc-4f8…4d8a");
    expect(maskKey("short")).toBe("sh****");
  });
});

describe("resolveRoute", () => {
  const cases: Array<[string, string]> = [
    ["/v1/chat/completions", "chat"],
    ["/api/v1/chat/completions", "chat"],
    ["/v1/messages", "messages"],
    ["/v1/messages/count_tokens", "count_tokens"],
    ["/v1/models", "models"],
    ["/v1/quota", "quota"],
    ["/health", "health"],
    ["/", "dashboard"],
    ["/dashboard", "dashboard"],
    ["/admin/accounts", "admin"],
    ["/v1/embeddings", "not_supported"],
    ["/v1/completions", "not_supported"],
    ["/v1/responses", "not_supported"],
    ["/nope", "unknown"],
  ];

  for (const [path, kind] of cases) {
    it(`${path} → ${kind}`, () => {
      expect(resolveRoute(path).kind).toBe(kind);
    });
  }

  it("anthropic 协议判定", () => {
    expect(resolveRoute("/v1/messages").protocol).toBe("anthropic");
    expect(resolveRoute("/v1/messages/count_tokens").protocol).toBe("anthropic");
    expect(resolveRoute("/v1/chat/completions").protocol).toBe("openai");
  });

  it("支持 BASE_PATH 前缀", () => {
    const route = resolveRoute("/amd/v1/chat/completions", { basePath: "/amd" });
    expect(route.kind).toBe("chat");
    expect(route.upstreamPath).toBe("/v1/chat/completions");
  });
});
