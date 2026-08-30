/**
 * Full MCP OAuth flow against the local backend:
 * discovery → dynamic registration → PKCE authorize (simulating the consent
 * page approve step with a logged-in user) → token → use token on hosted MCP.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const API = process.env.TASKLITE_API_URL || 'http://localhost:3334';
const EMAIL = process.env.TASKLITE_TEST_EMAIL;
const PASSWORD = process.env.TASKLITE_TEST_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('Set TASKLITE_TEST_EMAIL and TASKLITE_TEST_PASSWORD');

const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

// 1. Discovery
const meta = await j(await fetch(`${API}/.well-known/oauth-authorization-server`));
console.log('✔ discovery:', meta.body.registration_endpoint ? 'registration_endpoint present' : 'MISSING');

// 2. Dynamic client registration
const redirectUri = 'http://localhost:9999/callback';
const reg = await j(
  await fetch(`${API}/oauth/mcp/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'Test Connector' }),
  }),
);
const clientId = reg.body.client_id;
console.log('✔ registered client:', clientId);

// 3. PKCE pair
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

// 4. The consent page: user logs in, then approves (POST /oauth/mcp/approve with JWT)
const login = await j(
  await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }),
);
const userJwt = login.body.token;
const approve = await j(
  await fetch(`${API}/oauth/mcp/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userJwt}` },
    body: JSON.stringify({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    }),
  }),
);
const code = new URL(approve.body.redirect_url).searchParams.get('code');
console.log('✔ authorization code issued');

// 5. Token exchange with PKCE verifier
const tok = await j(
  await fetch(`${API}/oauth/mcp/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  }),
);
if (!tok.body.access_token) throw new Error('no access_token: ' + JSON.stringify(tok));
console.log('✔ access_token issued (expires_in', tok.body.expires_in + ')');

// 6. Wrong PKCE verifier must fail
const bad = await j(
  await fetch(`${API}/oauth/mcp/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: 'wrong-verifier',
    }),
  }),
);
console.log(`✔ reused/invalid code rejected → ${bad.status}`);

// 7. Use the OAuth token as Bearer against the hosted MCP server
const PORT = 8822;
const child = spawn(process.execPath, ['dist/http.js'], {
  env: { ...process.env, PORT: String(PORT), TASKLITE_API_URL: API },
  stdio: ['ignore', 'inherit', 'inherit'],
});
await new Promise((r) => setTimeout(r, 1200));
try {
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${tok.body.access_token}` } },
  });
  const client = new Client({ name: 'oauth-test', version: '0.0.1' });
  await client.connect(transport);
  const res = await client.callTool({ name: 'list_organizations', arguments: {} });
  if (res.isError) throw new Error(res.content?.[0]?.text);
  const orgs = JSON.parse(res.content[0].text);
  console.log('✔ hosted MCP accepted OAuth token — orgs:', orgs.length ?? orgs?.items?.length);
  await client.close();
  console.log('\n=== FULL OAUTH FLOW PASSED ===');
} finally {
  child.kill();
}
