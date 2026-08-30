/** Hosted-mode test: per-request Bearer auth over Streamable HTTP. */
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const API_URL = process.env.TASKLITE_API_URL || 'http://localhost:3334';
const KEY = process.env.TASKLITE_TEST_KEY;
if (!KEY) throw new Error('Set TASKLITE_TEST_KEY=tl_...');

const PORT = 8811;
const child = spawn(process.execPath, ['dist/http.js'], {
  env: { ...process.env, PORT: String(PORT), TASKLITE_API_URL: API_URL },
  stdio: ['ignore', 'inherit', 'inherit'],
});

await new Promise((r) => setTimeout(r, 1200));

try {
  // 1. No auth → 401 with WWW-Authenticate
  const unauth = await fetch(`http://localhost:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
  });
  console.log(`✔ no-auth → ${unauth.status}, WWW-Authenticate: ${unauth.headers.get('www-authenticate')}`);
  if (unauth.status !== 401) throw new Error('expected 401');

  // 2. Authenticated MCP client
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
  });
  const client = new Client({ name: 'http-test', version: '0.0.1' });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  console.log(`✔ tools over HTTP: ${names.length} (sign_up excluded: ${!names.includes('sign_up')})`);

  const res = await client.callTool({ name: 'list_organizations', arguments: {} });
  if (res.isError) throw new Error(res.content?.[0]?.text);
  const orgs = JSON.parse(res.content[0].text);
  console.log(`✔ list_organizations via hosted MCP: ${orgs.length ?? orgs?.items?.length} org(s)`);

  await client.close();
  console.log('\n=== HOSTED MODE PASSED ===');
} finally {
  child.kill();
}
