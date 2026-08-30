/** Verifies the zero-key journey: connection_status → sign_up → build something. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_URL = process.env.TASKLITE_API_URL || 'http://localhost:3334';
const fakeHome = mkdtempSync(join(tmpdir(), 'tl-mcp-test-'));

const env = { ...process.env, TASKLITE_API_URL: API_URL, HOME: fakeHome, USERPROFILE: fakeHome };
delete env.TASKLITE_API_KEY;

const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env });
const client = new Client({ name: 'signup-test', version: '0.0.1' });
await client.connect(transport);

const parse = (r) => JSON.parse(r.content[0].text);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return parse(r);
};

const before = await call('connection_status', {});
console.log('✔ before:', JSON.stringify(before).slice(0, 90));
if (before.connected) throw new Error('expected disconnected in clean home');

const email = `signup-test-${Date.now()}@tasklite.dev`;
const signed = await call('sign_up', { email, name: 'Signup Test', organizationName: 'עסק הבדיקה' });
console.log('✔ sign_up:', signed.organizationId, '→', signed.credentialsSavedTo);

const after = await call('connection_status', {});
if (!after.connected) throw new Error('still disconnected after sign_up');
console.log('✔ after: connected to', after.organizations?.[0]?.name);

const { project } = await call('create_project', { name: 'הפרויקט הראשון שלי' });
console.log('✔ built a project with zero prior setup:', project.id);

console.log('\n=== ZERO-KEY JOURNEY PASSED ===');
await client.close();
