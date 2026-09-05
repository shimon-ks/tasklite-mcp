# @tasklite/mcp

**Documentation: https://tasklite.net/docs**

TaskLite MCP server. Build a full backend from Claude Code (projects, boards, typed columns, data, REST endpoints with API keys), deploy a frontend onto it, and hand your client a ready-made admin.

## Setup

Install the package (and Claude Code if you don't have it), then add the server
by its binary. That avoids a known Windows issue where `claude mcp add`
mis-parses `npx -y`.

```bash
npm install -g @anthropic-ai/claude-code @tasklite/mcp
claude mcp add tasklite -- tasklite-mcp
```

Add `-s user` to `claude mcp add` to make it available in every project
(`claude mcp add -s user tasklite -- tasklite-mcp`); the default scope is the
current project only.

Then tell Claude what you want to build. The `sign_up` tool creates your account, organization, and connection from the conversation (a strong random password is generated locally and never shown; use "forgot password" with your email for web access).

**Already have an account?** Create a key at TaskLite → Integrations → "Connect Claude Code" and use:

```bash
claude mcp add tasklite -e TASKLITE_API_KEY=tl_xxx -- tasklite-mcp
```

### Hosted (no install)

Point any MCP client at the hosted server; there is nothing to install locally:

```bash
claude mcp add --transport http tasklite https://mcp.tasklite.net/mcp \
  --header "Authorization: Bearer tl_xxx"
```

The hosted server is stateless: every request carries its own credential, so
one endpoint serves every account safely.

**Simplest of all: the connector.** In Claude (claude.ai or the desktop app),
Settings → Connectors → add TaskLite, or add it by address using the URL above.
You sign in once over OAuth; there is no key to create or store. Note that the
tools appear in a *new* chat, not in the conversation you were already in.

Optional env: `TASKLITE_API_URL` (default `https://api.tasklite.net`), `TASKLITE_APP_URL` (default `https://app.tasklite.net`).

## Other clients

One hosted server, every MCP client. Full setup notes: https://tasklite.net/docs/guides/connector-from-cursor-codex-desktop

- **Cursor** — [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=tasklite&config=eyJ1cmwiOiAiaHR0cHM6Ly9tY3AudGFza2xpdGUubmV0L21jcCJ9) or put `{"mcpServers":{"tasklite":{"url":"https://mcp.tasklite.net/mcp"}}}` in `.cursor/mcp.json`.
- **VS Code** — [Install in VS Code](vscode:mcp/install?%7B%22name%22%3A%20%22tasklite%22%2C%20%22type%22%3A%20%22http%22%2C%20%22url%22%3A%20%22https%3A//mcp.tasklite.net/mcp%22%7D) or `.vscode/mcp.json` with `{"servers":{"tasklite":{"type":"http","url":"https://mcp.tasklite.net/mcp"}}}`.
- **ChatGPT** — Settings → Connectors (developer mode) → add `https://mcp.tasklite.net/mcp`. The server implements `search` and `fetch`.
- **Gemini CLI** — `gemini extensions install https://github.com/shimon-ks/tasklite-mcp` (this repo ships `gemini-extension.json`), or add `httpUrl` + `oauth` to `~/.gemini/settings.json`.
- **OpenAI Responses API / Agents SDK, Gemini API** — pass the hosted URL with `Authorization: Bearer tl_…`.

## Typical flow (what Claude Code does)

1. `create_project` → `create_board` → `create_column` × N builds the schema.
2. `create_item` / `query_items` seed and inspect data.
3. `create_app` → `create_app_endpoint` (with exposedColumns + RLS) → `create_app_api_key` expose the REST surface for your frontend.
4. `get_app_spec` / `get_frontend_prompt` generate the frontend against it.
5. Every tool returns an `adminUrl`, the ready-made admin for the end client.

## Hosting your frontend

Once the frontend is built, `deploy_frontend` uploads the build output and
returns a live URL at `https://{slug}.tasklite.dev`. No server, no hosting
account, no CI to configure:

```
deploy_frontend(appId: "app-xxxxxx", dir: "./dist")
```

Hosted pages call the app API through the relative path `/api/{endpoint}`. The
hosting proxy attaches the app identity server-side, so the browser never
carries an API key. `list_deployments` shows the versions and
`rollback_deployment` points the live URL back at an earlier one.

## Security model

- The `tl_` key is exchanged for a short-lived JWT (`POST /public/v1/auth/session`); all calls run with the key owner's own permissions, never super-admin.
- App API keys belong in server-side env vars (Next.js API routes), never in browser code. Frontends hosted on `tasklite.dev` need no key at all.

## Development

```bash
npm install
npm run build
TASKLITE_API_KEY=tl_xxx TASKLITE_API_URL=http://localhost:3333 node dist/index.js
```

## License

MIT
