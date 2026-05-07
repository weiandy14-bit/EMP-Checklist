/**
 * MEP Checklist Backend — Cloudflare Worker
 *
 * KV Bindings (wrangler.toml):
 *   USERS    — 帳號資料
 *   PROJECTS — 工程列表
 *   STATE    — 各工程檢查進度
 *
 * Secrets (wrangler secret put <NAME>):
 *   JWT_SECRET    — 任意長字串
 *   NOTION_TOKEN  — ntn_xxxx
 *   NOTION_DB_ID  — 檢查報告資料庫 ID
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

// ── Response helpers ───────────────────────────────────────────────────────
const ok  = (d, s=200) => new Response(JSON.stringify(d), {status:s, headers:{...CORS,'Content-Type':'application/json'}});
const err = (msg, s=400) => ok({error:msg}, s);

// ── JWT (HS256, Web Crypto) ────────────────────────────────────────────────
const b64u = s => btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const b64d = s => atob(s.replace(/-/g,'+').replace(/_/g,'/'));

async function jwtKey(secret, usage) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    {name:'HMAC',hash:'SHA-256'}, false, [usage]);
}
async function signJWT(payload, secret) {
  const h = b64u(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const b = b64u(JSON.stringify(payload));
  const key = await jwtKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(h+'.'+b));
  return h+'.'+b+'.'+b64u(String.fromCharCode(...new Uint8Array(sig)));
}
async function verifyJWT(token, secret) {
  try {
    const [h,b,s] = token.split('.');
    const key = await jwtKey(secret, 'verify');
    const valid = await crypto.subtle.verify('HMAC', key,
      Uint8Array.from(b64d(s), c=>c.charCodeAt(0)),
      new TextEncoder().encode(h+'.'+b));
    if (!valid) return null;
    const p = JSON.parse(b64d(b));
    if (p.exp && Date.now()/1000 > p.exp) return null;
    return p;
  } catch { return null; }
}

// ── Password hash (same salt as frontend) ─────────────────────────────────
async function hashPwd(pwd) {
  if (!pwd) return '';
  const buf = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(pwd + 'mep_chk_2026_s'));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ── KV helpers ────────────────────────────────────────────────────────────
const getJ  = async (kv, k) => JSON.parse(await kv.get(k) || 'null');
const putJ  = async (kv, k, v) => kv.put(k, JSON.stringify(v));
const getUsers    = env => getJ(env.USERS,    'list').then(v=>v||[]);
const saveUsers   = (env,v) => putJ(env.USERS, 'list', v);
const getProjects = env => getJ(env.PROJECTS, 'list').then(v=>v||[]);
const saveProjects= (env,v) => putJ(env.PROJECTS,'list', v);

// ── Auth middleware ────────────────────────────────────────────────────────
async function auth(req, env)      { const t=(req.headers.get('Authorization')||'').replace('Bearer ',''); return t?verifyJWT(t,env.JWT_SECRET):null; }
async function adminOnly(req, env) { const p=await auth(req,env); return p?.isAdmin?p:null; }

// ── Router ────────────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const {pathname:path} = new URL(req.url);
    const m = req.method;
    if (m==='OPTIONS') return new Response(null, {headers:CORS});

    // ── POST /auth/login ──────────────────────────────────────────────────
    if (path==='/auth/login' && m==='POST') {
      const {name, pwd} = await req.json().catch(()=>({}));
      if (!name) return err('請填寫帳號');
      const users = await getUsers(env);
      const u = users.find(u=>u.name===name);
      if (!u) return err('帳號不存在', 401);
      if (u.hasPwd && await hashPwd(pwd||'') !== u.pwd) return err('密碼錯誤', 401);
      const token = await signJWT({
        id:u.id, name:u.name, isAdmin:u.isAdmin,
        systems:u.systems||[], canReport:u.canReport||false,
        exp: Math.floor(Date.now()/1000) + 86400*30
      }, env.JWT_SECRET);
      return ok({token, user:{id:u.id,name:u.name,isAdmin:u.isAdmin,systems:u.systems||[],canReport:u.canReport||false}});
    }

    // ── POST /auth/register ───────────────────────────────────────────────
    if (path==='/auth/register' && m==='POST') {
      const {name, pwd} = await req.json().catch(()=>({}));
      if (!name) return err('請填寫名稱');
      const users = await getUsers(env);
      const isFirst = users.length===0;
      if (!isFirst && !(await adminOnly(req,env))) return err('僅管理員可新增帳號', 403);
      if (users.find(u=>u.name===name)) return err('名稱已存在');
      const id = Date.now().toString();
      const newUser = {id, name, pwd:await hashPwd(pwd||''), hasPwd:!!(pwd?.length), isAdmin:isFirst, systems:[], canReport:false};
      users.push(newUser);
      await saveUsers(env, users);
      return ok({id, name, isAdmin:isFirst}, 201);
    }

    // ── GET /projects ─────────────────────────────────────────────────────
    if (path==='/projects' && m==='GET') {
      const p = await auth(req,env);
      if (!p) return err('未授權',401);
      return ok(await getProjects(env));
    }

    // ── POST /projects ────────────────────────────────────────────────────
    if (path==='/projects' && m==='POST') {
      const p = await adminOnly(req,env);
      if (!p) return err('僅管理員可新增工程',403);
      const {name} = await req.json().catch(()=>({}));
      if (!name) return err('請填寫工程名稱');
      const list = await getProjects(env);
      if (list.find(x=>x.name===name)) return err('工程名稱已存在');
      const id = Date.now().toString();
      list.push({id, name, createdAt:new Date().toISOString(), createdBy:p.name});
      await saveProjects(env, list);
      return ok({id, name}, 201);
    }

    // ── DELETE /projects/:id ──────────────────────────────────────────────
    const projM = path.match(/^\/projects\/([^/]+)$/);
    if (projM && m==='DELETE') {
      if (!await adminOnly(req,env)) return err('僅管理員可刪除',403);
      const pid = projM[1];
      await saveProjects(env, (await getProjects(env)).filter(x=>x.id!==pid));
      await env.STATE.delete('state:'+pid);
      return ok({ok:true});
    }

    // ── GET /state/:pid ───────────────────────────────────────────────────
    const stateM = path.match(/^\/state\/([^/]+)$/);
    if (stateM && m==='GET') {
      if (!await auth(req,env)) return err('未授權',401);
      const data = await getJ(env.STATE, 'state:'+stateM[1]);
      return ok(data || {chk:{},note:{},sig:{},proj:{}});
    }

    // ── PUT /state/:pid ───────────────────────────────────────────────────
    if (stateM && m==='PUT') {
      const p = await auth(req,env);
      if (!p) return err('未授權',401);
      const body = await req.json().catch(()=>({}));
      const existing = await getJ(env.STATE,'state:'+stateM[1]) || {};
      await putJ(env.STATE, 'state:'+stateM[1], {
        ...existing, ...body,
        updatedAt:new Date().toISOString(), updatedBy:p.name
      });
      return ok({ok:true});
    }

    // ── GET /admin/users ──────────────────────────────────────────────────
    if (path==='/admin/users' && m==='GET') {
      if (!await adminOnly(req,env)) return err('僅管理員可操作',403);
      const users = await getUsers(env);
      return ok(users.map(u=>({id:u.id,name:u.name,isAdmin:u.isAdmin,systems:u.systems||[],canReport:u.canReport||false})));
    }

    // ── PUT /admin/users/:id ──────────────────────────────────────────────
    const userM = path.match(/^\/admin\/users\/([^/]+)$/);
    if (userM && m==='PUT') {
      if (!await adminOnly(req,env)) return err('僅管理員可操作',403);
      const {systems, canReport} = await req.json().catch(()=>({}));
      const users = await getUsers(env);
      const idx = users.findIndex(u=>u.id===userM[1]);
      if (idx<0) return err('帳號不存在',404);
      if (systems!==undefined)   users[idx].systems   = systems;
      if (canReport!==undefined) users[idx].canReport = canReport;
      await saveUsers(env, users);
      return ok({ok:true});
    }

    // ── DELETE /admin/users/:id ───────────────────────────────────────────
    if (userM && m==='DELETE') {
      if (!await adminOnly(req,env)) return err('僅管理員可操作',403);
      const users = await getUsers(env);
      const target = users.find(u=>u.id===userM[1]);
      if (!target) return err('帳號不存在',404);
      if (target.isAdmin) return err('無法刪除管理員帳號');
      await saveUsers(env, users.filter(u=>u.id!==userM[1]));
      return ok({ok:true});
    }

    // ── POST /report → Notion ─────────────────────────────────────────────
    if (path==='/report' && m==='POST') {
      const p = await auth(req,env);
      if (!p) return err('未授權',401);
      if (!p.isAdmin && !p.canReport) return err('無報告權限',403);
      if (!env.NOTION_TOKEN || !env.NOTION_DB_ID) return err('Notion 未設定',500);

      const report = await req.json().catch(()=>({}));
      const meta = report.meta || {};

      const notionRes = await fetch('https://api.notion.com/v1/pages', {
        method:'POST',
        headers:{'Authorization':'Bearer '+env.NOTION_TOKEN,'Content-Type':'application/json','Notion-Version':'2022-06-28'},
        body:JSON.stringify({
          parent:{database_id:env.NOTION_DB_ID},
          properties:{
            '工程名稱':{title:[{text:{content:meta.proj||'未命名'}}]},
            '提交者':  {rich_text:[{text:{content:p.name}}]},
            '日期':    {date:{start:meta.date||new Date().toISOString().split('T')[0]}},
            '完成率':  {number:meta.pct||0},
            '符合':    {number:meta.pass||0},
            '問題':    {number:meta.issue||0},
            '不適用':  {number:meta.na||0},
          }
        })
      });

      if (!notionRes.ok) return err('Notion 錯誤: '+(await notionRes.text()), 502);
      const page = await notionRes.json();
      return ok({ok:true, pageId:page.id, url:page.url});
    }

    return err('Not Found', 404);
  }
};
