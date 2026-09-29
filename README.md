# AMD AI Key Balancer

把多个 AMD Radeon Cloud（`developer.amd.com.cn`）的免费 API key 组成一个账号池，
对外暴露成**一个** OpenAI / Anthropic 兼容端点，自动做这些事：

- **按剩余额度调度**：优先用今日美元额度剩得最多的 key
- **额度耗尽自动切换**：某个 key 触发 429 / 每日额度用尽，立即冷却并换下一个，客户端无感
- **失效自动禁用**：401/403（key 无效）直接把该 key 下线，不再浪费请求
- **中文额度看板**：`/dashboard` 实时查看每个 key 的剩余额度、今日用量、冷却状态
- **管理接口**：增删账号、启停、探测额度、查看事件日志

底层基于 Cloudflare Workers + Durable Object，用 Docker 可以**一键本地部署或一键发布**。

---

## 一、先准备 AMD API Key

1. 到 <https://developer.amd.com.cn> 注册并申请 Radeon Cloud 的 API key（`rc-` 开头）
2. 每个账号默认有**每日美元额度**（Daily Spend Cap），这正是本项目的调度依据
3. 把你的 key 收集起来，形如 `rc-xxxxxxxxxxxxxxxx`

## 二、部署

三种方式任选其一：

| 方式 | 特点 | 适合 |
| --- | --- | --- |
| **方式一：Docker** | 一个命令跑起来，不需要配本地 Node 环境 | 快速试用、本地私有部署 |
| **方式二：连接 GitHub** | 推代码即自动发布，长期维护无需手动操作 | 长期使用、团队共享 |
| **方式三：命令行** | 直接 `wrangler deploy` | 熟悉 Cloudflare 的用户 |

> ⚠️ 密钥不要写进代码或配置文件，全部用环境变量或 Secret 存。

---

### 方式一：Docker（推荐快速上手）

#### 本地运行

无需 Cloudflare 账号，`wrangler dev` 在容器里模拟 Workers 运行时。

```bash
# 1. 复制配置文件
cp .env.example .env

# 2. 编辑 .env，填入你的 key 和 token（必填 AMD_ACCOUNTS，建议填 ACCESS_TOKEN）
vi .env  # 或用任意编辑器

# 3. 启动
docker compose up -d

# 4. 查看日志
docker compose logs -f dev
```

访问 `http://localhost:8787/dashboard` 打开额度看板，`http://localhost:8787/health` 验证配置。

**数据持久化**：Durable Object 状态存在 Docker volume `wrangler-state` 里，
容器重建不会丢失运行时账号和额度缓存。

#### 部署到 Cloudflare（Docker 一键发布）

如果你想把服务跑在 Cloudflare 边缘网络（免费额度内基本够用）：

```bash
# .env 里再补充 Cloudflare 认证信息
# CLOUDFLARE_API_TOKEN=xxx   在 https://dash.cloudflare.com/profile/api-tokens 生成
# CLOUDFLARE_ACCOUNT_ID=xxx  在 Workers 概览页右上角可以找到

# 一键注入 Secret + 部署
docker compose run --rm deploy
```

`deploy` 服务会自动把 `.env` 里的 `AMD_ACCOUNTS`、`ACCESS_TOKEN`、`ADMIN_TOKEN`
注入为 Cloudflare Secret，然后执行 `wrangler deploy`。

> ℹ️ **Token 权限要求**：Workers Scripts:Edit + Workers Routes:Edit + Account Settings:Read

#### 改了代码怎么发布？

```bash
docker compose run --rm deploy
```

每次改完代码跑一遍即可，没有额外步骤。

---

### 方式二：连接 GitHub 仓库自动部署

Cloudflare 的 Git 集成，推代码自动触发构建部署，适合长期维护。

#### 1. 把项目推到 GitHub

```bash
git remote add origin <你的仓库地址>
git push -u origin main
```

#### 2. 在 Cloudflare 连接仓库

1. 打开 <https://dash.cloudflare.com> → **Workers & Pages** → **Create**
2. 选 **Connect to Git**，授权并选中仓库
3. 构建设置保持默认（自动识别 wrangler 项目），点 **Deploy**

> 如果还没设 Secret，**这次构建会失败**（提示缺 `AMD_ACCOUNTS`），这是预期的，见下一步。

#### 3. 配置密钥，然后重新部署

去 Worker 的 **Settings → Variables and Secrets**，添加：

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `AMD_ACCOUNTS` | **Secret** | `[{"label":"a","apiKey":"rc-..."}]` |
| `ACCESS_TOKEN` | **Secret** | 你自己定的客户端 token |
| `ADMIN_TOKEN` | **Secret** | 你自己定的管理 token（可省） |

加完后回到构建记录点 **Retry deployment** 即可。

> **必须选 Secret 类型**，不要用普通 `Variables`：`wrangler.jsonc` 的 `vars` 是明文变量的
> 唯一真源，每次部署都会把面板上加的明文变量覆盖掉，Secret 不受影响。

#### 改了代码怎么发布？

```bash
git add -A && git commit -m "update" && git push
```

推上去后 Cloudflare 自动重新构建部署。

---

### 方式三：命令行部署

适合已经熟悉 Cloudflare Workers 工具链的用户。

```bash
npm install
npx wrangler login

# 先注入 Secret（Worker 不存在时 wrangler 会自动新建一个空 Worker）
npx wrangler secret put AMD_ACCOUNTS
# 粘贴：[{"label":"acct-a","apiKey":"rc-aaaa1111"},{"label":"acct-b","apiKey":"rc-bbbb2222"}]

npx wrangler secret put ACCESS_TOKEN
npx wrangler secret put ADMIN_TOKEN   # 可省

# 再部署
npm run deploy
```

> **顺序很重要**：先设 Secret，再 `npm run deploy`。若先 deploy 后 secret put，
> 构建会因 `secrets.required` 校验失败。备选方案：`wrangler deploy --secrets-file .env`

---

### 本地开发（无 Docker）

```bash
cp .dev.vars.example .dev.vars   # 填好本地用的 key 和 token
npm run dev
```

## 三、开始使用

把客户端里的 base_url 指向你的服务地址，token 填 `ACCESS_TOKEN`。

### OpenAI SDK / 兼容客户端

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://amd-api-balancer.<你的子域>.workers.dev/v1",
    api_key="你的 ACCESS_TOKEN",     # 不是 rc- key，balancer 会替换成池子里的 key
)

resp = client.chat.completions.create(
    model="DeepSeek-V4-Flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

本地 Docker 方式把地址换成 `http://localhost:8787/v1` 即可。

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

浏览器打开 `/dashboard`，点右上角齿轮 ⚙️ 图标打开设置面板，填入 `ADMIN_TOKEN` 即可看到额度并提供增删/启停按钮。

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
点右上角齿轮 ⚙️ 图标打开设置面板，填入 `ADMIN_TOKEN` 或 `ACCESS_TOKEN`。
Token 保存在浏览器 localStorage，刷新页面不会丢失。

### Q：能自动重新部署吗？
设置 `CF_API_TOKEN`、`CF_ACCOUNT_ID`、`CF_SCRIPT_NAME` 后，
`POST /admin/redeploy` 会通过 Cloudflare API 触发一次部署。
Docker 方式也可以直接跑 `docker compose run --rm deploy`。
