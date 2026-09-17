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

有两种方式，任选其一：

- **方式 A：命令行部署**（最快，首次推荐）
- **方式 B：连接 GitHub 自动部署**（改代码推上去就自动发布，见下方 2.2）

> ⚠️ 无论哪种方式，**密钥都不要写进代码或配置文件**。
> `wrangler secret put` 存的是加密的 Worker Secret，不会出现在仓库里。

### 2.1 方式 A：命令行部署

```bash
# 1. 安装依赖
npm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 写入账号池（JSON 数组，key 里含 - 和大量字符，注意整体用单引号包住）
npx wrangler secret put AMD_ACCOUNTS
# 粘贴下面这一行后回车：
# [{"label":"acct-a","apiKey":"rc-aaaa1111"},{"label":"acct-b","apiKey":"rc-bbbb2222"}]

# 4. 设置客户端访问 token（不设则任何人拿到地址都能用你的额度）
npx wrangler secret put ACCESS_TOKEN

# 5. 设置管理 token（用于 /admin/* 和看板里的管理操作）
npx wrangler secret put ADMIN_TOKEN

# 6. 部署
npm run deploy
```

> `ADMIN_TOKEN` 不填时会自动退回用 `ACCESS_TOKEN`；
> `ACCESS_TOKEN` 也不填时**接口完全开放**，请务必至少设一个。

部署完成后会得到一个地址，例如 `https://amd-api-balancer.<你的子域>.workers.dev`。

### 2.2 方式 B：连接 GitHub 自动部署

Cloudflare 的 Git 集成对**构建环境**有要求，这个项目已经调好，直接连即可。

#### 第一步：把项目推到 GitHub

```bash
git remote add origin git@github.com:<你的用户名>/amd-api-balancer.git
git push -u origin main
```

#### 第二步：在 Cloudflare 面板连接仓库

1. 打开 <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Pages/Workers**
2. 选择 **Connect to Git**，授权并选中刚推上去的仓库
3. 构建设置保持默认即可（wrangler 项目会自动识别）：
   - **Build command**：`npm ci`（或留空）
   - **Deploy command**：`npx wrangler deploy`
4. **Advanced → Build variables** 一般不用加东西
5. 点 **Deploy**

#### 第三步：配置密钥（关键，不要在仓库里配）

首次部署后，去 Worker 的 **Settings → Variables and Secrets** 添加：

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `AMD_ACCOUNTS` | **Secret** | `[{"label":"a","apiKey":"rc-..."}]` |
| `ACCESS_TOKEN` | **Secret** | 你自己定的客户端 token |
| `ADMIN_TOKEN` | **Secret** | 你自己定的管理 token |

> 必须选 **Secret** 类型，不要用普通变量：Cloudflare 把 `wrangler.jsonc` 当作配置的唯一来源，
> 面板里加的**普通变量**会在下次部署时被覆盖（官方文档的 "source of truth" 行为）。
> **Secret 不受影响**，只有 `wrangler secret delete` 才会删掉它。
> 所以密钥全部用 Secret，普通变量那么几个已经在 `wrangler.jsonc` 里了，不用在面板重复加。

#### 关于依赖源（重要）

项目的 `package-lock.json` 已把 182 个依赖全部指向官方源 `registry.npmjs.org`，
并加了项目级 `.npmrc` 锁定官方源。**务必保持这样**：

- Cloudflare 构建机在海外，访问国内镜像 `registry.npmmirror.com` 容易超时导致 `npm ci` 失败
- 不要为了本地装包快就把 lockfile 改回镜像地址再提交
- 如果你本地确实想用镜像，用命令行覆盖，不要改文件：
  `npm ci --registry=https://registry.npmmirror.com`

#### 改了代码怎么发布？

```bash
git add -A && git commit -m "update" && git push
```

推上去后 Cloudflare 会自动重新构建部署。也可以在面板里点 **Retry deployment** 手动触发。

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
| `GET /health` | 健康检查（不需要 token） |
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

通过管理接口/看板添加的账号，默认存在 **Durable Object 存储**里，重启和换实例都不会丢
（`GET /admin/accounts` 会返回 `persistent: true`；直接以库的方式实例化、没有 DO 存储时则为 `false`）。

仍推荐用 `wrangler secret put AMD_ACCOUNTS` 管理长期账号，因为：

- secret 不会出现在任何 HTTP 响应里
- 用 `wrangler.jsonc` 的版本管理更清晰

如果你想改用独立的 Workers KV（例如多脚本共享账号池），绑定一个名为 `BALANCER_KV` 的 KV 命名空间即可，会自动优先使用它。

## 八、开发与测试

```bash
npm run typecheck   # TypeScript 检查
npm test            # 单元测试（82 个）
npm run dev         # 本地跑起来
npm run tail        # 看线上日志
```

测试覆盖了额度头解析、故障分类、故障切换、认证、管理接口和持久化等关键路径。

## 九、常见问题

### Q：所有请求都返回 429 `all_keys_unavailable`？
所有 key 都在冷却或已耗尽。打开 `/dashboard` 看 `skipReason`，
如果是「今日额度已用尽」，等额度重置（看 `dailyResetAtMs`）即可。

### Q：某个 key 显示「自动禁用」？
说明它返回了 401/403，通常是 key 被撤销或复制错了。
在管理接口 `POST /admin/accounts/<label>/reset`，或看板点「启用」可恢复。

### Q：看板打开是空的 / 提示未授权？
看板顶部需要填 `ADMIN_TOKEN`，它存在浏览器 localStorage 里。

### Q：能自动重新部署吗？
设置 `CF_API_TOKEN`、`CF_ACCOUNT_ID`、`CF_SCRIPT_NAME` 后，
`POST /admin/redeploy` 会通过 Cloudflare API 触发一次部署。
