/** 内置单文件额度看板（无外部依赖） */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AMD AI Key Balancer</title>
<style>
  :root{
    --bg:#0b0f14; --panel:#131a23; --panel2:#0f151d; --line:#1f2a37;
    --fg:#e6edf3; --dim:#8b98a5; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#ff1e56;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,"Helvetica Neue",monospace}
  header{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
  h1{font-size:15px;margin:0;letter-spacing:.04em;text-transform:uppercase}
  h1 span{color:var(--accent)}
  .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  input,select,button,textarea{font:inherit;background:var(--panel2);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:7px 10px}
  input:focus,textarea:focus{outline:1px solid var(--accent)}
  button{cursor:pointer}
  button:hover{border-color:var(--accent)}
  button.danger:hover{color:var(--bad)}
  main{padding:20px 22px 60px;max-width:1280px;margin:0 auto}
  .totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}
  .card .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .card .v{font-size:22px;margin-top:6px;font-variant-numeric:tabular-nums}
  .grid{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .grid th,.grid td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
  .grid th{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:500;background:var(--panel2)}
  .grid tr:last-child td{border-bottom:none}
  .num{font-variant-numeric:tabular-nums;text-align:right}
  .tag{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;border:1px solid var(--line);color:var(--dim)}
  .tag.ok{color:var(--ok);border-color:#1f4d29}
  .tag.warn{color:var(--warn);border-color:#5a4510}
  .tag.bad{color:var(--bad);border-color:#5c1f1d}
  .meter{height:6px;background:#0a0f14;border-radius:4px;overflow:hidden;margin-top:6px;min-width:120px}
  .meter i{display:block;height:100%}
  .muted{color:var(--dim)}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .err{color:var(--bad);word-break:break-all}
  details{margin-top:18px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px}
  summary{cursor:pointer;color:var(--dim)}
  pre{overflow:auto;background:var(--panel2);padding:12px;border-radius:6px;border:1px solid var(--line);font-size:12px}
  .toast{position:fixed;right:16px;bottom:16px;max-width:420px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);padding:10px 14px;border-radius:6px;opacity:0;transition:opacity .2s;pointer-events:none}
  .toast.show{opacity:1}
  @media(max-width:720px){ .grid thead{display:none} .grid td{display:block;border:none;padding:4px 10px} .grid tr{display:block;border-bottom:1px solid var(--line);padding:8px 0} }
</style>
</head>
<body>
<header>
  <h1><span>&#9679;</span> AMD AI Key Balancer</h1>
  <div class="bar">
    <input id="token" type="password" placeholder="access / admin token" size="22" autocomplete="off">
    <select id="interval">
      <option value="0">手动刷新</option>
      <option value="15000">15s</option>
      <option value="60000" selected>60s</option>
      <option value="300000">5min</option>
    </select>
    <button id="refresh">刷新额度</button>
    <button id="probe" title="向每个账号发一个 max_tokens=1 的探测请求">主动探测</button>
    <button id="redeploy" class="danger" title="需要配置 CF_API_TOKEN / CF_ACCOUNT_ID">重新部署</button>
  </div>
</header>
<main>
  <div class="totals" id="totals"></div>
  <table class="grid">
    <thead><tr>
      <th>账号</th><th>状态</th><th class="num">今日已用</th><th class="num">剩余</th>
      <th>额度进度</th><th class="num">重置</th><th class="num">RPM</th><th class="num">今日请求</th>
      <th class="num">并发</th><th class="num">本进程</th><th>操作</th>
    </tr></thead>
    <tbody id="rows"><tr><td colspan="11" class="muted">加载中…</td></tr></tbody>
  </table>

  <details>
    <summary>账号管理（新增 / 删除 / 启停）</summary>
    <div class="row" style="margin-top:12px">
      <input id="newLabel" placeholder="label，可留空自动生成" size="18">
      <input id="newKey" placeholder="rc-xxxxxxxx…" size="42">
      <button id="addKey">添加账号</button>
      <span class="muted">运行时账号仅在当前实例有效，重启后失效；持久化请用 wrangler secret。</span>
    </div>
    <div id="hidden" class="muted" style="margin-top:8px"></div>
  </details>

  <details>
    <summary>原始 JSON</summary>
    <pre id="raw">—</pre>
  </details>

  <details>
    <summary>使用说明</summary>
    <pre id="usage"></pre>
  </details>
</main>
<div class="toast" id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let report = null, timer = null;

function token() { return $('token').value.trim(); }
function authHeaders(extra) {
  const h = Object.assign({ 'content-type': 'application/json' }, extra || {});
  const t = token();
  if (t) { h['authorization'] = 'Bearer ' + t; h['x-api-key'] = t; }
  return h;
}
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 4000);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function money(v) { return v == null ? '—' : '$' + (Math.round(Number(v) * 10000) / 10000); }
function pct(v) { return v == null ? '—' : (Math.round(v * 100) / 100) + '%'; }
function dur(ms) {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h' + (m > 0 ? ' ' + m + 'm' : '');
  if (m > 0) return m + 'm' + (s % 60 > 0 ? ' ' + (s % 60) + 's' : '');
  return s + 's';
}

async function load(showErrors) {
  let res;
  try {
    res = await fetch('v1/quota' + (report && showErrors ? '?refresh=1' : ''), { headers: authHeaders(), cache: 'no-store' });
  } catch (e) { toast('网络错误: ' + e); return; }
  if (res.status === 401 && report) { $('token').value = ''; report = null; }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok && showErrors !== false) toast((data.error && data.error.message) || ('HTTP ' + res.status));
  report = data;
  $('raw').textContent = JSON.stringify(data, null, 2);
  render();
  schedule();
}

function render() {
  const d = report || {};
  if (d.error) {
    $('totals').innerHTML = '';
    $('rows').innerHTML = '<tr><td colspan="11" class="err">' + esc(d.error.message) + '</td></tr>';
    return;
  }
  const t = d.totals || {};
  $('totals').innerHTML = [
    ['可调度账号', (t.schedulable == null ? '—' : t.schedulable) + ' / ' + (t.accounts == null ? '—' : t.accounts)],
    ['今日剩余', money(t.dailyUsdRemaining)],
    ['今日已用', money(t.dailyUsdUsed)],
    ['今日额度上限', money(t.dailyUsdLimit)],
    ['最近重置', dur(t.earliestResetAtMs ? t.earliestResetAtMs - Date.now() : null)],
    ['今日请求 / tokens', (t.todayRequests || 0) + ' / ' + (t.todayTokens || 0)],
  ].map(([k, v]) => '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>').join('');

  const accts = d.accounts || [];
  if (!accts.length) {
    $('rows').innerHTML = '<tr><td colspan="11" class="muted">还没有账号。用 <code>wrangler secret put AMD_ACCOUNTS</code> 配置，或在下方添加运行时账号。</td></tr>';
  } else {
    $('rows').innerHTML = accts.map((a) => {
      const q = a.quota || {};
      const rem = q.dailyUsdRemaining, lim = q.dailyUsdLimit, used = q.dailyUsdUsed;
      const ratio = rem != null && lim ? Math.max(0, Math.min(1, rem / lim)) : (rem == null ? null : 0);
      const color = ratio == null ? '#30363d' : ratio > 0.4 ? 'var(--ok)' : ratio > 0.1 ? 'var(--warn)' : 'var(--bad)';
      let state;
      if (a.disabled) state = '<span class="tag bad">已禁用</span>';
      else if (!a.enabled) state = '<span class="tag warn">已停用</span>';
      else if (a.coolingDown) state = '<span class="tag warn">冷却 ' + dur(a.cooldownRemainingSeconds * 1000) + '</span>';
      else if (a.schedulable) state = '<span class="tag ok">可用</span>';
      else state = '<span class="tag">跳过</span>';
      const note = a.disableReason || a.cooldownReason || a.skipReason || a.lastError || '';
      const quotaKnown = rem != null || used != null || lim != null;
      const src = q.source === 'usage-endpoint' ? 'usage' : (q.source === 'response-headers' ? 'headers' : null);
      return '<tr>' +
        '<td><strong>' + esc(a.label) + '</strong><div class="muted" style="font-size:11px">' + esc(a.keyMasked) + (a.runtime ? ' · runtime' : '') + '</div></td>' +
        '<td>' + state + (note ? '<div class="muted" style="font-size:11px;max-width:260px">' + esc(note) + '</div>' : '') + '</td>' +
        '<td class="num">' + money(used) + '</td>' +
        '<td class="num" style="color:' + color + '">' + (quotaKnown ? money(rem) : '<span class="muted">未知</span>') + '</td>' +
        '<td><div class="meter"><i style="width:' + (ratio == null ? 0 : ratio * 100) + '%;background:' + color + '"></i></div>' +
          '<div class="muted" style="font-size:11px">' + (quotaKnown ? '上限 ' + money(lim) + (src ? ' · ' + src + ' · ' + (a.quotaAgeSeconds|0) + 's前' : '') : '暂无额度数据') + '</div></td>' +
        '<td class="num">' + (q.dailyResetAtMs ? dur(q.dailyResetAtMs - Date.now()) : '—') + '<div class="muted" style="font-size:11px">' + esc(q.dailyResetTimezone || '') + '</div></td>' +
        '<td class="num">' + (q.rpmRemaining != null ? q.rpmRemaining + ' / ' + (q.rpmLimit || '?') : (q.rpmLimit != null ? q.rpmLimit : '—')) + '</td>' +
        '<td class="num">' + (q.todayRequests != null ? q.todayRequests + (q.todayErrors ? ' <span class="warn">(' + q.todayErrors + ' err)</span>' : '') : '—') +
          '<div class="muted" style="font-size:11px">' + money(q.todayCostUsd) + '</div></td>' +
        '<td class="num">' + a.inFlight + ' / ' + a.maxConcurrency + '</td>' +
        '<td class="num">' + a.totalRequests + (a.totalRetries ? '<div class="muted" style="font-size:11px">' + a.totalRetries + ' retry</div>' : '') + (a.totalErrors ? '<div class="err" style="font-size:11px">' + a.totalErrors + ' err</div>' : '') + '</td>' +
        '<td><div class="row">' +
          '<button data-act="toggle" data-label="' + esc(a.label) + '" data-enabled="' + (a.enabled && !a.disabled ? 1 : 0) + '">' + (a.enabled && !a.disabled ? '停用' : '启用') + '</button>' +
          '<button data-act="test" data-label="' + esc(a.label) + '">测试</button>' +
          '<button data-act="delete" data-label="' + esc(a.label) + '" class="danger">删除</button>' +
        '</div></td></tr>';
    }).join('');
  }

  const hidden = (d.hiddenAccounts || []);
  $('hidden').textContent = hidden.length ? '已隐藏（来自 secret）：' + hidden.join(', ') : '';
  const base = (typeof location === 'object' ? location.origin : '');
  $('usage').textContent =
    '# OpenAI SDK\\n' +
    'export OPENAI_BASE_URL="' + base + '/v1"\\n' +
    'export OPENAI_API_KEY="' + (token() ? token().slice(0, 6) + '…' : '<你的 ACCESS_TOKEN>') + '"\\n\\n' +
    '# Claude Code (Anthropic 兼容)\\n' +
    'export ANTHROPIC_BASE_URL="' + base + '"\\n' +
    'export ANTHROPIC_AUTH_TOKEN="<你的 ACCESS_TOKEN>"\\n\\n' +
    '# curl\\n' +
    'curl ' + base + '/v1/chat/completions \\\\\\n' +
    '  -H "Authorization: Bearer <token>" -H "content-type: application/json" \\\\\\n' +
    '  -d \'{"model":"DeepSeek-V4-Flash","messages":[{"role":"user","content":"hi"}]}\'\\n\\n' +
    'curl ' + base + '/v1/quota -H "Authorization: Bearer <token>"\\n\\n' +
    '# 模型列表\\n' +
    'curl ' + base + '/v1/models -H "Authorization: Bearer <token>"\\n';
}

function schedule() {
  clearTimeout(timer);
  const ms = Number($('interval').value);
  if (ms > 0) timer = setTimeout(() => load(false), ms);
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) toast((data.error && data.error.message) || ('HTTP ' + res.status));
  else toast(data.message || 'ok');
  return data;
}

$('rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const label = btn.dataset.label, act = btn.dataset.act;
  if (act === 'toggle') { await post('admin/accounts/' + encodeURIComponent(label) + '/enabled', { enabled: btn.dataset.enabled !== '1' }); load(false); }
  if (act === 'test') { toast('测试中…'); const r = await post('admin/test', { label }); if (r.ok) toast(label + ' ok: ' + JSON.stringify(r.quota || {})); load(false); }
  if (act === 'delete' && confirm('删除账号 ' + label + '？（secret 里的账号会被隐藏，重新部署后仍在）')) { await post('admin/accounts/delete', { label }); load(false); }
});
$('addKey').addEventListener('click', async () => {
  const apiKey = $('newKey').value.trim();
  if (!apiKey) return toast('请填写 API key');
  const r = await post('admin/accounts', { label: $('newLabel').value.trim() || undefined, apiKey });
  if (r.persisted === false) toast('已添加，但当前实例未持久化（重启后失效）');
  $('newKey').value = ''; $('newLabel').value = '';
  load(false);
});
$('refresh').addEventListener('click', () => load(true));
$('probe').addEventListener('click', async () => { const r = await post('admin/refresh', {}); toast('已探测 ' + ((r.probed || []).length) + ' 个账号'); load(false); });
$('redeploy').addEventListener('click', async () => { if (confirm('通过 Cloudflare API 触发一次重新部署？')) { const r = await post('admin/redeploy', {}); if (r.ok) toast('已触发重新部署'); } });
$('interval').addEventListener('change', schedule);
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') { localStorage.setItem('amdBalancerToken', token()); load(true); } });
$('token').value = localStorage.getItem('amdBalancerToken') || new URLSearchParams(location.search).get('token') || '';
$('token').addEventListener('change', () => localStorage.setItem('amdBalancerToken', token()));
load(false);
</script>
</body>
</html>`;

export function renderDashboard(): Response {
  return new Response(DASHBOARD_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
