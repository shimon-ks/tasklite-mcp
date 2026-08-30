/**
 * Demo frontend for a TaskLite-backed app: the shape a generated frontend takes.
 *
 * The pattern that matters: the tk_ app key lives HERE, server-side (env var),
 * and the browser only ever talks to this server. TaskLite is the database,
 * the workflow engine, and the ready-made admin.
 *
 * Run: TASKLITE_API_URL=http://localhost:3334 APP_SLUG=bike-shop-234633 APP_KEY=tk_xxx node server.mjs
 */
import http from 'node:http';

const API = (process.env.TASKLITE_API_URL || 'http://localhost:3334').replace(/\/+$/, '');
const SLUG = process.env.APP_SLUG || 'bike-shop-234633';
const KEY = process.env.APP_KEY || '';
const PORT = Number(process.env.PORT || 4400);

const tl = (path, init = {}) =>
  fetch(`${API}/apps/${SLUG}/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

const cellVal = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_HE = { todo: 'ממתין', in_progress: 'בטיפול', done: 'הושלם' };

function page(rows, notice) {
  const trs = rows
    .map(
      (r) => `<tr>
        <td>${esc(r.title)}</td>
        <td dir="ltr">${esc(cellVal(r.phone))}</td>
        <td>${cellVal(r.price) != null ? '₪' + esc(cellVal(r.price)) : '—'}</td>
        <td><span class="st st-${esc(r.status)}">${esc(STATUS_HE[r.status] || r.status)}</span></td>
        <td class="mut">${new Date(r.createdAt).toLocaleDateString('he-IL')}</td>
      </tr>`,
    )
    .join('');
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>מוסך האופניים של יוסי — הזמנות תיקון</title>
<style>
  :root{--acc:#0f766e;--ink:#1a202c;--mut:#718096;--line:#e2e8f0;--bg:#f7fafc}
  *{box-sizing:border-box;margin:0}
  body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--ink);padding:2.5rem 1rem}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:1.5rem;margin-bottom:.2rem}
  .sub{color:var(--mut);margin-bottom:1.6rem;font-size:.9rem}
  .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:1.2rem;margin-bottom:1rem;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  table{width:100%;border-collapse:collapse;font-size:.9rem}
  th{text-align:right;color:var(--mut);font-weight:600;font-size:.75rem;padding:.5rem .6rem;border-bottom:1px solid var(--line)}
  td{padding:.6rem;border-bottom:1px solid var(--line)}
  tr:last-child td{border-bottom:none}
  .st{font-size:.72rem;border-radius:999px;padding:.15rem .6rem;background:#fef3c7;color:#92400e}
  .st-done{background:#d1fae5;color:#065f46}
  .st-in_progress{background:#dbeafe;color:#1e40af}
  .mut{color:var(--mut);font-size:.8rem}
  form{display:flex;gap:.6rem;flex-wrap:wrap}
  input{flex:1;min-width:140px;border:1px solid var(--line);border-radius:8px;padding:.55rem .8rem;font-size:.9rem;font-family:inherit}
  button{background:var(--acc);color:#fff;border:none;border-radius:8px;padding:.55rem 1.4rem;font-size:.9rem;font-weight:600;cursor:pointer;font-family:inherit}
  .notice{background:#d1fae5;color:#065f46;border-radius:8px;padding:.6rem .9rem;margin-bottom:1rem;font-size:.85rem}
  .foot{color:var(--mut);font-size:.75rem;text-align:center;margin-top:1.5rem}
</style></head><body><div class="wrap">
  <h1>🚲 מוסך האופניים של יוסי</h1>
  <p class="sub">הזמנות תיקון — פרונט חיצוני שרץ על TaskLite כ-backend</p>
  ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
  <div class="card">
    <table>
      <thead><tr><th>הזמנה</th><th>טלפון</th><th>מחיר</th><th>סטטוס</th><th>נוצר</th></tr></thead>
      <tbody>${trs || '<tr><td colspan="5" class="mut">אין הזמנות עדיין</td></tr>'}</tbody>
    </table>
  </div>
  <div class="card">
    <form method="POST" action="/new">
      <input name="customer" placeholder="שם הלקוח" required>
      <input name="issue" placeholder="מה התקלה?" required>
      <button type="submit">פתח הזמנת תיקון</button>
    </form>
  </div>
  <p class="foot">Powered by TaskLite · הדאטה מנוהל בלוחות · המוסכניק רואה הכל באדמין המוכן</p>
</div></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/new') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const title = `${params.get('issue')} — ${params.get('customer')}`;
      const created = await tl('/orders', { method: 'POST', body: JSON.stringify({ title }) });
      if (!created.ok) throw new Error(`create failed: ${created.status}`);
      res.writeHead(303, { Location: '/?created=1' });
      res.end();
      return;
    }

    const apiRes = await tl('/orders');
    if (!apiRes.ok) throw new Error(`TaskLite API returned ${apiRes.status}`);
    const data = await apiRes.json();
    const url = new URL(req.url, 'http://x');
    const notice = url.searchParams.get('created') ? 'ההזמנה נפתחה — המוסך כבר רואה אותה בלוח' : '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(data.items || [], notice));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`שגיאה: ${err.message}`);
  }
});

server.listen(PORT, () => console.log(`Bike shop frontend → http://localhost:${PORT}`));
