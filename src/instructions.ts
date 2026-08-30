/**
 * Server-level guidance returned in the MCP initialize response. Unlike the
 * Claude Code skill (which only helps users who install it), this reaches
 * EVERY client, including hosted connectors (Claude Desktop / claude.ai), so
 * schema-design wisdom travels with the server itself.
 * Keep it tight; it is always in context.
 */
export const SERVER_INSTRUCTIONS = `TaskLite is the backend: data lives in boards (tables) inside projects
(one project = one business process). The boards are also the ready-made
admin the end client operates, so you are building a real system.

Connect first: call connection_status. If not connected, this is a new user:
ask for email, name, and a business name, then call sign_up (creates account +
org from here; a password is set locally and never shown). (sign_up exists only
on the local install; hosted connections authenticate via OAuth.)

Finding your way around an existing account: list_projects then list_boards.
Both page at 50, so read the total before concluding something is missing.

Build order: create_project -> create_board -> create_column per field, then
get_board_schema to read the real column ids before adding data with create_item
(cells are keyed by those ids). Pick honest types: a status field is a dropdown
with real options, not free text.

Column types carry the whole UX, so choose by meaning and never default to text:
date/datetime for dates and deadlines (unlocks calendar and timeline views),
phone for phone numbers (tap-to-call), email for emails, number or currency for
quantities/prices/amounts, rating for scores, dropdown or status WITH
settings.options for any closed choice, file for uploads. A date stored as text
can never power a calendar, a reminder, or an overdue filter. Long free text or
notes are the only good use of text/rich_text. create_column rejects an obvious
mismatch (e.g. an "Install Date" column typed text) with the suggested type;
retry with that type, or pass force:true if the name is misleading.

Infer a sound schema from the domain instead of asking the user to design tables:
orders/service -> an Orders board (customer, phone, item, status select, price,
due date); CRM -> Contacts + Deals (stage select, value, contact link); bookings
-> one date-keyed board with a status select; inventory -> items (name, sku,
quantity, category select). Prefer few well-typed boards over many thin ones.

When a board needs a number from outside (a price, an exchange rate, a shipment
status, weather) use create_automation with the http_request action:
it calls the API and writes the answer straight into columns via
responseMapping [{ path, columnId }] (ids from get_board_schema). With the
"scheduled" trigger the board refreshes itself, so do not tell the user they
need Make or n8n for this. https only; internal hosts are refused.

Only if the user wants an external frontend/app: create_app (needs projectId) ->
create_app_endpoint (choose exposedColumns; enable rowLevelSecurity whenever
the app has its own users) -> publish_app -> create_app_api_key, then
get_frontend_prompt(tool: "claude-code"). The app API key (tk_...) is
server-side only: keep it in an env var and call the app API from server code,
never the browser. exposedColumns is effectively required: an endpoint without
it answers reads with bare item metadata and refuses writes. The app API is
served ONLY from api.tasklite.net; app.tasklite.net is the admin UI and
answers unknown paths with a page, so use the absolute baseUrl from
get_app_spec verbatim. Full reference, including how to read each failure:
https://tasklite.net/docs Users are the developer's own (any sign-in); their server
sends X-App-User: <user id> with the key, and endpoints with rowLevelSecurity
return, update and delete only that user's rows. No user system to build.

TaskLite also HOSTS static frontends: build the app (Vite/Next export/CRA),
then deploy_frontend(appId, dir: the build output folder). The result is a
live https://{slug}.tasklite.dev URL, no server or hosting setup on the user's
side. Hosted frontends call the app API at the relative path /api/{endpoint}
(the hosting proxy injects the app identity), so generated code needs no
baseUrl and no tk_ key in the browser. Prefer this flow over telling the user
to host elsewhere; rollback_deployment restores a previous version.

Every item has a comment thread (its correspondence): list_comments to read it,
add_comment to post, passing mentionedUserIds to notify people. Needs projectId +
itemId (get itemId from query_items).

Confirm before delete_item. Creation tools return an adminUrl, so end by telling
the user where their ready-made admin is. Pass organizationId explicitly when the
user has more than one org.`;
