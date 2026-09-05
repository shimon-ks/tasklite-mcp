// Publish server.json to the official MCP registry using DNS authentication,
// without the mcp-publisher binary: sign a timestamp with the ed25519 key
// whose public half is in the tasklite.net TXT record
// ("v=MCPv1; k=ed25519; p=<base64>"), exchange it for a registry JWT, publish.
//
//   node scripts/registry-publish.mjs            # publish server.json
//   node scripts/registry-publish.mjs --check    # only verify DNS + auth
//
// Key file: MCP_REGISTRY_KEY (path) or C:/kristech/keys/mcp-registry-tasklite.key,
// 64 hex chars = raw ed25519 seed (the same format mcp-publisher uses).
import { createPrivateKey, sign as edSign, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveTxt } from 'node:dns/promises';

const REGISTRY = process.env.MCP_REGISTRY_URL || 'https://registry.modelcontextprotocol.io';
const DOMAIN = 'tasklite.net';
const keyPath = process.env.MCP_REGISTRY_KEY || 'C:/kristech/keys/mcp-registry-tasklite.key';
const checkOnly = process.argv.includes('--check');

const seed = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex');
if (seed.length !== 32) throw new Error(`key file must hold 64 hex chars, got ${seed.length * 2}`);
// PKCS#8 wrapper for a raw ed25519 seed
const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
const pubB64 = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

const txt = (await resolveTxt(DOMAIN).catch(() => [])).map((r) => r.join(''));
const ours = txt.find((t) => t.includes(`p=${pubB64}`));
console.log(`public key: ${pubB64}`);
console.log(ours ? 'DNS: TXT record with this key is live' : `DNS: no TXT record with this key yet (found: ${txt.filter((t) => t.includes('MCPv1')).join(' | ') || 'none'})`);
if (!ours) {
  console.log(`Add to ${DOMAIN}:  TXT  v=MCPv1; k=ed25519; p=${pubB64}`);
  process.exit(2);
}

const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const signed_timestamp = edSign(null, Buffer.from(timestamp), privateKey).toString('hex');
const auth = await fetch(`${REGISTRY}/v0/auth/dns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ domain: DOMAIN, timestamp, signed_timestamp }),
});
const authBody = await auth.json().catch(() => ({}));
if (!auth.ok) throw new Error(`auth failed ${auth.status}: ${JSON.stringify(authBody)}`);
console.log('auth: registry token obtained');
if (checkOnly) process.exit(0);

const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
const res = await fetch(`${REGISTRY}/v0/publish`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${authBody.registry_token}` },
  body: JSON.stringify(server),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) throw new Error(`publish failed ${res.status}: ${JSON.stringify(body)}`);
console.log(`published ${server.name} ${server.version}: status=${body?._meta?.['io.modelcontextprotocol.registry/official']?.status ?? 'ok'}`);
