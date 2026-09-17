import type { AccountConfig } from "./types";

export interface KvLike {
  get<T = unknown>(key: string, opts?: { type?: "json" | "text" }): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
}

interface OverlayShape {
  version: number;
  updatedAtMs: number;
  accounts: AccountConfig[];
}

/**
 * 运行时账号叠加层：管理接口添加/停用/隐藏的账号存放在这里。
 * 绑定了 BALANCER_KV 就持久化（跨实例、跨重启）；否则只存在于当前 Durable Object 内存中。
 */
export class RuntimeKeyStore {
  private memory: AccountConfig[] = [];
  private removed = new Set<string>();
  private loaded = false;

  constructor(
    private kv?: KvLike,
    private now: () => number = () => Date.now(),
  ) {}

  static fromEnv(env: Record<string, unknown>, fallback?: KvLike): RuntimeKeyStore {
    const candidate = env.BALANCER_KV as KvLike | undefined;
    const usable =
      candidate && typeof candidate.get === "function" && typeof candidate.put === "function"
        ? candidate
        : undefined;
    return new RuntimeKeyStore(usable ?? fallback);
  }

  get persistent(): boolean {
    return this.kv !== undefined;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.kv) return;
    try {
      const [overlay, removed] = await Promise.all([
        this.kv.get<OverlayShape>("balancer:overlay", { type: "json" }),
        this.kv.get<{ labels: string[] }>("balancer:removed", { type: "json" }),
      ]);
      const accounts = Array.isArray(overlay?.accounts) ? overlay.accounts : [];
      this.memory = accounts.filter((a) => a && typeof a.apiKey === "string");
      this.removed = new Set(Array.isArray(removed?.labels) ? removed.labels : []);
    } catch {
      this.memory = [];
      this.removed = new Set();
    }
  }

  private async persist(): Promise<void> {
    if (!this.kv) return;
    const overlay: OverlayShape = {
      version: 1,
      updatedAtMs: this.now(),
      accounts: this.memory,
    };
    await Promise.all([
      this.kv.put("balancer:overlay", JSON.stringify(overlay)),
      this.kv.put("balancer:removed", JSON.stringify({ labels: [...this.removed] })),
    ]);
  }

  async list(): Promise<AccountConfig[]> {
    await this.load();
    return this.memory.map((a) => ({ ...a, runtime: true }));
  }

  async removedLabels(): Promise<string[]> {
    await this.load();
    return [...this.removed];
  }

  async upsert(account: AccountConfig): Promise<void> {
    await this.load();
    this.removed.delete(account.label);
    this.memory = this.memory.filter((a) => a.label !== account.label);
    this.memory.push({ ...account, runtime: true });
    await this.persist();
  }

  async remove(label: string, secretLabels: Set<string>): Promise<boolean> {
    await this.load();
    const existed = this.memory.some((a) => a.label === label) || secretLabels.has(label);
    this.memory = this.memory.filter((a) => a.label !== label);
    if (secretLabels.has(label)) this.removed.add(label);
    await this.persist();
    return existed;
  }

  async restore(label: string): Promise<boolean> {
    await this.load();
    const had = this.removed.delete(label);
    if (had) await this.persist();
    return had;
  }

  /** 停用/启用：运行时账号改自身，secret 账号写一条覆盖记录 */
  async setEnabled(label: string, enabled: boolean, base: AccountConfig[]): Promise<boolean> {
    await this.load();
    const runtime = this.memory.find((a) => a.label === label);
    if (runtime) {
      runtime.enabled = enabled;
      await this.persist();
      return true;
    }
    const source = base.find((a) => a.label === label);
    if (!source) return false;
    this.removed.delete(label);
    this.memory.push({ ...source, enabled, runtime: true });
    await this.persist();
    return true;
  }

  async reset(): Promise<void> {
    await this.load();
    this.memory = [];
    this.removed = new Set();
    await this.persist();
  }
}
