# OpenAI Apps directory — submission pack for TaskLite

Portal: https://platform.openai.com/plugins (needs an OpenAI Platform login with
"Apps Management: write" and a verified developer identity under
Settings → Organization → General).

## Info tab

- **Name:** TaskLite
- **Short description:** Build a real backend from a conversation: boards, typed columns, relations, a published REST API and an admin UI, without leaving ChatGPT.
- **Long description:**
  TaskLite turns a description of a business process into a working backend. Ask ChatGPT for
  a repair shop, a clinic, a small store, and TaskLite creates the project, the boards
  (plain data tables by default), typed columns with validation, relations between tables,
  sample rows, and optionally a published REST API with an OpenAPI document and a server-side
  key. Every board is also a full admin UI at app.tasklite.net with table, kanban, calendar
  and form views, comments, automations and webhooks, so the people who run the business get
  their tool on day one. Frontends built by ChatGPT can be deployed to a
  `{slug}.tasklite.dev` host with a proxy to the API. 40 tools cover the whole lifecycle:
  model, seed, query, publish, automate, deploy.
- **Category:** Developer tools (fallback: Productivity)
- **Website:** https://tasklite.net
- **Support URL:** https://tasklite.net/contact
- **Privacy policy:** https://tasklite.net/privacy
- **Terms:** https://tasklite.net/terms
- **Logo:** tasklite-web/app/icon.png (check the required size in the form; export from the
  source SVG if a larger square is needed)

## MCP tab

- **URL type:** Universal
- **Production MCP server URL:** https://mcp.tasklite.net/mcp
- **Authentication:** OAuth 2.1 (PKCE, dynamic client registration) served by the MCP host;
  consent page at app.tasklite.net/oauth/consent.
- **Demo credentials:** a TaskLite account with sample data, no MFA. Shimon creates it
  (e.g. demo-openai@tasklite.net) and seeds it with one project such as "Bike Repair Shop"
  (Customers, Services, Repair Orders, a published API).
- **Content Security Policy:** none needed. No UI components; tools return JSON/text only.
- **Domain verification token:** the form gives a token; serve it at
  `https://mcp.tasklite.net/.well-known/openai-apps-challenge` via
  `/etc/nginx/conf.d/tasklite-mcp.conf`:
  ```
  location = /.well-known/openai-apps-challenge { default_type text/plain; return 200 "<token>"; }
  ```
- **Tool annotations:** every tool carries `readOnlyHint`, `destructiveHint`, `openWorldHint`
  (`src/tools.ts`). Justification for the reviewer:
  - read-only (list_*, get_*, query_items, search, fetch, get_app_spec, get_frontend_prompt):
    no writes.
  - write, non-destructive (create_*, update_*, set_cell, add_comment, build_backend,
    publish_app, deploy_frontend): create or edit the user's own data in their organization.
  - destructive (delete_item, delete_board, delete_column, delete_comment, delete_project):
    remove the user's own data; the admin UI keeps a recycle bin for projects.
  - open world: only deploy_frontend (publishes a static site) and webhooks/automations
    (call URLs the user configured).
  - Responses never include secrets other than an API key the user explicitly asked to create,
    returned once.

## Prompts tab (starter prompts)

1. Build me a backend for a bike repair shop: customers, services with prices, repair orders
   linked to both, and a REST API I can call from a website.
2. Set up a patient intake system for a small clinic with appointments, a status workflow and
   a form the front desk can use.
3. Create an inventory board for my store with products, suppliers and stock levels, then
   add a rule that flags anything under 5 units.
4. Show me the projects in my TaskLite workspace and summarize what is open this week.
5. Add a "Priority customer" checkbox to my Customers board and mark everyone with more than
   three orders.

## Testing tab

Positive (5):

| # | Prompt | Expected behaviour | Result shape |
|---|--------|--------------------|--------------|
| 1 | "Build a backend for a bike repair shop with customers, services and repair orders, and publish an API" | `build_backend` runs once, creates 3 data boards, relations, sample rows, a published app with 3 endpoints and a key | `{ built: true, project, boards[3], api: { endpoints[3], apiKey } }` |
| 2 | "List my projects" | `list_organizations` then `list_projects`; no writes | array of projects with ids and names |
| 3 | "Add a customer named Sam Miller with phone 052-555-0142 to Customers" | `get_board_schema` then `create_item` with cells | the created item with id and title |
| 4 | "Change Order 1001 to Completed" | `query_items` to find it, `update_item`/`set_cell` on the status column | the updated item |
| 5 | "Give me the OpenAPI spec of my Bike Repair API" | `get_app_spec`, read-only | OpenAPI 3 JSON |

Negative (3):

| # | Scenario | Expected | Why |
|---|----------|----------|-----|
| 1 | Spec with a relation to a board that is not in the spec, or a row that names a customer that does not exist | `build_backend` returns `built: false` with a `problems` list and creates nothing | preflight validation is atomic; no partial backends |
| 2 | "Delete the whole Customers board" | ChatGPT asks for confirmation before `delete_board` (destructiveHint) | destructive action on user data |
| 3 | User is only a viewer in the organization | write tools return a permission error from the server; no data changes | server-side role checks, MCP does not bypass them |

## Global tab

Worldwide. Terms and support operate in English and Hebrew.

## Submit tab

Release notes (initial): "First public listing. @tasklite/mcp 0.9.0: 40 hosted tools, build_backend composite tool with preflight validation, data boards, relation expansion in the App API, OAuth 2.1."

## Assets already prepared

- Demo video: `tasklite-video/out/OpenAI-Apps-Final.mp4` (56 s, real ChatGPT session).
- Screenshots not required (no UI components).
