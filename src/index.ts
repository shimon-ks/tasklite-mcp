#!/usr/bin/env node
/**
 * TaskLite MCP — stdio entry (Claude Code local install).
 * Single-user: credential from env TASKLITE_API_KEY or ~/.tasklite/credentials.json;
 * the sign_up tool can create both from the conversation.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TaskLiteApi, readStoredApiKey, saveApiKey, clearApiKey } from './api.js';
import { registerTools } from './tools.js';
import { VERSION } from './version.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';

const storedKey = readStoredApiKey();
let activeApi: TaskLiteApi | null = storedKey.startsWith('tl_') ? new TaskLiteApi(storedKey) : null;

const getApi = (): TaskLiteApi => {
  if (!activeApi) {
    throw new Error(
      'Not connected to TaskLite yet. For a new account use the sign_up tool; for an existing account create a key at TaskLite → Integrations → "Connect Claude Code" and pass it to the connect tool.',
    );
  }
  return activeApi;
};

const server = new McpServer(
  { name: 'tasklite', version: VERSION },
  { instructions: SERVER_INSTRUCTIONS },
);

registerTools(server, getApi, {
  save: saveApiKey,
  activate: (api) => {
    activeApi = api;
  },
  isConnected: () => activeApi !== null,
  clear: clearApiKey,
});

async function main() {
  await server.connect(new StdioServerTransport());
  console.error('TaskLite MCP server running (stdio)');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
