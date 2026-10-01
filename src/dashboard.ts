/** 内置单文件额度看板（无外部依赖） */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AMD AI Key Balancer</title>
<style>
  :root {
    --bg: #080c12;
    --surface: #0d1520;
    --surface2: #111c2d;
    --surface3: #162030;
    --border: #1e2d42;
    --border2: #243347;
    --fg: #e2eaf3;
    --fg2: #8fa3bb;
    --fg3: #4d6378;
    --ok: #23d18b;
    --ok-dim: #0d4a30;
    --warn: #f0a832;
    --warn-dim: #4a3000;
    --bad: #f4524a;
    --bad-dim: #4a1010;
    --accent: #4f8ef7;
    --accent2: #7c5af7;
    --accent-glow: rgba(79,142,247,.18);
    --radius: 12px;
    --radius-sm: 8px;
    --sidebar-w: 320px;
    --header-h: 60px;
    --trans: .2s cubic-bezier(.4,0,.2,1);
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { height: 100%; }
  body {
    height: 100%;
    background: var(--bg);
    color: var(--fg);
    font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    overflow-x: hidden;
  }

  /* header */
  header {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    height: var(--header-h);
    background: rgba(8,12,18,.85);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; padding: 0 20px; gap: 12px;
  }
  .logo { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 700; letter-spacing: .02em; flex: 1; }
  .logo-icon {
    width: 32px; height: 32px; border-radius: 8px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; flex-shrink: 0;
    box-shadow: 0 0 16px var(--accent-glow);
  }
  .logo-text { color: var(--fg); }
  .logo-text span { color: var(--accent); }
  .header-actions { display: flex; align-items: center; gap: 8px; }

  /* buttons */
  button {
    display: inline-flex; align-items: center; gap: 6px;
    font: inherit; cursor: pointer; border: 1px solid var(--border2);
    background: var(--surface2); color: var(--fg2);
    border-radius: var(--radius-sm); padding: 7px 14px;
    transition: var(--trans); white-space: nowrap;
  }
  button:hover { border-color: var(--accent); color: var(--fg); background: var(--surface3); }
  button.primary {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    border-color: transparent; color: #fff; font-weight: 600;
    box-shadow: 0 2px 12px rgba(79,142,247,.3);
  }
  button.primary:hover { opacity: .9; box-shadow: 0 4px 20px rgba(79,142,247,.45); }
  button.ghost { background: transparent; border-color: transparent; padding: 7px 10px; }
  button.ghost:hover { background: var(--surface2); }
  button.danger:hover { border-color: var(--bad); color: var(--bad); }
  button.icon-btn { padding: 7px 10px; }
  button svg { flex-shrink: 0; }

  /* inputs */
  input, select, textarea {
    font: inherit; background: var(--surface); color: var(--fg);
    border: 1px solid var(--border2); border-radius: var(--radius-sm);
    padding: 8px 12px; transition: var(--trans); width: 100%;
  }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
  select { cursor: pointer; }
  select:focus { outline: none; border-color: var(--accent); }
  label { display: block; font-size: 12px; color: var(--fg2); margin-bottom: 6px; font-weight: 500; }

  /* layout */
  .layout { display: flex; min-height: 100%; padding-top: var(--header-h); }
  main { flex: 1; padding: 24px; max-width: 1100px; margin: 0 auto; min-width: 0; transition: padding-right var(--trans); }
  main.sidebar-open { padding-right: calc(var(--sidebar-w) + 24px); }

  /* sidebar */
  .sidebar {
    position: fixed; top: var(--header-h); right: 0; bottom: 0;
    width: var(--sidebar-w); background: var(--surface);
    border-left: 1px solid var(--border);
    transform: translateX(100%);
    transition: transform var(--trans);
    overflow-y: auto; z-index: 90;
    padding: 20px;
    display: flex; flex-direction: column; gap: 20px;
  }
  .sidebar.open { transform: translateX(0); }
  .sidebar-section { display: flex; flex-direction: column; gap: 10px; }
  .sidebar-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .1em; color: var(--fg3); padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 85; backdrop-filter: blur(2px); }
  .sidebar-overlay.active { display: block; }
  .token-status {
    display: flex; align-items: center; gap: 8px; font-size: 12px;
    padding: 8px 12px; border-radius: var(--radius-sm);
    background: var(--surface2); border: 1px solid var(--border);
  }
  .token-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--fg3); }
  .token-dot.ok { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
  .token-dot.bad { background: var(--bad); }
  .token-status-text { color: var(--fg2); }

  /* stat cards */
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px 18px;
    position: relative; overflow: hidden;
    transition: border-color var(--trans), transform var(--trans);
  }
  .stat-card:hover { border-color: var(--border2); transform: translateY(-1px); }
  .stat-card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, var(--accent), var(--accent2));
    opacity: 0; transition: opacity var(--trans);
  }
  .stat-card:hover::before { opacity: 1; }
  .stat-label { font-size: 11px; color: var(--fg3); text-transform: uppercase; letter-spacing: .08em; font-weight: 600; margin-bottom: 8px; }
  .stat-value { font-size: 24px; font-weight: 700; color: var(--fg); font-variant-numeric: tabular-nums; line-height: 1.2; }
  .stat-value.ok { color: var(--ok); }
  .stat-value.warn { color: var(--warn); }
  .stat-value.bad { color: var(--bad); }
  .stat-sub { font-size: 12px; color: var(--fg2); margin-top: 4px; }

  /* account list */
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .section-title { font-size: 13px; font-weight: 700; color: var(--fg); display: flex; align-items: center; gap: 8px; }
  .badge {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 20px; height: 20px; padding: 0 6px;
    border-radius: 10px; font-size: 11px; font-weight: 700;
    background: var(--surface2); color: var(--fg2); border: 1px solid var(--border2);
  }
  .account-list { display: flex; flex-direction: column; gap: 10px; }
  .account-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px 18px;
    display: grid; grid-template-columns: auto 1fr auto;
    gap: 12px 16px; align-items: start;
    transition: border-color var(--trans); position: relative;
  }
  .account-card:hover { border-color: var(--border2); }
  .account-card.disabled { opacity: .55; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; position: relative; }
  .status-dot.ok { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .status-dot.ok::after { content: ''; position: absolute; inset: -3px; border-radius: 50%; border: 1.5px solid var(--ok); animation: pulse 2s infinite; }
  .status-dot.warn { background: var(--warn); box-shadow: 0 0 8px var(--warn); }
  .status-dot.bad { background: var(--bad); }
  .status-dot.idle { background: var(--fg3); }
  @keyframes pulse { 0%,100% { opacity: .7; transform: scale(1); } 50% { opacity: 0; transform: scale(1.6); } }
  .acct-info { min-width: 0; }
  .acct-name { font-size: 14px; font-weight: 700; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acct-key { font-size: 12px; color: var(--fg3); margin-top: 2px; font-family: ui-monospace, monospace; }
  .acct-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; border: 1px solid; }
  .tag.ok { color: var(--ok); border-color: var(--ok-dim); background: rgba(35,209,139,.08); }
  .tag.warn { color: var(--warn); border-color: var(--warn-dim); background: rgba(240,168,50,.08); }
  .tag.bad { color: var(--bad); border-color: var(--bad-dim); background: rgba(244,82,74,.08); }
  .tag.dim { color: var(--fg3); border-color: var(--border); }
  .acct-quota { margin-top: 10px; }
  .quota-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 6px; }
  .quota-item { flex: 1; min-width: 90px; }
  .quota-label { font-size: 10px; color: var(--fg3); text-transform: uppercase; letter-spacing: .06em; }
  .quota-value { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .meter { height: 4px; background: rgba(255,255,255,.06); border-radius: 4px; overflow: hidden; margin-top: 6px; }
  .meter-bar { height: 100%; border-radius: 4px; transition: width .4s ease; }
  .acct-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 11px; color: var(--fg3); margin-top: 6px; }
  .acct-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: flex-start; flex-shrink: 0; }
  .acct-actions button { padding: 5px 10px; font-size: 12px; }

  /* panels */
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-top: 24px; overflow: hidden; }
  .panel-header { display: flex; align-items: center; gap: 10px; padding: 14px 18px; cursor: pointer; user-select: none; border-bottom: 1px solid transparent; transition: border-color var(--trans); }
  .panel-header:hover { background: var(--surface2); }
  .panel[open] .panel-header { border-bottom-color: var(--border); }
  .panel-header summary { list-style: none; display: contents; }
  .panel-header summary::-webkit-details-marker { display: none; }
  .panel-title { font-size: 13px; font-weight: 700; flex: 1; }
  .panel-chevron { color: var(--fg3); transition: transform var(--trans); width: 16px; height: 16px; }
  .panel[open] .panel-chevron { transform: rotate(90deg); }
  .panel-body { padding: 18px; }
  .add-form { display: grid; grid-template-columns: 1fr 2fr auto; gap: 10px; align-items: end; }
  .add-form .hint { color: var(--fg3); font-size: 12px; margin-top: 8px; grid-column: 1/-1; }

  /* code */
  pre.usage-code {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 14px 16px;
    font-size: 12px; font-family: ui-monospace, monospace;
    overflow-x: auto; line-height: 1.8; white-space: pre;
  }
  .code-block-wrap { position: relative; }
  .copy-btn { position: absolute; top: 8px; right: 8px; padding: 4px 8px; font-size: 11px; opacity: .6; }
  .copy-btn:hover { opacity: 1; }
  pre#raw {
    font-size: 11px; font-family: ui-monospace, monospace;
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 14px; overflow: auto;
    max-height: 400px; color: var(--fg2);
  }

  /* misc */
  .empty { text-align: center; padding: 48px 20px; color: var(--fg3); font-size: 13px; }
  .empty-icon { font-size: 36px; margin-bottom: 10px; }
  .err-banner {
    display: flex; align-items: flex-start; gap: 10px;
    background: rgba(244,82,74,.08); border: 1px solid var(--bad-dim);
    border-radius: var(--radius-sm); padding: 12px 14px;
    color: var(--bad); font-size: 13px; margin-bottom: 16px;
  }
  .toast-list { position: fixed; bottom: 20px; right: 20px; z-index: 200; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
  .toast {
    background: var(--surface2); border: 1px solid var(--border2);
    border-left: 3px solid var(--accent);
    padding: 10px 14px; border-radius: var(--radius-sm);
    font-size: 13px; max-width: 360px;
    animation: toastIn .2s ease, toastOut .2s ease var(--dur, 3.8s) forwards;
    pointer-events: auto;
  }
  .toast.ok-t { border-left-color: var(--ok); }
  .toast.err-t { border-left-color: var(--bad); }
  @keyframes toastIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  @keyframes toastOut { to { opacity:0; transform:translateY(4px); } }
  .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border2); border-top-color: var(--accent); border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 14px; }
  .tab { padding: 8px 14px; font-size: 13px; color: var(--fg2); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color var(--trans), border-color var(--trans); background: transparent; border-top: none; border-left: none; border-right: none; border-radius: 0; }
  .tab:hover { color: var(--fg); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

  /* auth gate */
  body.locked #main,
  body.locked .header-actions {
    display: none !important;
  }
  .auth-gate {
    position: fixed; inset: 0; z-index: 150;
    background: radial-gradient(circle at 50% 35%, rgba(20,32,50,0.96), var(--bg) 85%);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  body:not(.locked) .auth-gate {
    display: none !important;
  }
  .auth-card {
    width: 100%; max-width: 400px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 36px 30px;
    box-shadow: 0 20px 50px rgba(0,0,0,0.6), 0 0 40px var(--accent-glow);
    text-align: center;
    animation: authCardIn .25s ease-out;
  }
  @keyframes authCardIn {
    from { opacity: 0; transform: scale(0.96) translateY(8px); }
    to { opacity: 1; transform: none; }
  }
  .auth-icon {
    width: 54px; height: 54px; border-radius: 14px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    display: flex; align-items: center; justify-content: center;
    font-size: 26px; margin: 0 auto 16px;
    box-shadow: 0 4px 20px var(--accent-glow);
  }
  .auth-title { font-size: 20px; font-weight: 700; color: var(--fg); margin-bottom: 8px; }
  .auth-desc { font-size: 13px; color: var(--fg2); line-height: 1.5; margin-bottom: 22px; }
  .auth-input-group { margin-bottom: 16px; position: relative; }
  .auth-input-group input {
    font-size: 14px; padding: 12px 14px; border-radius: var(--radius-sm);
    background: var(--surface2); width: 100%;
  }
  .auth-submit-btn { width: 100%; justify-content: center; padding: 11px 16px; font-size: 14px; border-radius: var(--radius-sm); }
  .auth-error {
    margin-top: 14px; padding: 10px 12px; border-radius: var(--radius-sm);
    background: rgba(244,82,74,0.12); border: 1px solid var(--bad-dim);
    color: var(--bad); font-size: 12px; text-align: left; line-height: 1.5;
  }
  .auth-hint { font-size: 11px; color: var(--fg3); margin-top: 20px; line-height: 1.4; }

  @media (max-width: 720px) {
    :root { --sidebar-w: 100vw; }
    main.sidebar-open { padding-right: 24px; }
    .add-form { grid-template-columns: 1fr; }
    .add-form .hint { grid-column: 1; }
    .account-card { grid-template-columns: auto 1fr; }
    .acct-actions { grid-column: 1/-1; }
  }
  @media (min-width: 1200px) { main { padding: 28px 32px; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
</head>
<body class="locked">
<div class="auth-gate" id="authGate">
  <div class="auth-card">
    <div class="auth-icon">&#128274;</div>
    <div class="auth-title">管理员认证</div>
    <div class="auth-desc">请输入 Admin Token 以访问后台管理控制台</div>
    <div class="auth-input-group">
      <input id="gateTokenInput" type="password" placeholder="请输入 ADMIN_TOKEN" autocomplete="off">
    </div>
    <button class="primary auth-submit-btn" id="gateLoginBtn">
      <span id="gateBtnSpinner" class="spin" style="display:none;margin-right:6px"></span>
      <span id="gateBtnText">验证并进入后台</span>
    </button>
    <div id="gateErrMsg" class="auth-error" style="display:none"></div>
    <div class="auth-hint">
      若未设置独立 ADMIN_TOKEN，可尝试输入 ACCESS_TOKEN
    </div>
  </div>
</div>

<header>
  <div class="logo">
    <div class="logo-icon">&#9878;</div>
    <div class="logo-text"><span>AMD</span> AI Key Balancer</div>
  </div>
  <div class="header-actions">
    <button class="icon-btn ghost" id="probeBtn" title="主动探测全部账号额度">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      探测
    </button>
    <button class="icon-btn ghost" id="refreshBtn" title="刷新额度数据">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
      刷新
    </button>
    <select id="intervalSel" title="自动刷新间隔" style="width:auto">
      <option value="0">手动</option>
      <option value="15000">15s</option>
      <option value="60000" selected>60s</option>
      <option value="300000">5min</option>
    </select>
    <button class="icon-btn ghost" id="settingsBtn" title="设置 / Token">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
    <button class="icon-btn ghost" id="logoutBtn" title="退出登录并锁定">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      退出
    </button>
  </div>
</header>

<div class="layout">
  <main id="main">
    <div id="errBanner" style="display:none" class="err-banner">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span id="errMsg"></span>
    </div>

    <div class="stat-grid" id="statGrid"></div>

    <div class="section-header">
      <div class="section-title">
        账号状态
        <span class="badge" id="acctCount">—</span>
      </div>
      <div style="display:flex;gap:6px">
        <button class="icon-btn ghost" id="redeployBtn" title="需配置 CF_API_TOKEN / CF_ACCOUNT_ID">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          重新部署
        </button>
      </div>
    </div>
    <div class="account-list" id="acctList">
      <div class="empty"><div class="empty-icon">&#8987;</div>加载中&#8230;</div>
    </div>

    <details class="panel">
      <summary class="panel-header">
        <svg class="panel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        <span class="panel-title">&#43; 添加账号</span>
      </summary>
      <div class="panel-body">
        <div class="add-form">
          <div>
            <label>账号标签（可留空）</label>
            <input id="newLabel" placeholder="acct-a">
          </div>
          <div>
            <label>API Key</label>
            <input id="newKey" placeholder="rc-xxxxxxxxxxxxxxxxxxxxxxxx" autocomplete="off">
          </div>
          <div style="padding-top:22px">
            <button class="primary" id="addKeyBtn">添加</button>
          </div>
        </div>
        <p class="hint">运行时账号存入 Durable Object，重启不丢。长期账号推荐用 Secret 管理。</p>
        <div id="hiddenHint" style="display:none;margin-top:10px;font-size:12px;color:var(--fg3)"></div>
      </div>
    </details>

    <details class="panel">
      <summary class="panel-header">
        <svg class="panel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        <span class="panel-title">&#128270; 调试信息</span>
      </summary>
      <div class="panel-body">
        <div class="tabs">
          <button class="tab active" data-tab="usage">使用说明</button>
          <button class="tab" data-tab="raw">原始 JSON</button>
        </div>
        <div id="tabUsage">
          <div class="code-block-wrap">
            <pre class="usage-code" id="usage"># OpenAI SDK
export OPENAI_BASE_URL="__BASE__/v1"
export OPENAI_API_KEY="__TOKEN__"

# Claude Code (Anthropic 兼容)
export ANTHROPIC_BASE_URL="__BASE__"
export ANTHROPIC_AUTH_TOKEN="__TOKEN__"

# curl
curl __BASE__/v1/chat/completions \\
  -H "Authorization: Bearer __TOKEN__" -H "content-type: application/json" \\
  -d '{"model":"DeepSeek-V4-Flash","messages":[{"role":"user","content":"hi"}]}'

curl __BASE__/v1/quota -H "Authorization: Bearer __TOKEN__"

# 模型列表
curl __BASE__/v1/models -H "Authorization: Bearer __TOKEN__"</pre>
            <button class="copy-btn ghost" id="copyUsageBtn">复制</button>
          </div>
        </div>
        <div id="tabRaw" style="display:none">
          <pre id="raw">—</pre>
        </div>
      </div>
    </details>
  </main>
</div>

<div class="sidebar-overlay" id="overlay"></div>

<aside class="sidebar" id="sidebar">
  <div class="sidebar-section">
    <div class="sidebar-title">身份认证</div>
    <div id="tokenStatus" class="token-status">
      <div class="token-dot" id="tokenDot"></div>
      <span class="token-status-text" id="tokenStatusText">未设置 token</span>
    </div>
    <div>
      <label>Access / Admin Token</label>
      <input id="tokenInput" type="password" placeholder="输入 token 后按 Enter" autocomplete="off">
    </div>
    <button class="primary" id="applyTokenBtn">应用并刷新</button>
    <button id="clearTokenBtn" style="color:var(--bad)">清除 Token</button>
    <p style="font-size:12px;color:var(--fg3);line-height:1.6">
      Token 保存在浏览器 localStorage，刷新页面不会丢失。<br>
      也可以在 URL 参数里带：<code style="color:var(--fg2)">?token=xxx</code>
    </p>
  </div>
  <div class="sidebar-section">
    <div class="sidebar-title">自动刷新</div>
    <select id="intervalSel2" style="width:100%">
      <option value="0">手动刷新</option>
      <option value="15000">每 15 秒</option>
      <option value="60000" selected>每 60 秒</option>
      <option value="300000">每 5 分钟</option>
    </select>
  </div>
  <div class="sidebar-section">
    <div class="sidebar-title">快速链接</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <a href="/health" target="_blank" style="color:var(--accent);font-size:13px;text-decoration:none">&#128138; /health（环境诊断）</a>
      <a href="/v1/models" target="_blank" style="color:var(--accent);font-size:13px;text-decoration:none">&#128203; /v1/models（模型列表）</a>
      <a href="/v1/quota" target="_blank" style="color:var(--accent);font-size:13px;text-decoration:none">&#128176; /v1/quota（额度 JSON）</a>
    </div>
  </div>
</aside>

<div class="toast-list" id="toastList"></div>

<script>
var $ = function(id) { return document.getElementById(id); };
var report = null, timer = null, loading = false;

function getToken() {
  return localStorage.getItem('amdBalancerToken') || new URLSearchParams(location.search).get('token') || '';
}
function setToken(v) {
  if (v) localStorage.setItem('amdBalancerToken', v);
  else localStorage.removeItem('amdBalancerToken');
  syncTokenUI();
}
function syncTokenUI() {
  var t = getToken();
  $('tokenInput').value = t;
  var dot = $('tokenDot'), txt = $('tokenStatusText');
  if (t) {
    dot.className = 'token-dot ok';
    txt.textContent = t.length > 12 ? t.slice(0, 6) + '...' + t.slice(-4) : t;
  } else {
    dot.className = 'token-dot';
    txt.textContent = 'token 未设置（若接口需要认证会 401）';
  }
}

function openSidebar() {
  $('sidebar').classList.add('open');
  $('overlay').classList.add('active');
  $('main').classList.add('sidebar-open');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('overlay').classList.remove('active');
  $('main').classList.remove('sidebar-open');
}

function lock(msg) {
  document.body.classList.add('locked');
  closeSidebar();
  var err = $('gateErrMsg');
  if (msg) {
    err.style.display = 'block';
    err.textContent = msg;
  } else {
    err.style.display = 'none';
  }
  setTimeout(function() {
    var inp = $('gateTokenInput');
    if (inp) inp.focus();
  }, 60);
}

function unlock(v) {
  setToken(v);
  document.body.classList.remove('locked');
  $('gateErrMsg').style.display = 'none';
  $('gateTokenInput').value = '';
}

async function verifyAdminToken(t) {
  if (!t) return { ok: false, error: '请输入 Admin Token' };
  try {
    var res = await fetch('admin/accounts', {
      headers: { 'authorization': 'Bearer ' + t, 'content-type': 'application/json' },
      cache: 'no-store'
    });
    if (res.ok) return { ok: true };
    var text = await res.text();
    var data;
    try { data = JSON.parse(text); } catch (e) { data = {}; }
    var msg = (data.error && data.error.message) || ('认证失败 (HTTP ' + res.status + ')');
    return { ok: false, error: msg };
  } catch (e) {
    return { ok: false, error: '网络错误: ' + e };
  }
}

async function submitGateLogin() {
  var val = $('gateTokenInput').value.trim();
  if (!val) {
    var err = $('gateErrMsg');
    err.style.display = 'block';
    err.textContent = '请输入 Admin Token';
    return;
  }
  var btn = $('gateLoginBtn');
  var sp = $('gateBtnSpinner');
  var txt = $('gateBtnText');
  btn.disabled = true;
  sp.style.display = 'inline-block';
  txt.textContent = '验证中...';
  $('gateErrMsg').style.display = 'none';

  var r = await verifyAdminToken(val);
  btn.disabled = false;
  sp.style.display = 'none';
  txt.textContent = '验证并进入后台';

  if (r.ok) {
    toast('认证成功', 'ok');
    unlock(val);
    load(true);
  } else {
    var errBox = $('gateErrMsg');
    errBox.style.display = 'block';
    errBox.textContent = r.error || 'Admin Token 错误，无管理权限';
  }
}

$('gateLoginBtn').addEventListener('click', submitGateLogin);
$('gateTokenInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') submitGateLogin();
});

$('logoutBtn').addEventListener('click', function() {
  setToken('');
  lock('已安全退出，请输入 Admin Token 重新登录');
  toast('已退出登录', 'ok');
});

$('settingsBtn').addEventListener('click', function() {
  $('sidebar').classList.contains('open') ? closeSidebar() : openSidebar();
});
$('overlay').addEventListener('click', closeSidebar);
$('applyTokenBtn').addEventListener('click', async function() {
  var val = $('tokenInput').value.trim();
  if (!val) {
    setToken('');
    lock('Token 已清空');
    return;
  }
  var r = await verifyAdminToken(val);
  if (r.ok) {
    unlock(val);
    closeSidebar();
    load(true);
    toast('Token 认证成功', 'ok');
  } else {
    toast(r.error || 'Token 验证失败', 'err');
  }
});
$('clearTokenBtn').addEventListener('click', function() {
  setToken('');
  $('tokenInput').value = '';
  lock('Token 已清除');
});
$('tokenInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    var val = $('tokenInput').value.trim();
    if (!val) {
      setToken('');
      lock('Token 已清空');
      return;
    }
    verifyAdminToken(val).then(function(r) {
      if (r.ok) {
        unlock(val);
        closeSidebar();
        load(true);
        toast('Token 认证成功', 'ok');
      } else {
        toast(r.error || 'Token 验证失败', 'err');
      }
    });
  }
});

function getInterval() { return Number($('intervalSel').value); }
$('intervalSel').addEventListener('change', function() {
  $('intervalSel2').value = $('intervalSel').value; schedule();
});
$('intervalSel2').addEventListener('change', function() {
  $('intervalSel').value = $('intervalSel2').value; schedule();
});

document.querySelectorAll('.tab').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    btn.classList.add('active');
    var tab = btn.dataset.tab;
    $('tabUsage').style.display = tab === 'usage' ? '' : 'none';
    $('tabRaw').style.display = tab === 'raw' ? '' : 'none';
  });
});

function toast(msg, type) {
  var el = document.createElement('div');
  el.className = 'toast' + (type === 'ok' ? ' ok-t' : type === 'err' ? ' err-t' : '');
  el.style.setProperty('--dur', '3.8s');
  el.textContent = msg;
  $('toastList').appendChild(el);
  setTimeout(function() { el.remove(); }, 4200);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
  });
}
function money(v) {
  if (v == null) return '\u2014';
  return '$' + (Math.round(Number(v) * 10000) / 10000).toFixed(4);
}
function dur(ms) {
  if (ms == null || ms <= 0) return '\u2014';
  var s = Math.round(ms / 1000);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return h + 'h ' + (m > 0 ? m + 'm' : '');
  if (m > 0) return m + 'm ' + (sec > 0 ? sec + 's' : '');
  return sec + 's';
}
function authHeaders(extra) {
  var h = Object.assign({'content-type': 'application/json'}, extra || {});
  var t = getToken();
  if (t) { h['authorization'] = 'Bearer ' + t; h['x-api-key'] = t; }
  return h;
}

async function load(showErrors) {
  if (loading) return;
  if (document.body.classList.contains('locked') && !getToken()) return;
  loading = true;
  var btn = $('refreshBtn');
  if (btn) { btn.innerHTML = '<span class="spin"></span> 刷新中'; btn.disabled = true; }
  var res;
  try {
    res = await fetch('v1/quota' + (report && showErrors ? '?refresh=1' : ''), {
      headers: authHeaders(), cache: 'no-store'
    });
  } catch (e) {
    toast('网络错误: ' + e, 'err');
    loading = false;
    if (btn) { btn.textContent = '刷新'; btn.disabled = false; }
    return;
  }
  if (res.status === 401) {
    setToken('');
    report = null;
    lock('认证已失效，请重新输入 Admin Token');
    loading = false;
    if (btn) { btn.textContent = '刷新'; btn.disabled = false; }
    return;
  }
  var text = await res.text();
  var data;
  try { data = JSON.parse(text); } catch(e) { data = {raw: text}; }
  if (!res.ok && showErrors !== false) {
    toast((data.error && data.error.message) || ('HTTP ' + res.status), 'err');
  }
  report = data;
  $('raw').textContent = JSON.stringify(data, null, 2);
  render();
  schedule();
  loading = false;
  if (btn) { btn.textContent = '刷新'; btn.disabled = false; }
}

function render() {
  var d = report || {};
  renderUsage();

  var errBanner = $('errBanner');
  if (d.error) {
    errBanner.style.display = 'flex';
    $('errMsg').textContent = d.error.message;
    $('statGrid').innerHTML = '';
    $('acctList').innerHTML = '<div class="empty"><div class="empty-icon">\u26a0\ufe0f</div>' + esc(d.error.message) + '</div>';
    $('acctCount').textContent = '\u2014';
    return;
  }
  errBanner.style.display = 'none';

  var t = d.totals || {};
  var remainRatio = t.dailyUsdLimit ? Math.max(0, Math.min(1, (t.dailyUsdRemaining || 0) / t.dailyUsdLimit)) : null;
  var remainClass = remainRatio == null ? '' : remainRatio > .4 ? 'ok' : remainRatio > .1 ? 'warn' : 'bad';

  var cards = [
    {label:'\u53ef\u8c03\u5ea6\u8d26\u53f7', value: (t.schedulable != null ? t.schedulable : '\u2014') + ' / ' + (t.accounts != null ? t.accounts : '\u2014'), sub: ''},
    {label:'\u4eca\u65e5\u5269\u4f59\u989d\u5ea6', value: money(t.dailyUsdRemaining), cls: remainClass, sub: '\u4e0a\u9650 ' + money(t.dailyUsdLimit)},
    {label:'\u4eca\u65e5\u5df2\u7528', value: money(t.dailyUsdUsed), sub: ''},
    {label:'\u6700\u5feb\u91cd\u7f6e', value: t.earliestResetAtMs ? dur(t.earliestResetAtMs - Date.now()) : '\u2014', sub: '\u8ddd\u989d\u5ea6\u91cd\u7f6e'},
    {label:'\u4eca\u65e5\u8bf7\u6c42', value: String(t.todayRequests || 0), sub: (t.todayTokens || 0) + ' tokens'},
  ];
  $('statGrid').innerHTML = cards.map(function(c) {
    return '<div class="stat-card">' +
      '<div class="stat-label">' + esc(c.label) + '</div>' +
      '<div class="stat-value' + (c.cls ? ' ' + c.cls : '') + '">' + esc(c.value) + '</div>' +
      (c.sub ? '<div class="stat-sub">' + esc(c.sub) + '</div>' : '') +
      '</div>';
  }).join('');

  var accts = d.accounts || [];
  $('acctCount').textContent = accts.length;
  if (!accts.length) {
    $('acctList').innerHTML = '<div class="empty"><div class="empty-icon">\ud83d\udce1</div>\u8fd8\u6ca1\u6709\u8d26\u53f7\u3002\u8bf7\u5728\u53f3\u4e0a\u89d2\u8bbe\u7f6e\u91cc\u914d\u7f6e Token\uff0c\u6216\u5728\u201c\u6dfb\u52a0\u8d26\u53f7\u201d\u91cc\u586b\u5165 key\u3002</div>';
  } else {
    $('acctList').innerHTML = accts.map(function(a) { return renderAccount(a); }).join('');
  }

  var hidden = d.hiddenAccounts || [];
  var hint = $('hiddenHint');
  if (hidden.length) {
    hint.style.display = '';
    hint.textContent = '\u5df2\u9690\u85cf\uff08\u6765\u81ea secret\uff09\uff1a' + hidden.join(', ');
  } else { hint.style.display = 'none'; }
}

function renderAccount(a) {
  var q = a.quota || {};
  var rem = q.dailyUsdRemaining, lim = q.dailyUsdLimit, used = q.dailyUsdUsed;
  var ratio = rem != null && lim ? Math.max(0, Math.min(1, rem / lim)) : null;
  var colorVar = ratio == null ? 'var(--fg3)' : ratio > .4 ? 'var(--ok)' : ratio > .1 ? 'var(--warn)' : 'var(--bad)';

  var dotCls, tagHtml;
  if (a.disabled) { dotCls = 'bad'; tagHtml = '<span class="tag bad">\u5df2\u7981\u7528</span>'; }
  else if (!a.enabled) { dotCls = 'idle'; tagHtml = '<span class="tag dim">\u5df2\u505c\u7528</span>'; }
  else if (a.coolingDown) { dotCls = 'warn'; tagHtml = '<span class="tag warn">\u51b7\u5374 ' + dur(a.cooldownRemainingSeconds * 1000) + '</span>'; }
  else if (a.schedulable) { dotCls = 'ok'; tagHtml = '<span class="tag ok">\u2713 \u53ef\u7528</span>'; }
  else { dotCls = 'idle'; tagHtml = '<span class="tag dim">\u8df3\u8fc7</span>'; }

  if (a.runtime) tagHtml += '<span class="tag dim">runtime</span>';

  var note = a.disableReason || a.cooldownReason || a.skipReason || a.lastError || '';
  var src = q.source === 'usage-endpoint' ? 'usage-api' : (q.source === 'response-headers' ? 'resp-hdr' : '');
  var quotaKnown = rem != null || used != null || lim != null;
  var inFlight = a.inFlight || 0;
  var maxConc = a.maxConcurrency || 6;
  var concRatio = maxConc ? inFlight / maxConc : 0;
  var concColor = concRatio > .8 ? 'var(--bad)' : concRatio > .5 ? 'var(--warn)' : 'var(--ok)';
  var lbl = esc(a.label);
  var enaDis = a.enabled && !a.disabled ? 1 : 0;

  var quotaHtml = '';
  if (quotaKnown) {
    var rpmHtml = '';
    if (q.rpmRemaining != null || q.rpmLimit != null) {
      rpmHtml = '<div class="quota-item"><div class="quota-label">RPM</div><div class="quota-value">' +
        (q.rpmRemaining != null ? q.rpmRemaining + '/' + (q.rpmLimit || '?') : (q.rpmLimit || '\u2014')) +
        '</div></div>';
    }
    var metaHtml = '';
    if (src) metaHtml += '<span>\u6765\u6e90\uff1a' + src + '</span>';
    if (a.quotaAgeSeconds != null) metaHtml += '<span>' + a.quotaAgeSeconds + 's \u524d\u66f4\u65b0</span>';
    if (q.dailyResetAtMs) metaHtml += '<span>\u91cd\u7f6e\uff1a' + dur(q.dailyResetAtMs - Date.now()) + ' \u540e</span>';
    if (q.dailyResetTimezone) metaHtml += '<span>' + esc(q.dailyResetTimezone) + '</span>';
    if (q.todayRequests != null) metaHtml += '<span>\u4eca\u65e5\u8bf7\u6c42\uff1a' + q.todayRequests + (q.todayErrors ? ' (' + q.todayErrors + ' err)' : '') + '</span>';

    quotaHtml = '<div class="acct-quota">' +
      '<div class="quota-row">' +
        '<div class="quota-item"><div class="quota-label">\u4eca\u65e5\u5269\u4f59</div><div class="quota-value" style="color:' + colorVar + '">' + money(rem) + '</div></div>' +
        '<div class="quota-item"><div class="quota-label">\u4eca\u65e5\u5df2\u7528</div><div class="quota-value">' + money(used) + '</div></div>' +
        '<div class="quota-item"><div class="quota-label">\u4eca\u65e5\u4e0a\u9650</div><div class="quota-value">' + money(lim) + '</div></div>' +
        rpmHtml +
      '</div>' +
      '<div class="meter" title="' + ((ratio||0)*100).toFixed(1) + '% \u5269\u4f59">' +
        '<div class="meter-bar" style="width:' + (ratio == null ? 0 : ratio * 100) + '%;background:' + colorVar + '"></div>' +
      '</div>' +
      (metaHtml ? '<div class="acct-meta">' + metaHtml + '</div>' : '') +
      '</div>';
  } else {
    quotaHtml = '<div style="font-size:12px;color:var(--fg3);margin-top:8px">\u989d\u5ea6\u672a\u77e5\uff08\u5c1a\u672a\u63a2\u6d4b\uff09</div>';
  }

  var statsMeta = '<span style="color:' + concColor + '">\u5e76\u53d1\uff1a' + inFlight + '/' + maxConc + '</span>' +
    '<span>\u672c\u8fdb\u7a0b\u8bf7\u6c42\uff1a' + (a.totalRequests || 0) + '</span>' +
    (a.totalRetries ? '<span>\u91cd\u8bd5\uff1a' + a.totalRetries + '</span>' : '') +
    (a.totalErrors ? '<span style="color:var(--bad)">\u9519\u8bef\uff1a' + a.totalErrors + '</span>' : '');

  return '<div class="account-card' + (a.disabled ? ' disabled' : '') + '">' +
    '<div class="status-dot ' + dotCls + '"></div>' +
    '<div class="acct-info">' +
      '<div class="acct-name">' + lbl + '</div>' +
      '<div class="acct-key">' + esc(a.keyMasked || '') + '</div>' +
      '<div class="acct-tags">' + tagHtml + '</div>' +
      (note ? '<div style="font-size:11px;color:var(--fg3);margin-top:4px">' + esc(note) + '</div>' : '') +
      quotaHtml +
      '<div class="acct-meta" style="margin-top:8px;border-top:1px solid var(--border);padding-top:6px">' + statsMeta + '</div>' +
    '</div>' +
    '<div class="acct-actions">' +
      '<button data-act="toggle" data-label="' + lbl + '" data-enabled="' + enaDis + '">' + (enaDis ? '\u505c\u7528' : '\u542f\u7528') + '</button>' +
      '<button data-act="test" data-label="' + lbl + '">\u6d4b\u8bd5</button>' +
      '<button data-act="reset" data-label="' + lbl + '">\u91cd\u7f6e</button>' +
      '<button data-act="delete" data-label="' + lbl + '" class="danger">\u5220\u9664</button>' +
    '</div>' +
  '</div>';
}

function renderUsage() {
  var base = (typeof location === 'object' ? location.origin : '');
  var tok = getToken() ? getToken().slice(0, 6) + '...' : '<\u4f60\u7684 ACCESS_TOKEN>';
  var el = $('usage');
  if (!el) return;
  if (el.dataset.filled === '1' && el.dataset.token === tok) return;
  el.dataset.filled = '1';
  el.dataset.token = tok;
  el.textContent = el.textContent
    .replace(/__BASE__/g, function() { return base; })
    .replace(/__TOKEN__/g, function() { return tok; });
}

function schedule() {
  clearTimeout(timer);
  var ms = getInterval();
  if (ms > 0) timer = setTimeout(function() { load(false); }, ms);
}

async function apiPost(path, body) {
  var res = await fetch(path, {method:'POST', headers: authHeaders(), body: JSON.stringify(body || {})});
  var text = await res.text();
  var data;
  try { data = JSON.parse(text); } catch(e) { data = {raw: text}; }
  if (!res.ok) toast((data.error && data.error.message) || ('HTTP ' + res.status), 'err');
  else toast(data.message || 'ok', 'ok');
  return data;
}

$('acctList').addEventListener('click', async function(e) {
  var btn = e.target.closest('button[data-act]'); if (!btn) return;
  var label = btn.dataset.label, act = btn.dataset.act;
  if (act === 'toggle') {
    await apiPost('admin/accounts/' + encodeURIComponent(label) + '/enabled', {enabled: btn.dataset.enabled !== '1'});
    load(false);
  }
  if (act === 'test') {
    toast('\u6d4b\u8bd5\u4e2d\u2026');
    var r = await apiPost('admin/test', {label});
    if (r.ok) toast(label + ' \u2713 ' + JSON.stringify(r.quota || {}), 'ok');
    load(false);
  }
  if (act === 'reset') {
    await apiPost('admin/accounts/' + encodeURIComponent(label) + '/reset', {});
    load(false);
  }
  if (act === 'delete' && confirm('\u786e\u8ba4\u5220\u9664\u8d26\u53f7 ' + label + '\uff1f\uff08secret \u91cc\u7684\u8d26\u53f7\u53ea\u4f1a\u88ab\u9690\u85cf\uff0c\u91cd\u65b0\u90e8\u7f72\u540e\u4ecd\u5728\uff09')) {
    await apiPost('admin/accounts/delete', {label});
    load(false);
  }
});

$('addKeyBtn').addEventListener('click', async function() {
  var apiKey = $('newKey').value.trim();
  if (!apiKey) return toast('\u8bf7\u586b\u5199 API key', 'err');
  var r = await apiPost('admin/accounts', {label: $('newLabel').value.trim() || undefined, apiKey: apiKey});
  if (r.persisted === false) toast('\u5df2\u6dfb\u52a0\uff0c\u4f46\u5f53\u524d\u5b9e\u4f8b\u672a\u6301\u4e45\u5316\uff08\u91cd\u542f\u540e\u5931\u6548\uff09');
  $('newKey').value = ''; $('newLabel').value = '';
  load(false);
});

$('refreshBtn').addEventListener('click', function() { load(true); });
$('probeBtn').addEventListener('click', async function() {
  toast('\u63a2\u6d4b\u4e2d\u2026');
  var r = await apiPost('admin/refresh', {});
  toast('\u5df2\u63a2\u6d4b ' + ((r.probed || []).length) + ' \u4e2a\u8d26\u53f7', 'ok');
  load(false);
});
$('redeployBtn').addEventListener('click', async function() {
  if (confirm('\u901a\u8fc7 Cloudflare API \u89e6\u53d1\u4e00\u6b21\u91cd\u65b0\u90e8\u7f72\uff1f')) {
    var r = await apiPost('admin/redeploy', {});
    if (r.ok) toast('\u5df2\u89e6\u53d1\u91cd\u65b0\u90e8\u7f72', 'ok');
  }
});
$('copyUsageBtn').addEventListener('click', function() {
  var el = $('usage');
  navigator.clipboard && navigator.clipboard.writeText(el.textContent).then(function() { toast('\u5df2\u590d\u5236', 'ok'); });
});

syncTokenUI();
renderUsage();
var initTok = getToken();
if (initTok) {
  verifyAdminToken(initTok).then(function(r) {
    if (r.ok) {
      unlock(initTok);
      load(false);
    } else {
      setToken('');
      lock(r.error || '保存的 Token 已失效，请重新输入');
    }
  });
} else {
  lock();
}
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
