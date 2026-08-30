/**
 * End-to-end pilot: drives the TaskLite MCP server exactly the way Claude Code
 * would (MCP client over stdio), building a real backend: project → board →
 * columns → items → app → endpoint → API key → external REST call.
 *
 * Usage: TASKLITE_API_URL=http://localhost:3334 TASKLITE_API_KEY=tl_xxx node scripts/pilot.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const API_URL = process.env.TASKLITE_API_URL || 'http://localhost:3334';

function parse(result) {
  return JSON.parse(result.content[0].text);
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${res.content?.[0]?.text}`);
  return parse(res);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    ...process.env,
    TASKLITE_API_URL: API_URL,
    TASKLITE_APP_URL: 'http://localhost:3000',
  },
});

const client = new Client({ name: 'pilot', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log(`✔ MCP connected — ${tools.tools.length} tools:`, tools.tools.map((t) => t.name).join(', '));

const orgs = await call(client, 'list_organizations', {});
const orgList = Array.isArray(orgs) ? orgs : orgs.data || orgs.organizations || [];
if (!orgList.length) throw new Error('No organizations for this user');
const orgId = orgList[0].id;
console.log(`✔ Organization: ${orgList[0].name} (${orgId})`);

const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
const { project } = await call(client, 'create_project', {
  organizationId: orgId,
  name: `פיילוט MCP — מוסך אופניים ${stamp}`,
  description: 'נוצר אוטומטית על ידי פיילוט ה-MCP',
});
console.log(`✔ Project created: ${project.id}`);

const { board } = await call(client, 'create_board', {
  projectId: project.id,
  name: 'הזמנות תיקון',
});
console.log(`✔ Board created: ${board.id}`);

const colPhone = await call(client, 'create_column', {
  projectId: project.id,
  boardId: board.id,
  name: 'טלפון לקוח',
  type: 'text',
});
const colPrice = await call(client, 'create_column', {
  projectId: project.id,
  boardId: board.id,
  name: 'מחיר',
  type: 'number',
});
console.log(`✔ Columns created: ${colPhone.id}, ${colPrice.id}`);

const schema = await call(client, 'get_board_schema', { projectId: project.id, boardId: board.id });
console.log(`✔ Schema read — ${schema.columns.length} columns`);

await call(client, 'create_item', {
  projectId: project.id,
  boardId: board.id,
  title: 'תיקון פנצ׳ר — יוסי לוי',
  cells: { [colPhone.id]: '050-1234567', [colPrice.id]: 80 },
});
const item2 = await call(client, 'create_item', {
  projectId: project.id,
  boardId: board.id,
  title: 'החלפת שרשרת — דנה כהן',
  cells: { [colPhone.id]: '052-7654321', [colPrice.id]: 150 },
});
console.log(`✔ Items created`);

await call(client, 'set_cell', {
  projectId: project.id,
  boardId: board.id,
  itemId: item2.id,
  columnId: colPrice.id,
  value: 175,
});
console.log(`✔ Cell updated via set_cell`);

const items = await call(client, 'query_items', { projectId: project.id, boardId: board.id });
const itemArr = Array.isArray(items) ? items : items.items || items.data || [];
console.log(`✔ query_items → ${itemArr.length} items`);

const { app } = await call(client, 'create_app', { organizationId: orgId, projectId: project.id, name: `bike-shop-${stamp}` });
console.log(`✔ App created: ${app.id} (slug: ${app.slug})`);

const endpoint = await call(client, 'create_app_endpoint', {
  organizationId: orgId,
  appId: app.id,
  boardId: board.id,
  slug: 'repairs',
  name: 'Repair orders',
  allowedMethods: ['GET', 'POST'],
});
console.log(`✔ Endpoint created: /apps/${app.slug}/api/repairs`);

await call(client, 'publish_app', { organizationId: orgId, appId: app.id });
console.log(`✔ App published`);

const key = await call(client, 'create_app_api_key', { organizationId: orgId, appId: app.id });
const rawAppKey = key.rawKey;
console.log(`✔ App API key created: ${String(rawAppKey).slice(0, 12)}...`);

// The moment of truth: an "external frontend" call — plain REST with the app key
const extRes = await fetch(`${API_URL}/apps/${app.slug}/api/repairs`, {
  headers: { Authorization: `Bearer ${rawAppKey}` },
});
const extData = await extRes.json();
console.log(`✔ EXTERNAL call status ${extRes.status} — rows: ${JSON.stringify(extData).slice(0, 200)}`);

const spec = await call(client, 'get_app_spec', { organizationId: orgId, appId: app.id });
console.log(`✔ App spec fetched (${JSON.stringify(spec).length} bytes)`);

console.log('\n=== PILOT PASSED — full chain: MCP → schema → data → app → external REST ===');
console.log(`Admin: http://localhost:3000/projects/${project.id}`);
await client.close();
