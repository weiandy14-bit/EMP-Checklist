/**
 * notion-proxy-worker.js
 * Cloudflare Worker — MEP 檢查報告 → Notion
 *
 * 部署步驟：
 *   1. 前往 https://workers.cloudflare.com/ 免費註冊
 *   2. 建立新 Worker → 貼上本程式碼 → 部署
 *   3. 到 Worker 設定 → Variables → 新增 Secret：
 *      名稱：NOTION_TOKEN
 *      值：ntn_Y36273413268N3qINTubBtDxXTJUiBSr3w36Il3SNaK29v
 *   4. 複製 Worker URL（格式：https://xxx.workers.dev）
 *      貼到 index.html 頂部的 WORKER_URL 變數
 */

const NOTION_VER = '2022-06-28';
const DB_ID      = 'bc49a5edcbef4dd1b0ce16a3b52d8b6c'; // 原檢查項目資料庫

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ─── Notion API ────────────────────────────────────────────────────────────
async function notionReq(method, path, body, token) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      'Authorization':  `Bearer ${token}`,
      'Notion-Version': NOTION_VER,
      'Content-Type':   'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Notion ${res.status}: ${err.slice(0, 300)}`);
  }
  return res.json();
}

// ─── 取得父頁面 ID ────────────────────────────────────────────────────────
async function getParentPageId(token) {
  const data   = await notionReq('GET', `/databases/${DB_ID}`, null, token);
  const parent = data.parent || {};
  if (parent.type === 'page_id')  return parent.page_id;
  if (parent.type === 'block_id') return parent.block_id; // 嵌入式頁面
  return null; // workspace 根層
}

// ─── 建立報告資料庫 ───────────────────────────────────────────────────────
async function createReportDb(token, parentPageId) {
  const parent = parentPageId
    ? { type: 'page_id', page_id: parentPageId }
    : { type: 'workspace', workspace: true };

  const db = await notionReq('POST', '/databases', {
    parent,
    icon:  { type: 'emoji', emoji: '📋' },
    title: [{ type: 'text', text: { content: 'MEP 檢查報告' } }],
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
  return db.id;
}

// ─── 建立 Notion Blocks ───────────────────────────────────────────────────
const STATUS_ICON = { pass: '✅ 符合', issue: '❌ 問題', na: '—  不適用', '': '□  待核對' };
const SEV_LABEL   = { A: '🔴 A 必修正', B: '🟡 B 建議確認', C: '🟢 C 建議優化' };

function buildBlocks(report) {
  const { meta, systems } = report;
  const blocks = [];

  // 摘要 Callout
  blocks.push({
    object: 'block', type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '📊' },
      color: 'blue_background',
      rich_text: [{ type: 'text', text: { content:
        `專案：${meta.proj}  |  版次：${meta.rev || '—'}  |  日期：${meta.date || '—'}\n` +
        `送出者：${meta.submitter}  |  完成率：${meta.pct}%  |  ` +
        `符合 ${meta.pass} 項 / 問題 ${meta.issue} 項 / 不適用 ${meta.na} 項 / 共 ${meta.total} 項`
      }}],
    },
  });

  for (const sys of systems) {
    blocks.push({
      object: 'block', type: 'heading_1',
      heading_1: { rich_text: [{ type: 'text', text: { content: `${sys.icon} ${sys.name}` } }] },
    });

    for (const sub of sys.subs) {
      blocks.push({
        object: 'block', type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: `${sub.icon} ${sub.name}` } }] },
      });

      for (const item of sub.items) {
        const status = item.status || '';
        const note   = item.note   || '';
        const color  = status === 'issue' ? 'red_background'
                     : status === 'pass'  ? 'green_background'
                     : status === 'na'    ? 'gray_background' : 'default';
        const emoji  = status === 'pass'  ? '✅'
                     : status === 'issue' ? '❌'
                     : status === 'na'    ? '➖' : '⬜';

        let content = `${STATUS_ICON[status] || '□'}  [${SEV_LABEL[item.sev] || item.sev}]  ${item.text}`;
        if (item.basis) content += `\n📋 ${item.basis}`;
        if (note)       content += `\n📝 備註：${note}`;
        if (content.length > 1990) content = content.slice(0, 1990) + '…';

        blocks.push({
          object: 'block', type: 'callout',
          callout: {
            icon: { type: 'emoji', emoji },
            color,
            rich_text: [{ type: 'text', text: { content } }],
          },
        });
      }
    }
    blocks.push({ object: 'block', type: 'divider', divider: {} });
  }
  return blocks;
}

// ─── 建立報告頁面 ─────────────────────────────────────────────────────────
async function createReportPage(token, reportDbId, report) {
  const { meta } = report;
  const titleStr = `${meta.proj}${meta.rev ? ' ' + meta.rev : ''} ${meta.date || ''}`.trim();

  const props = {
    '報告名稱':  { title:     [{ text: { content: titleStr } }] },
    '專案名稱':  { rich_text: [{ text: { content: meta.proj         || '' } }] },
    '版次':      { rich_text: [{ text: { content: meta.rev          || '' } }] },
    '送出者':    { rich_text: [{ text: { content: meta.submitter    || '' } }] },
    '完成率(%)': { number: meta.pct   ?? 0 },
    '符合項目':  { number: meta.pass  ?? 0 },
    '問題項目':  { number: meta.issue ?? 0 },
    '不適用':    { number: meta.na    ?? 0 },
    '總項目數':  { number: meta.total ?? 0 },
    '送出時間':  { rich_text: [{ text: { content: meta.submittedAt  || '' } }] },
  };
  if (meta.date) props['核對日期'] = { date: { start: meta.date } };

  const blocks = buildBlocks(report);

  // 第一批（最多 100 個 block）
  const page = await notionReq('POST', '/pages', {
    parent:     { database_id: reportDbId },
    icon:       { type: 'emoji', emoji: '📋' },
    properties: props,
    children:   blocks.slice(0, 100),
  }, token);

  const pageId = page.id;

  // 後續批次
  for (let i = 100; i < blocks.length; i += 100) {
    await notionReq('PATCH', `/blocks/${pageId}/children`,
      { children: blocks.slice(i, i + 100) }, token);
  }

  return pageId;
}

// ─── Worker 主程式 ────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }),
        { status: 405, headers: CORS_HEADERS });
    }

    const token = env.NOTION_TOKEN;
    if (!token) {
      return new Response(JSON.stringify({ error: 'NOTION_TOKEN secret 未設定' }),
        { status: 500, headers: CORS_HEADERS });
    }

    try {
      const body = await request.json();
      const { report, reportDbId: existingDbId } = body;

      if (!report || !report.meta || !report.systems) {
        return new Response(JSON.stringify({ error: '無效的報告格式' }),
          { status: 400, headers: CORS_HEADERS });
      }

      // 取得或建立報告資料庫
      let reportDbId = existingDbId || null;

      if (reportDbId) {
        // 驗證資料庫是否還有效
        try {
          const db = await notionReq('GET', `/databases/${reportDbId}`, null, token);
          if (db.archived) reportDbId = null;
        } catch {
          reportDbId = null;
        }
      }

      if (!reportDbId) {
        const parentPageId = await getParentPageId(token);
        reportDbId = await createReportDb(token, parentPageId);
      }

      // 建立報告頁面
      const pageId = await createReportPage(token, reportDbId, report);

      return new Response(JSON.stringify({ success: true, reportDbId, pageId }),
        { headers: CORS_HEADERS });

    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }),
        { status: 500, headers: CORS_HEADERS });
    }
  },
};
