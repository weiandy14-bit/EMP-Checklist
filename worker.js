/**
 * worker.js — EMP Checklist 後端
 * Cloudflare Worker (ES Module)
 *
 * Secrets（用 `npx wrangler secret put` 設定）：
 *   JWT_SECRET    — JWT 簽署用的隨機字串
 *   PWD_SALT      — 密碼 hash 用的 salt（後端保管，前端不可見）
 *   NOTION_TOKEN  — Notion Integration Token
 *
 * Vars（wrangler.toml [vars]）：
 *   ALLOWED_ORIGIN — https://weiandy14-bit.github.io
 *
 * KV Binding：MEP_KV
 *
 * KV 結構：
 *   acct_index          → JSON string[]           帳號 ID 清單
 *   acct:{id}           → JSON Account            帳號資料
 *   proj_index          → JSON string[]           工程 ID 清單
 *   proj:{id}           → JSON Project            工程資料
 *   state:{projId}      → JSON State              工程進度
 *   report_db_id        → string                  Notion 報告資料庫 ID（快取）
 *
 * Routes：
 *   POST   /auth/login
 *   POST   /auth/bootstrap      （無帳號時建立管理者，僅限一次）
 *
 *   GET    /admin/accounts      （管理者）
 *   POST   /admin/accounts      （管理者）
 *   PATCH  /admin/accounts/:id  （管理者）
 *   DELETE /admin/accounts/:id  （管理者）
 *
 *   GET    /projects            （已登入）
 *   POST   /projects            （管理者）
 *   DELETE /projects/:id        （管理者）
 *
 *   GET    /state/:projId       （已登入，可存取此工程）
 *   PUT    /state/:projId       （已登入，可存取此工程）
 *
 *   POST   /report/:projId      （有 canReport 或管理者）
 */

const JWT_TTL      = 8 * 3600;    // 8 小時
const LOGIN_MAX    = 5;           // 最多失敗次數
const LOCK_SEC     = 15 * 60;     // 鎖定 15 分鐘
const NOTION_VER = '2022-06-28';

// ════════════════════════════════════════════════════════════
// JWT（Web Crypto，無外部套件）
// ════════════════════════════════════════════════════════════

function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function b64uDec(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function jwtSign(payload, secret) {
  const hdr  = b64u(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const key  = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${hdr}.${body}`));
  return `${hdr}.${body}.${b64u(sig)}`;
}

async function jwtVerify(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('格式錯誤');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const ok = await crypto.subtle.verify(
    'HMAC', key,
    b64uDec(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) throw new Error('簽章無效');
  const payload = JSON.parse(new TextDecoder().decode(b64uDec(parts[1])));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token 已過期');
  return payload;
}

// ════════════════════════════════════════════════════════════
// 密碼雜湊（與前端一致）
// ════════════════════════════════════════════════════════════

async function hashPwd(pwd, salt) {
  const buf = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(pwd + salt)
  );
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ════════════════════════════════════════════════════════════
// CORS & 回應工具
// ════════════════════════════════════════════════════════════

function makeCors(reqOrigin, allowed) {
  const origin = (allowed === '*' || reqOrigin === allowed) ? (reqOrigin || '*') : allowed;
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
  };
}

function R(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}
function E(msg, status = 400, extra = {}) {
  return R({ error: msg }, status, extra);
}

// ════════════════════════════════════════════════════════════
// Auth Middleware
// ════════════════════════════════════════════════════════════

async function getUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    return await jwtVerify(auth.slice(7), env.JWT_SECRET);
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// KV 工具
// ════════════════════════════════════════════════════════════

async function kvGetJSON(kv, key, fallback = null) {
  const v = await kv.get(key);
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

async function kvPutJSON(kv, key, val) {
  await kv.put(key, JSON.stringify(val));
}

async function getAcctIndex(kv)  { return kvGetJSON(kv, 'acct_index', []); }
async function getProjIndex(kv)  { return kvGetJSON(kv, 'proj_index', []); }
async function getAcct(kv, id)   { return kvGetJSON(kv, `acct:${id}`); }
async function getProj(kv, id)   { return kvGetJSON(kv, `proj:${id}`); }
async function getState(kv, pid) { return kvGetJSON(kv, `state:${pid}`, { chk:{}, note:{}, sig:{} }); }

// ════════════════════════════════════════════════════════════
// Rate Limiting（登入失敗次數限制）
// ════════════════════════════════════════════════════════════

async function checkRateLimit(kv, ip) {
  const key  = `rl:${ip}`;
  const data = await kvGetJSON(kv, key, { count: 0, lockedUntil: 0 });
  const now  = Math.floor(Date.now() / 1000);
  if (data.lockedUntil > now) {
    const mins = Math.ceil((data.lockedUntil - now) / 60);
    throw new Error(`登入失敗次數過多，請 ${mins} 分鐘後再試`);
  }
}

async function recordFailure(kv, ip) {
  const key  = `rl:${ip}`;
  const now  = Math.floor(Date.now() / 1000);
  const data = await kvGetJSON(kv, key, { count: 0, lockedUntil: 0 });
  data.count = (data.count || 0) + 1;
  if (data.count >= LOGIN_MAX) data.lockedUntil = now + LOCK_SEC;
  await kv.put(key, JSON.stringify(data), { expirationTtl: LOCK_SEC + 60 });
}

async function clearFailures(kv, ip) {
  await kv.delete(`rl:${ip}`);
}

// ════════════════════════════════════════════════════════════
// Notion
// ════════════════════════════════════════════════════════════

const STATUS_ICON = { pass:'✅ 符合', issue:'❌ 問題', na:'—  不適用', '':'□  待核對' };
const SEV_LABEL   = { A:'🔴 A 必修正', B:'🟡 B 建議確認', C:'🟢 C 建議優化' };

async function notionReq(method, path, body, token) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization:    `Bearer ${token}`,
      'Notion-Version': NOTION_VER,
      'Content-Type':   'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Notion ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function ensureReportDb(kv, token, parentPageId) {
  const cached = await kv.get('report_db_id');
  if (cached) {
    try {
      const db = await notionReq('GET', `/databases/${cached}`, null, token);
      if (!db.archived) return cached;
    } catch { /* 繼續建立新的 */ }
  }
  if (!parentPageId) throw new Error('請設定 NOTION_PARENT_PAGE_ID（Notion 父頁面 ID）');
  const db = await notionReq('POST', '/databases', {
    parent: { type: 'page_id', page_id: parentPageId },
    icon:   { type: 'emoji', emoji: '📋' },
    title:  [{ type: 'text', text: { content: 'MEP 檢查報告' } }],
    properties: {
      '報告名稱':  { title: {} },
      '專案名稱':  { rich_text: {} },
      '版次':      { rich_text: {} },
      '核對日期':  { date: {} },
      '送出者':    { rich_text: {} },
      '完成率(%)': { number: { format: 'number' } },
      '符合項目':  { number: { format: 'number' } },
      '問題項目':  { number: { format: 'number' } },
      '不適用':    { number: { format: 'number' } },
      '總項目數':  { number: { format: 'number' } },
      '送出時間':  { rich_text: {} },
    },
  }, token);
  await kv.put('report_db_id', db.id);
  return db.id;
}

function buildBlocks(report) {
  const { meta, systems } = report;
  const blocks = [];
  blocks.push({
    object: 'block', type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '📊' },
      color: 'blue_background',
      rich_text: [{ type: 'text', text: { content:
        `專案：${meta.proj}  |  版次：${meta.rev||'—'}  |  日期：${meta.date||'—'}\n` +
        `送出者：${meta.submitter}  |  完成率：${meta.pct}%  |  ` +
        `符合 ${meta.pass} 項 / 問題 ${meta.issue} 項 / 不適用 ${meta.na} 項 / 共 ${meta.total} 項`
      }}],
    },
  });
  for (const sys of systems) {
    const sysTitle = [sys.icon, sys.name].filter(Boolean).join(' ') || '（未命名系統）';
    blocks.push({ object:'block', type:'heading_1',
      heading_1:{ rich_text:[{ type:'text', text:{ content: sysTitle } }] } });
    for (const sub of sys.subs) {
      const subTitle = [sub.icon, sub.name].filter(Boolean).join(' ') || '（未命名子項）';
      blocks.push({ object:'block', type:'heading_2',
        heading_2:{ rich_text:[{ type:'text', text:{ content: subTitle } }] } });
      for (const item of sub.items) {
        const s = item.status || '';
        const color = s==='issue'?'red_background': s==='pass'?'green_background': s==='na'?'gray_background':'default';
        const emoji = s==='pass'?'✅': s==='issue'?'❌': s==='na'?'➡️':'⬜';
        let content = `${STATUS_ICON[s]||'□'}  [${SEV_LABEL[item.sev]||item.sev||'—'}]  ${item.text||'（無內容）'}`;
        if (item.basis) content += `\n📋 ${item.basis}`;
        if (item.note)  content += `\n📝 備註：${item.note}`;
        if (content.length > 1990) content = content.slice(0, 1990) + '…';
        blocks.push({ object:'block', type:'callout',
          callout:{ icon:{type:'emoji',emoji}, color, rich_text:[{type:'text',text:{content}}] } });
      }
    }
    blocks.push({ object:'block', type:'divider', divider:{} });
  }
  return blocks;
}

async function pushToNotion(kv, token, parentPageId, report) {
  const dbId  = await ensureReportDb(kv, token, parentPageId);
  const { meta } = report;
  // 將 submittedAt（ISO）轉為 台灣時間 YYYY-MM-DD HH:mm
  const dt = new Date(meta.submittedAt || Date.now());
  const pad = n => String(n).padStart(2, '0');
  const twOffset = 8 * 60;
  const local = new Date(dt.getTime() + twOffset * 60000);
  const dateTime = `${local.getUTCFullYear()}-${pad(local.getUTCMonth()+1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  const parts = [dateTime, meta.caseNo, meta.projName, meta.submitter].filter(Boolean);
  const title = parts.join('　');
  const props = {
    '報告名稱':  { title:     [{ text:{ content: title } }] },
    '專案名稱':  { rich_text: [{ text:{ content: meta.proj        ||'' } }] },
    '版次':      { rich_text: [{ text:{ content: meta.rev         ||'' } }] },
    '送出者':    { rich_text: [{ text:{ content: meta.submitter   ||'' } }] },
    '完成率(%)': { number: meta.pct   ?? 0 },
    '符合項目':  { number: meta.pass  ?? 0 },
    '問題項目':  { number: meta.issue ?? 0 },
    '不適用':    { number: meta.na    ?? 0 },
    '總項目數':  { number: meta.total ?? 0 },
    '送出時間':  { rich_text: [{ text:{ content: meta.submittedAt ||'' } }] },
  };
  if (meta.date) props['核對日期'] = { date: { start: meta.date } };

  const blocks = buildBlocks(report);
  const page = await notionReq('POST', '/pages', {
    parent: { database_id: dbId },
    icon:   { type: 'emoji', emoji: '📋' },
    properties: props,
    children: blocks.slice(0, 100),
  }, token);
  for (let i = 100; i < blocks.length; i += 100) {
    await notionReq('PATCH', `/blocks/${page.id}/children`,
      { children: blocks.slice(i, i + 100) }, token);
  }
  return { dbId, pageId: page.id };
}

// ════════════════════════════════════════════════════════════
// Route Handlers
// ════════════════════════════════════════════════════════════

// POST /auth/bootstrap — 無帳號時建立管理者（只能用一次）
async function handleBootstrap(req, env, cors) {
  const idx = await getAcctIndex(env.MEP_KV);
  if (idx.length > 0) return E('已有帳號，請用 /auth/login', 403, cors);
  const { name, password } = await req.json();
  if (!name || !password) return E('缺少 name 或 password', 400, cors);
  const pwdHash = await hashPwd(password, env.PWD_SALT);
  const id   = crypto.randomUUID();
  const acct = { id, name, pwdHash, isAdmin: true, systems: [], canReport: true };
  await kvPutJSON(env.MEP_KV, `acct:${id}`, acct);
  await kvPutJSON(env.MEP_KV, 'acct_index', [id]);
  const token = await jwtSign(
    { sub: id, name, isAdmin: true, canReport: true, exp: Math.floor(Date.now()/1000) + JWT_TTL },
    env.JWT_SECRET
  );
  return R({ token, user: { id, name, isAdmin: true, systems: [], canReport: true } }, 200, cors);
}

// POST /auth/login
async function handleLogin(req, env, cors, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try { await checkRateLimit(env.MEP_KV, ip); } catch (e) { return E(e.message, 429, cors); }

  const { name, password } = await req.json();
  if (!name || !password) return E('缺少 name 或 password', 400, cors);

  const idx = await getAcctIndex(env.MEP_KV);
  for (const id of idx) {
    const acct = await getAcct(env.MEP_KV, id);
    if (!acct || acct.name !== name) continue;
    // 後端雜湊後比對（前端傳明文，HTTPS 保護傳輸）
    const hash = await hashPwd(password, env.PWD_SALT);
    if (acct.pwdHash !== hash) {
      await recordFailure(env.MEP_KV, ip);
      return E('密碼錯誤', 401, cors);
    }
    await clearFailures(env.MEP_KV, ip);
    const token = await jwtSign(
      { sub: id, name, isAdmin: acct.isAdmin, canReport: acct.canReport, exp: Math.floor(Date.now()/1000) + JWT_TTL },
      env.JWT_SECRET
    );
    return R({
      token,
      user: { id, name, isAdmin: acct.isAdmin, systems: acct.systems, canReport: acct.canReport }
    }, 200, cors);
  }
  await recordFailure(env.MEP_KV, ip);
  return E('帳號不存在或密碼錯誤', 401, cors);
}

// GET /admin/accounts
async function handleGetAccounts(req, env, cors, user) {
  if (!user?.isAdmin) return E('僅管理者可存取', 403, cors);
  const idx  = await getAcctIndex(env.MEP_KV);
  const list = await Promise.all(idx.map(id => getAcct(env.MEP_KV, id)));
  return R(list.filter(Boolean).map(a => ({
    id: a.id, name: a.name, isAdmin: a.isAdmin,
    systems: a.systems, canReport: a.canReport
  })), 200, cors);
}

// POST /admin/accounts — 建立操作者帳號
async function handleCreateAccount(req, env, cors, user) {
  if (!user?.isAdmin) return E('僅管理者可存取', 403, cors);
  const { name, password, systems = [], canReport = false } = await req.json();
  if (!name || !password) return E('缺少 name 或 password', 400, cors);
  const idx = await getAcctIndex(env.MEP_KV);
  for (const id of idx) {
    const a = await getAcct(env.MEP_KV, id);
    if (a?.name === name) return E('帳號名稱已存在', 409, cors);
  }
  const pwdHash = await hashPwd(password, env.PWD_SALT);
  const id   = crypto.randomUUID();
  const acct = { id, name, pwdHash, isAdmin: false, systems, canReport };
  await kvPutJSON(env.MEP_KV, `acct:${id}`, acct);
  await kvPutJSON(env.MEP_KV, 'acct_index', [...idx, id]);
  return R({ id, name, isAdmin: false, systems, canReport }, 201, cors);
}

// PATCH /admin/accounts/:id — 修改操作者權限
async function handleUpdateAccount(id, req, env, cors, user) {
  if (!user?.isAdmin) return E('僅管理者可存取', 403, cors);
  const acct = await getAcct(env.MEP_KV, id);
  if (!acct) return E('帳號不存在', 404, cors);
  if (acct.isAdmin) return E('不可修改管理者帳號', 403, cors);
  const patch = await req.json();
  if (patch.systems   !== undefined) acct.systems   = patch.systems;
  if (patch.canReport !== undefined) acct.canReport = patch.canReport;
  await kvPutJSON(env.MEP_KV, `acct:${id}`, acct);
  return R({ id, name: acct.name, systems: acct.systems, canReport: acct.canReport }, 200, cors);
}

// DELETE /admin/accounts/:id
async function handleDeleteAccount(id, env, cors, user) {
  if (!user?.isAdmin) return E('僅管理者可存取', 403, cors);
  const acct = await getAcct(env.MEP_KV, id);
  if (!acct) return E('帳號不存在', 404, cors);
  if (acct.isAdmin) return E('不可刪除管理者帳號', 403, cors);
  await env.MEP_KV.delete(`acct:${id}`);
  const idx = (await getAcctIndex(env.MEP_KV)).filter(i => i !== id);
  await kvPutJSON(env.MEP_KV, 'acct_index', idx);
  return R({ ok: true }, 200, cors);
}

// GET /projects
async function handleGetProjects(env, cors, user) {
  if (!user) return E('請先登入', 401, cors);
  const idx  = await getProjIndex(env.MEP_KV);
  const list = await Promise.all(idx.map(id => getProj(env.MEP_KV, id)));
  return R(list.filter(Boolean), 200, cors);
}

// POST /projects
async function handleCreateProject(req, env, cors, user) {
  if (!user?.isAdmin) return E('僅管理者可新增工程', 403, cors);
  const { caseNo, name, systems = [] } = await req.json();
  if (!name) return E('缺少案件名稱', 400, cors);
  const id   = crypto.randomUUID();
  const proj = { id, caseNo: caseNo || '', name, systems, createdAt: new Date().toISOString(), createdBy: user.sub };
  await kvPutJSON(env.MEP_KV, `proj:${id}`, proj);
  const idx = await getProjIndex(env.MEP_KV);
  await kvPutJSON(env.MEP_KV, 'proj_index', [...idx, id]);
  return R(proj, 201, cors);
}

// DELETE /projects/:id
async function handleDeleteProject(id, env, cors, user) {
  if (!user?.isAdmin) return E('僅管理者可刪除工程', 403, cors);
  const proj = await getProj(env.MEP_KV, id);
  if (!proj) return E('工程不存在', 404, cors);
  await env.MEP_KV.delete(`proj:${id}`);
  await env.MEP_KV.delete(`state:${id}`);
  const idx = (await getProjIndex(env.MEP_KV)).filter(i => i !== id);
  await kvPutJSON(env.MEP_KV, 'proj_index', idx);
  return R({ ok: true }, 200, cors);
}

// 工程存取權限檢查（admin 或 user.systems 與 proj.systems 有交集）
async function canAccessProj(kv, user, projId) {
  if (user.isAdmin) return true;
  const proj = await getProj(kv, projId);
  if (!proj) return false;
  if (!proj.systems || proj.systems.length === 0) return true;
  return (user.systems || []).some(s => proj.systems.includes(s));
}

// GET /state/:projId
async function handleGetState(projId, env, cors, user) {
  if (!user) return E('請先登入', 401, cors);
  if (!await canAccessProj(env.MEP_KV, user, projId)) return E('無此工程的存取權限', 403, cors);
  const state = await getState(env.MEP_KV, projId);
  return R(state, 200, cors);
}

// PUT /state/:projId
async function handlePutState(projId, req, env, cors, user) {
  if (!user) return E('請先登入', 401, cors);
  if (!await canAccessProj(env.MEP_KV, user, projId)) return E('無此工程的存取權限', 403, cors);
  const body = await req.json();
  const state = {
    proj:      body.proj      || {},
    chk:       body.chk       || {},
    note:      body.note      || {},
    sig:       body.sig       || {},
    updatedAt: new Date().toISOString(),
    updatedBy: user.name,
  };
  await kvPutJSON(env.MEP_KV, `state:${projId}`, state);
  return R({ ok: true }, 200, cors);
}

// POST /report/:projId
async function handleReport(projId, req, env, cors, user) {
  if (!user) return E('請先登入', 401, cors);
  if (!user.isAdmin && !user.canReport) return E('無送出報告的權限', 403, cors);
  if (!await canAccessProj(env.MEP_KV, user, projId)) return E('無此工程的存取權限', 403, cors);
  if (!env.NOTION_TOKEN) return E('NOTION_TOKEN 未設定', 500, cors);
  const { report } = await req.json();
  if (!report?.meta || !report?.systems) return E('無效的報告格式', 400, cors);
  try {
    const result = await pushToNotion(env.MEP_KV, env.NOTION_TOKEN, env.NOTION_PARENT_PAGE_ID, report);
    return R({ ok: true, ...result }, 200, cors);
  } catch (e) {
    return E(`Notion 錯誤：${e.message}`, 502, cors);
  }
}

// ════════════════════════════════════════════════════════════
// 主路由
// ════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors   = makeCors(origin, env.ALLOWED_ORIGIN || '*');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/$/,''); // 去尾部旜線
    const method = request.method;
    const user   = await getUser(request, env);

    try {
      // ── Auth ──
      if (method === 'POST' && path === '/auth/bootstrap') return handleBootstrap(request, env, cors);
      if (method === 'POST' && path === '/auth/login')     return handleLogin(request, env, cors, request);

      // ── Admin / Accounts ──
      if (method === 'GET'    && path === '/admin/accounts') return handleGetAccounts(request, env, cors, user);
      if (method === 'POST'   && path === '/admin/accounts') return handleCreateAccount(request, env, cors, user);
      const acctMatch = path.match(/^\/admin\/accounts\/([^/]+)$/);
      if (acctMatch) {
        if (method === 'PATCH')  return handleUpdateAccount(acctMatch[1], request, env, cors, user);
        if (method === 'DELETE') return handleDeleteAccount(acctMatch[1], env, cors, user);
      }

      // ── Projects ──
      if (method === 'GET'  && path === '/projects') return handleGetProjects(env, cors, user);
      if (method === 'POST' && path === '/projects') return handleCreateProject(request, env, cors, user);
      const projMatch = path.match(/^\/projects\/([^/]+)$/);
      if (projMatch && method === 'DELETE') return handleDeleteProject(projMatch[1], env, cors, user);

      // ── State ──
      const stateMatch = path.match(/^\/state\/([^/]+)$/);
      if (stateMatch) {
        if (method === 'GET') return handleGetState(stateMatch[1], env, cors, user);
        if (method === 'PUT') return handlePutState(stateMatch[1], request, env, cors, user);
      }

      // ── Report ──
      const reportMatch = path.match(/^\/report\/([^/]+)$/);
      if (reportMatch && method === 'POST') return handleReport(reportMatch[1], request, env, cors, user);

      return E('找不到此路由', 404, cors);
    } catch (e) {
      return E(`伺服器錯誤：${e.message}`, 500, cors);
    }
  },
};
