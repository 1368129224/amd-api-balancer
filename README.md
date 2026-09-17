# AMD AI Key Balancer

把多个 AMD Radeon Cloud（`developer.amd.com.cn`）的免费 API key 组成一个账号池，
对外暴露成**一个** OpenAI / Anthropic 兼容端点，自动做这些事：

- **按剩余额度调度**：优先用今日美元额度剩得最多的 key
- **额度耗尽自动切换**：某个 key 触发 429 / 每日额度用尽，立即冷却并换下一个，客户端无感
- **失效自动禁用**：401/403（key 无效）直接把该 key 下线，不再浪费请求
- **中文额度看板**：`/dashboard` 实时查看每个 key 的剩余额度、今日用量、冷却状态
- **管理接口**：增删账号、启停、探测额度、查看事件日志

部署在 Cloudflare Workers 上，用 Durable Object 保存跨实例的调度状态（冷却、并发租约、额度缓存）。

---

## 一、先准备 AMD API Key

1. 到 <https://developer.amd.com.cn> 注册并申请 Radeon Cloud 的 API key（`rc-` 开头）
2. 每个账号默认有**每日美元额度**（Daily Spend Cap），这正是本项目的调度依据
3. 把你的 key 收集起来，形如 `rc-xxxxxxxxxxxxxxxx`

## 二、部署

两种方式任选其一：

- **方式一：连接 GitHub 仓库** —— 推代码即自动发布，适合长期使用（推荐）
- **方式二：命令行部署** —— 无需仓库，本地几条命令跑起来，适合先试用

> ⚠️ 密钥不要写进代码或配置文件，全部用 **Secret** 存。
> 两种方式配的是**同一个 Worker 的同一份 Secret**，可以先用方式二跑起来，
> 之后随时接上方式一，无需迁移。

### 方式一：连接 GitHub 仓库自动部署

Cloudflare 的 Git 集成对构建环境有要求，本项目已经调好（见下方「依赖源」），直接连即可。

#### 1. 把项目推到 GitHub

Fork 本项目，或推到你自己的仓库：

```bash
git remote add origin <你的仓库地址>
git push -u origin main
```

#### 2. 在 Cloudflare 连接仓库

1. 打开 <https://dash.cloudflare.com> → **Workers & Pages** → **Create**
2. 选 **Connect to Git**，授权并选中刚推上去的仓库
3. 构建设置保持默认即可（wrangler 项目会自动识别）：
   - **Build command**：`npm ci`
   - **Deploy command**：`npx wrangler deploy`
4. 点 **Deploy**

> 如果还没设 Secret，**这次构建会失败**，提示缺 `AMD_ACCOUNTS`/`ACCESS_TOKEN`。
> 这是预期的，原因和后续操作见下一步。

#### 3. 配置密钥，然后重新部署

去 Worker 的 **Settings → Variables and Secrets**，添加：

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `AMD_ACCOUNTS` | **Secret** | `[{"label":"a","apiKey":"rc-..."}]` |
| `ACCESS_TOKEN` | **Secret** | 你自己定的客户端 token |
| `ADMIN_TOKEN` | **Secret** | 你自己定的管理 token（可省） |

`ADMIN_TOKEN` 不填时会自动回退用 `ACCESS_TOKEN`；
`ACCESS_TOKEN` 也不填时**接口完全开放**，请务必至少设一个。

加完后回到构建记录点 **Retry deployment**（或随便推一次提交）即完成首次部署。

> **为什么第 2 步的构建必然失败**：`wrangler.jsonc` 声明了
> `secrets.required = ["AMD_ACCOUNTS", "ACCESS_TOKEN"]`，Secret 没配时构建会直接失败并指名缺哪个。
> 失败日志里会建议你跑 `wrangler secret put`，但**走 Git 集成时不用理它** ——
> 在面板里加 Secret 即可，下次构建会自动读到。
> 这是刻意设计的 —— 以前 Secret 漏配时部署会「成功」，但 Worker 起来没有密钥，表现为
> `/health` 里 `accounts: 0`、`auth_required: false`，很难看出是漏配。现在会当场拦住。
>
> **必须选 Secret 类型**，不要用普通 `Variables`：`wrangler.jsonc` 的 `vars` 是明文变量的唯一真源，
> 每次部署都会把面板上加的明文变量覆盖掉，Secret 不受影响。
> 另外，**构建日志不会列出 Secret**（Cloudflare 的既定行为），日志里看不到 Secret 属正常，
> 是否真的到达 Worker 要看 `/health` 的 `env` 字段。

#### 改了代码怎么发布？

```bash
git add -A && git commit -m "update" && git push
```

推上去后 Cloudflare 会自动重新构建部署，也可以在面板里点 **Retry deployment** 手动触发。

#### 依赖源（重要）

`package-lock.json`（182 个依赖）和项目级 `.npmrc` 都已指向官方源 `registry.npmjs.org`。
Cloudflare 构建机在海外，用国内镜像容易超时导致 `npm ci` 失败，所以**不要改回镜像地址**。
本地确实想用镜像时，用命令行参数覆盖，别改文件：

```bash
npm ci --registry=https://registry.npmmirror.com
```

### 方式二：命令行部署

```bash
npm install
npx wrangler login

# 账号池：JSON 数组，整体用单引号包住（key 里含 - 和大量字符）
# 注：Worker 还不存在时，wrangler 会问你要不要新建一个，选“是”即可
npx wrangler secret put AMD_ACCOUNTS
# 粘贴下面这一行后回车：
# [{"label":"acct-a","apiKey":"rc-aaaa1111"},{"label":"acct-b","apiKey":"rc-bbbb2222"}]

# 客户端访问 token（不设则任何人拿到地址都能用你的额度）
npx wrangler secret put ACCESS_TOKEN

# 管理 token（用于 /admin/* 和看板里的管理操作，可不填）
npx wrangler secret put ADMIN_TOKEN

npm run deploy
```

部署完会得到地址，例如 `https://amd-api-balancer.<你的子域>.workers.dev`。

> 顺序很重要：**先设 Secret，再 `npm run deploy`**（原因见方式一第 3 步）。
> 若你跳过了 `secret put`，报错会提示改用 `wrangler deploy --secrets-file <文件>` 一次性带上。

### 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填好本地用的 key 和 token
npm run dev
```

## 三、开始使用

把客户端里的 base_url 指向你的 Worker，token 填 `ACCESS_TOKEN`。

### OpenAI SDK / 兼容客户端

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://amd-api-balancer.<你的子域>.workers.dev/v1",
    api_key="你的 ACCESS_TOKEN",          # 不是 rc- key，balancer 会替换成池子里的 key
)

resp = client.chat.completions.create(
    model="DeepSeek-V4-Flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

### Claude Code / Anthropic 兼容

```bash
export ANTHROPIC_BASE_URL="https://amd-api-balancer.<你的子域>.workers.dev"
export ANTHROPIC_AUTH_TOKEN="你的 ACCESS_TOKEN"
claude
```

### curl

```bash
curl https://amd-api-balancer.<你的子域>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "content-type: application/json" \
  -d '{"model":"DeepSeek-V4-Flash","messages":[{"role":"user","content":"hi"}]}'
```

### 查看额度看板

浏览器打开 `https://amd-api-balancer.<你的子域>.workers.dev/dashboard`，
在页面顶部填入 `ADMIN_TOKEN` 即可看到额度并提供增删/启停按钮。

## 四、接口一览

| 路径 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI 协议（支持 `stream: true` 透传） |
| `POST /v1/messages` | Anthropic 协议 |
| `POST /v1/messages/count_tokens` | Anthropic token 计数 |
| `GET /v1/models` | 模型列表（带 120s 缓存） |
| `GET /v1/quota` | 额度 JSON（看板数据源），`?refresh=1` 强制刷新 |
| `GET /dashboard` | 中文额度看板 |
| `GET /health` | 健康检查（不需要 token，含环境变量注入诊断） |
| `GET /admin/accounts` | 账号列表 + 调度状态 |
| `POST /admin/accounts` | 添加账号 `{"label":"x","apiKey":"rc-..."}` |
| `POST /admin/accounts/delete` | 删除/隐藏账号 `{"label":"x"}` |
| `POST /admin/accounts/<label>/enabled` | 启停 `{"enabled":false}` |
| `POST /admin/accounts/<label>/reset` | 清除冷却与禁用状态 |
| `POST /admin/test` | 立即探测某账号额度 `{"label":"x"}` |
| `POST /admin/refresh` | 刷新全部账号额度 |
| `GET /admin/config` | 查看当前生效配置 |
| `POST /admin/redeploy` | 调 Cloudflare API 重新部署（需额外配置） |

> `/v1/embeddings`、`/v1/completions` 等 AMD 公共免费接口**并未提供**，
> 本项目会明确返回 404 而不是静默失败。

### 响应里的调度信息

每个代理响应都会带上这些头，方便排查是哪个 key 在服务：

```http
x-amd-account: acct-b               # 实际使用的账号
x-amd-attempt: 2                    # 第几次尝试才成功（1 = 没换过）
x-amd-quota-remaining-usd: 7.5      # 该账号今日剩余额度
x-amd-pool-remaining-usd: 18.2      # 整个池子剩余额度
x-amd-pool-accounts: 3              # 当前可用账号数
```

## 五、调度规则

1. **选谁**：按「剩余额度最多的优先」排序；额度未知的次之；已耗尽的排最后兜底
2. **并发与限流**：单 key 并发默认上限 6，每分钟请求上限默认 20（会按上游返回的真实 RPM 调整）
3. **失败怎么办**：
   - `429 每日额度用尽` → 冷却到额度重置时刻（最长 6 小时），换下一个 key
   - `429 限流` → 按 `Retry-After` 冷却（默认 30 秒），换下一个 key
   - `401/403` → 直接禁用该 key
   - `5xx` / 网络错误 → 短暂冷却（默认 5 秒），换下一个 key
   - `400` 等参数错误 → **不换 key**，原样返回给客户端
4. **额度怎么来**：优先调平台 `model-usage` 接口（免费），
   同时从每次推理响应的 `X-RateLimit-*-User-Daily-USD` 头实时更新（更及时）
5. **定时刷新**：cron 每 10 分钟刷新一次额度，保证看板和调度数据新鲜

## 六、可配置的环境变量

改 `wrangler.jsonc` 的 `vars`（或 `wrangler secret put`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AMD_ACCOUNTS` | — | 账号池 JSON（用 secret 存） |
| `ACCESS_TOKEN` | — | 客户端访问 token（用 secret 存） |
| `ADMIN_TOKEN` | 回退到 ACCESS_TOKEN | 管理接口 token（用 secret 存） |
| `AMD_API_BASE` | `https://developer.amd.com.cn/radeon/api` | 推理上游 |
| `AMD_PLATFORM_BASE` | `https://radeon-global.anruicloud.com` | 额度查询上游 |
| `QUOTA_TTL_SECONDS` | `60` | 额度缓存时长 |
| `MAX_KEY_ATTEMPTS` | `3` | 单次请求最多尝试几个 key |
| `RPM_LIMIT` | `20` | 单 key 每分钟请求上限 |
| `RATE_COOLDOWN_SECONDS` | `30` | 限流冷却时长 |
| `SERVER_COOLDOWN_SECONDS` | `5` | 5xx 冷却时长 |
| `MAX_BODY_BYTES` | `33554432` | 请求体上限（32MB） |
| `BASE_PATH` | 空 | 部署在子路径时使用 |
| `PROBE_MODEL` | 自动探测 | 额度兜底探测用的模型 |

## 七、账号持久化说明

通过管理接口/看板添加的账号存在 **Durable Object 存储**里，重启和换实例都不会丢
（`GET /admin/accounts` 返回 `persistent: true`）。仍推荐用 Secret 管理长期账号，
因为它不会出现在任何 HTTP 响应里，也更便于版本管理。
想改用独立 Workers KV（例如多脚本共享账号池），绑定名为 `BALANCER_KV` 的命名空间即可自动优先使用。

## 八、开发与测试

```bash
npm run typecheck   # TypeScript 检查
npm test            # 单元测试
npm run dev         # 本地跑起来
npm run tail        # 看线上日志
```

测试覆盖了额度头解析、故障分类、故障切换、认证、管理接口、看板脚本和持久化等关键路径。

## 九、常见问题

### Q：所有请求都返回 429 `all_keys_unavailable`？
所有 key 都在冷却或已耗尽。打开 `/dashboard` 看 `skipReason`，
如果是「今日额度已用尽」，等额度重置（看 `dailyResetAtMs`）即可。

### Q：`/health` 显示 `accounts: 0`？
先看 `env` 字段（只报布尔值，不输出密钥）：

```json
{ "accounts": 0, "auth_required": false,
  "env": { "AMD_ACCOUNTS": false, "ACCESS_TOKEN": false } }
```

- `env.AMD_ACCOUNTS` 为 `false` → 值没到 Worker：多半是加成了明文 `Variables`
  （会被下次部署覆盖，应改成 **Secret**），或加完没点 **Deploy**。
- 为 `true` 但 `accounts` 仍是 `0` → 值到了但解析失败，会附带 `accountsHint`。
  检查是否为合法 JSON（别用单引号包裹、别留尾逗号），且 key 里含 `-`。

### Q：某个 key 显示「自动禁用」？
说明它返回了 401/403，通常是 key 被撤销或复制错了。
在管理接口 `POST /admin/accounts/<label>/reset`，或看板点「启用」可恢复。

### Q：看板打开是空的 / 提示未授权？
看板顶部需要填 `ADMIN_TOKEN`，它存在浏览器 localStorage 里。

### Q：能自动重新部署吗？
设置 `CF_API_TOKEN`、`CF_ACCOUNT_ID`、`CF_SCRIPT_NAME` 后，
`POST /admin/redeploy` 会通过 Cloudflare API 触发一次部署。
