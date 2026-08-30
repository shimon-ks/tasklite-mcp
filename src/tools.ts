/**
 * All TaskLite MCP tools, bound to a credential-scoped TaskLiteApi via getApi().
 * Used by both entries: stdio (index.ts, single user) and HTTP (http.ts,
 * one api instance per authenticated request). Deterministic by design —
 * zero LLM calls (docs/specs/MCP_SERVER_SPEC.md).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath, join as joinPath } from 'node:path';
import AdmZip from 'adm-zip';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TaskLiteApi, envApiUrl, envAppUrl, envApiKeyOverrides, credentialsPath } from './api.js';

export type GetApi = () => TaskLiteApi;

export interface OnboardingHooks {
  /** Persist a freshly created key; returns where it was saved. */
  save: (apiKey: string) => string;
  /** Swap the active api instance after sign_up/connect; null disconnects. */
  activate: (api: TaskLiteApi | null) => void;
  isConnected: () => boolean;
  /** Forget the stored credential. Returns false if there was none. */
  clear: () => boolean;
}

// Every tool response funnels through here, which makes this the one place that
// can guarantee no internal user row leaves the server — see sanitizeUsersDeep.
function ok(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      { type: 'text', text: JSON.stringify(sanitizeUsersDeep(data), null, 2) },
    ],
  };
}

// Several endpoints embed a user relation as the full internal record (email,
// googleId, phone, telegram id, reset-password token, MFA state, …) — comments
// as the author, projects as the owner, and any other `relations: ['user']`
// read. The backend narrows comments only, so until it narrows the rest, strip
// any user-shaped object here, on every response. Detection keys on
// internal-only columns so ordinary entities with id+name are left untouched.
const USER_PUBLIC_FIELDS = ['id', 'name', 'avatar', 'userType', 'companyName'] as const;
const USER_INTERNAL_MARKERS = ['resetPasswordToken', 'googleId', 'aiTokensLimit', 'mfaEnabled'];

export function sanitizeUsersDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeUsersDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('email' in obj && USER_INTERNAL_MARKERS.some((k) => k in obj)) {
      return Object.fromEntries(
        USER_PUBLIC_FIELDS.filter((k) => k in obj).map((k) => [k, obj[k]]),
      );
    }
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, sanitizeUsersDeep(v)]),
    );
  }
  return value;
}

// Directory requirement: every tool carries a title and a safety hint —
// readOnlyHint for reads, destructiveHint for irreversible writes.
/**
 * Semantic type guard for create_column — the MCP-side twin of the
 * architect's "mandatory semantic mapping" table.
 *
 * Matchers are deliberately narrow (word-ish boundaries, notes exempt) so a
 * "Notes on payment" column stays text while "Install Date" typed text is
 * caught. Hebrew is included because half the customer base names columns in
 * it. Returns null when the pairing is fine.
 */
const NOTES_RE = /(note|notes|comment|remark|memo|הערה|הערות|תיאור)/i;
const TYPE_HINTS: Array<{ re: RegExp; suggest: string }> = [
  { re: /(^|[\s_/(-])(date|deadline|due|תאריך|מועד)($|[\s_/)-])/i, suggest: 'date' },
  { re: /(^|[\s_/(-])(phone|mobile|cell|tel|טלפון|נייד)($|[\s_/)-])/i, suggest: 'phone' },
  { re: /(e-?mail|אימייל|מייל|דוא"ל)/i, suggest: 'email' },
  { re: /(^|[\s_/(-])(price|cost|amount|total|מחיר|עלות|סכום)($|[\s_/)-])/i, suggest: 'currency' },
  { re: /(^|[\s_/(-])(quantity|qty|count|כמות)($|[\s_/)-])/i, suggest: 'number' },
  { re: /(percent|אחוז|%)/i, suggest: 'number' },
  { re: /(^|[\s_/(-])(rating|score|דירוג|ציון)($|[\s_/)-])/i, suggest: 'rating' },
  { re: /(^|[\s_/(-])(status|סטטוס|מצב)($|[\s_/)-])/i, suggest: 'status' },
  { re: /(^|[\s_/(-])(url|link|קישור)($|[\s_/)-])/i, suggest: 'link' },
];

function columnTypeObjection(
  name: string,
  type: string,
  settings?: Record<string, unknown>,
): { rejected: string; suggestedType: string; retry: string } | null {
  if (type === 'text' || type === 'rich_text') {
    if (NOTES_RE.test(name)) return null;
    const hint = TYPE_HINTS.find((h) => h.re.test(name));
    if (hint) {
      return {
        rejected: `column "${name}" typed ${type}, but the name suggests ${hint.suggest}. A ${hint.suggest} column powers calendars/filters/tap-actions; text there is dead data.`,
        suggestedType: hint.suggest,
        retry: `Call create_column again with type:"${hint.suggest}" (add settings.options if it is a closed choice), or force:true if "${name}" really is free text.`,
      };
    }
  }
  if ((type === 'dropdown' || type === 'status') && !(settings as any)?.options?.length) {
    return {
      rejected: `${type} column "${name}" has no settings.options — it would render as an empty select.`,
      suggestedType: type,
      retry: `Call create_column again with settings.options as an array of the real choice labels.`,
    };
  }
  return null;
}

const ANNOTATIONS: Record<string, Record<string, unknown>> = {
  connection_status: { title: 'Check TaskLite connection', readOnlyHint: true },
  sign_up: { title: 'Create TaskLite account', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  connect: { title: 'Connect or switch TaskLite account', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  login: { title: 'Sign in to TaskLite with email and password', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  disconnect: { title: 'Disconnect TaskLite account', readOnlyHint: false, destructiveHint: true },
  list_organizations: { title: 'List organizations', readOnlyHint: true },
  list_projects: { title: 'List projects', readOnlyHint: true },
  create_project: { title: 'Create project', readOnlyHint: false, destructiveHint: false },
  create_board: { title: 'Create board', readOnlyHint: false, destructiveHint: false },
  create_column: { title: 'Add column', readOnlyHint: false, destructiveHint: false },
  get_board_schema: { title: 'Read board schema', readOnlyHint: true },
  query_items: { title: 'List items', readOnlyHint: true },
  create_item: { title: 'Create item', readOnlyHint: false, destructiveHint: false },
  update_item: { title: 'Update item', readOnlyHint: false, destructiveHint: false },
  set_cell: { title: 'Set cell value', readOnlyHint: false, destructiveHint: false },
  delete_item: { title: 'Delete item', readOnlyHint: false, destructiveHint: true },
  list_comments: { title: 'List item comments', readOnlyHint: true },
  add_comment: { title: 'Add a comment to an item', readOnlyHint: false, destructiveHint: false },
  update_comment: { title: 'Edit a comment', readOnlyHint: false, destructiveHint: false },
  delete_comment: { title: 'Delete a comment', readOnlyHint: false, destructiveHint: true },
  create_app: { title: 'Create app', readOnlyHint: false, destructiveHint: false },
  publish_app: { title: 'Publish app', readOnlyHint: false, destructiveHint: false },
  create_app_endpoint: { title: 'Create app endpoint', readOnlyHint: false, destructiveHint: false },
  create_app_api_key: { title: 'Create app API key', readOnlyHint: false, destructiveHint: false },
  list_boards: { title: 'List boards', readOnlyHint: true },
  list_apps: { title: 'List apps', readOnlyHint: true },
  list_app_endpoints: { title: 'List app endpoints', readOnlyHint: true },
  update_app_endpoint: { title: 'Update app endpoint', readOnlyHint: false, destructiveHint: false },
  get_app_spec: { title: 'Get app spec', readOnlyHint: true },
  get_frontend_prompt: { title: 'Get frontend prompt', readOnlyHint: true },
  deploy_frontend: { title: 'Deploy frontend to TaskLite hosting', readOnlyHint: false, destructiveHint: false },
  list_deployments: { title: 'List frontend deployments', readOnlyHint: true },
  rollback_deployment: { title: 'Roll back a frontend deployment', readOnlyHint: false, destructiveHint: false },
};

export function registerTools(
  server: McpServer,
  getApi: GetApi,
  onboarding?: OnboardingHooks,
): void {
  // Wrap server.tool to inject the per-tool annotations (5-arg overload).
  const tool = (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    cb: (...args: any[]) => any,
  ) => server.tool(name, description, schema as any, ANNOTATIONS[name] || {}, cb);

  const resolveOrg = async (organizationId?: string): Promise<string> => {
    if (organizationId) return organizationId;
    const fallback = await getApi().defaultOrganizationId();
    if (!fallback) {
      throw new Error(
        'No organizationId given and none is implied by the credential. Call list_organizations and pass organizationId explicitly.',
      );
    }
    return fallback;
  };

  // ── Onboarding (stdio mode only — hosted mode authenticates via OAuth) ────

  if (onboarding) {
    tool(
      'connection_status',
      'Check whether this machine is connected to a TaskLite account. Call this first if any tool fails with an auth error.',
      {},
      async () => {
        if (!onboarding.isConnected()) {
          return ok({
            connected: false,
            next: 'New user: call sign_up. Existing user: create a key at TaskLite → Integrations → Connect Claude Code, then pass it to the connect tool.',
          });
        }
        try {
          const orgs = await getApi().request<any[]>('GET', '/organizations');
          return ok({
            connected: true,
            organizations: (orgs || []).map((o: any) => ({ id: o.id, name: o.name })),
            switchAccount: 'To use a different account, call connect with that account’s tl_ key.',
          });
        } catch (e) {
          return ok({ connected: false, error: (e as Error).message });
        }
      },
    );

    tool(
      'sign_up',
      'Create a brand-new TaskLite account + organization and connect this machine — no website visit needed. A strong random password is generated locally and never shown or stored; for web access the user later uses "forgot password" with this email. Ask the user for email, their name, and a business name before calling.',
      {
        email: z.string().email(),
        name: z.string().describe("The user's full name"),
        organizationName: z.string().describe('Business/organization name'),
      },
      async ({ email, name, organizationName }) => {
        if (onboarding.isConnected()) {
          throw new Error('Already connected. Call connection_status to see the current account.');
        }
        const password = `Tl1!${randomBytes(24).toString('base64url')}`;
        const apiUrl = envApiUrl();
        const res = await fetch(`${apiUrl}/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, name, password, organizationName, acceptTerms: true }),
        });
        const data: any = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(
            `Sign-up failed (${res.status}): ${JSON.stringify(data?.message ?? data).slice(0, 300)}`,
          );
        }
        const orgId = data.user?.currentOrganizationId;
        const keyRes = await fetch(`${apiUrl}/api-keys`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
          body: JSON.stringify({ name: 'claude-code', organizationId: orgId }),
        });
        const keyData: any = await keyRes.json().catch(() => null);
        if (!keyRes.ok || !keyData?.key) {
          throw new Error(
            `Account created but key creation failed (${keyRes.status}). Create a key at TaskLite → Integrations → Connect Claude Code.`,
          );
        }
        const savedTo = onboarding.save(keyData.key);
        onboarding.activate(new TaskLiteApi(keyData.key));
        return ok({
          connected: true,
          organizationId: orgId,
          credentialsSavedTo: savedTo,
          adminUrl: `${envAppUrl()}/`,
          webAccessNote: `To log into the website later, use "forgot password" with ${email}.`,
        });
      },
    );

    tool(
      'connect',
      'Connect this machine to an existing TaskLite account, or switch to a different one. Takes a personal API key (tl_...) created at TaskLite → Integrations → "Connect Claude Code". Replaces the current connection if there is one — use this to switch user or organization. The switch takes effect immediately; no restart.',
      {
        apiKey: z.string().describe('Personal TaskLite API key, starts with tl_'),
      },
      async ({ apiKey }) => {
        const key = apiKey.trim();
        if (!key.startsWith('tl_')) {
          throw new Error(
            'Not a personal API key. Expected a key starting with "tl_" from TaskLite → Integrations → Connect Claude Code. (App keys starting with "tk_" are for calling app endpoints, not for connecting.)',
          );
        }

        // Verify before persisting, so a bad key can never replace a good one.
        const candidate = new TaskLiteApi(key);
        let orgs: any[];
        try {
          orgs = (await candidate.request<any[]>('GET', '/organizations')) || [];
        } catch (e) {
          throw new Error(`That key was rejected, nothing changed: ${(e as Error).message}`);
        }

        const savedTo = onboarding.save(key);
        onboarding.activate(candidate);

        return ok({
          connected: true,
          organizations: orgs.map((o: any) => ({ id: o.id, name: o.name })),
          defaultOrganizationId: await candidate.defaultOrganizationId(),
          credentialsSavedTo: savedTo,
          ...(envApiKeyOverrides()
            ? {
                warning:
                  'TASKLITE_API_KEY is set in this environment and takes precedence over the saved file. This switch applies to the running server, but the next start will use the env var again — remove it from your MCP server config to make this permanent.',
              }
            : {}),
        });
      },
    );

    tool(
      'login',
      'Connect this machine to an existing TaskLite account with email + password, or switch to a different account. Creates a personal API key named "claude-code" on that account and stores it, so the password is used once and never saved. Replaces the current connection if there is one. Prefer connect when the user already has a tl_ key.',
      {
        email: z.string().email(),
        password: z.string().describe('Used once to mint an API key; never stored'),
      },
      async ({ email, password }) => {
        const apiUrl = envApiUrl();
        const res = await fetch(`${apiUrl}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data: any = await res.json().catch(() => null);

        if (!res.ok) {
          const detail = JSON.stringify(data?.message ?? data).slice(0, 200);
          throw new Error(
            res.status === 429
              ? 'Too many login attempts (limit is 5 per minute). Wait a minute and try again.'
              : `Login failed (${res.status}): ${detail}. Nothing changed.`,
          );
        }

        if (data?.mfaRequired) {
          throw new Error(
            'This account has two-factor authentication enabled, which this tool cannot complete. Nothing changed. Sign in on the website instead and create a key at TaskLite → Integrations → "Connect Claude Code", then pass it to the connect tool.',
          );
        }

        const orgId = data?.user?.currentOrganizationId;
        const keyRes = await fetch(`${apiUrl}/api-keys`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
          body: JSON.stringify({ name: 'claude-code', organizationId: orgId }),
        });
        const keyData: any = await keyRes.json().catch(() => null);
        if (!keyRes.ok || !keyData?.key) {
          throw new Error(
            `Signed in but key creation failed (${keyRes.status}). Nothing changed. Create a key at TaskLite → Integrations → "Connect Claude Code" and pass it to the connect tool.`,
          );
        }

        const api = new TaskLiteApi(keyData.key);
        const orgs = ((await api.request<any[]>('GET', '/organizations')) || []).map((o: any) => ({
          id: o.id,
          name: o.name,
        }));
        const savedTo = onboarding.save(keyData.key);
        onboarding.activate(api);

        return ok({
          connected: true,
          account: { id: data.user?.id, email: data.user?.email, name: data.user?.name },
          organizations: orgs,
          defaultOrganizationId: orgId ?? null,
          credentialsSavedTo: savedTo,
          note: 'A personal API key named "claude-code" was created on this account. Revoke it at TaskLite → Integrations to cut this machine off.',
          ...(envApiKeyOverrides()
            ? {
                warning:
                  'TASKLITE_API_KEY is set in this environment and takes precedence over the saved file. This login applies to the running server, but the next start will use the env var again — remove it from your MCP server config to make this permanent.',
              }
            : {}),
        });
      },
    );

    tool(
      'disconnect',
      'Disconnect this machine from TaskLite by forgetting the stored credential. Use before connecting a different account, or to revoke local access. Does not delete anything in TaskLite itself and does not revoke the key server-side.',
      {},
      async () => {
        const had = onboarding.clear();
        onboarding.activate(null);
        return ok({
          connected: false,
          removedStoredCredential: had,
          credentialsPath,
          next: 'Call connect with another tl_ key to sign in as a different user.',
          ...(envApiKeyOverrides()
            ? {
                warning:
                  'TASKLITE_API_KEY is still set in this environment. The running server is disconnected, but the next start will reconnect from that env var — remove it from your MCP server config for a real disconnect.',
              }
            : {}),
        });
      },
    );
  }

  // ── Group A: schema & structure ────────────────────────────────────────────

  tool(
    'list_organizations',
    'List the organizations the authenticated user belongs to. Use the returned id as organizationId in other tools.',
    {},
    async () => ok(await getApi().request('GET', '/organizations')),
  );

  tool(
    'list_projects',
    'List projects in an organization. The API returns 50 per page — an organization with more than that needs page 2 and beyond, so check the returned total before assuming a project does not exist.',
    {
      organizationId: z.string().optional().describe('Defaults to the credential organization'),
      page: z.number().optional().describe('1-based; defaults to 1'),
      limit: z.number().optional().describe('Defaults to 50'),
    },
    async ({ organizationId, page, limit }) => {
      const orgId = await resolveOrg(organizationId);
      const qs = new URLSearchParams();
      if (page) qs.set('page', String(page));
      if (limit) qs.set('limit', String(limit));
      const suffix = qs.toString() ? `?${qs}` : '';
      return ok(await getApi().request('GET', `/organizations/${orgId}/projects${suffix}`));
    },
  );

  tool(
    'list_boards',
    'List the boards inside a project — id, name, description. Every other board tool needs a boardId, and this is the only way to discover one without being handed a URL.',
    {
      projectId: z.string(),
      page: z.number().optional().describe('1-based; defaults to 1'),
      limit: z.number().optional().describe('Defaults to 50'),
    },
    async ({ projectId, page, limit }) => {
      const qs = new URLSearchParams();
      if (page) qs.set('page', String(page));
      if (limit) qs.set('limit', String(limit));
      const suffix = qs.toString() ? `?${qs}` : '';
      return ok(await getApi().request('GET', `/projects/${projectId}/boards${suffix}`));
    },
  );

  tool(
    'create_project',
    'Create a project (a business process container). Boards with data live inside projects.',
    {
      name: z.string(),
      description: z.string().optional(),
      organizationId: z.string().optional(),
    },
    async ({ name, description, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      const project = await getApi().request<any>('POST', `/organizations/${orgId}/projects`, {
        name,
        organizationId: orgId,
        ...(description ? { description } : {}),
      });
      return ok({ project, adminUrl: getApi().appUrl(`/projects/${project.id}`) });
    },
  );

  tool(
    'create_board',
    'Create a board (a data table) inside a project. Add typed columns with create_column afterwards.',
    {
      projectId: z.string(),
      name: z.string(),
      description: z.string().optional(),
    },
    async ({ projectId, name, description }) => {
      const board = await getApi().request<any>('POST', `/projects/${projectId}/boards`, {
        name,
        projectId,
        ...(description ? { description } : {}),
      });
      return ok({ board, adminUrl: getApi().appUrl(`/projects/${projectId}/boards/${board.id}`) });
    },
  );

  tool(
    'create_column',
    'Add a typed column to a board. Valid types: text, rich_text, number, status, date, datetime, duration, people, checkbox, dropdown, label, priority, link, email, phone, relation, lookup, rollup, formula, rating, currency, file. Choose by meaning — date for dates, phone for phones, number/currency for amounts, dropdown/status (with settings.options as an array of labels) for closed choices; text is for free text only. An obvious name/type mismatch is rejected with the suggested type; pass force:true to override.',
    {
      projectId: z.string(),
      boardId: z.string(),
      name: z.string(),
      type: z.string(),
      settings: z
        .record(z.any())
        .optional()
        .describe(
          'Type-specific settings. For dropdown/status/priority: options, either as labels ["A","B"] or as full objects [{value,label,color}] — labels are expanded server-side, and colors are assigned if you do not supply them.',
        ),
      isRequired: z.boolean().optional(),
      force: z
        .boolean()
        .optional()
        .describe('Create the column even when the name suggests a different type'),
    },
    async ({ projectId, boardId, name, type, settings, isRequired, force }) => {
      // The corrective loop: a model asking for text where the name announces
      // a date/phone/price gets the mismatch back as a tool result and fixes
      // itself on the very next call — instructions alone are advisory, this
      // is enforcement. (A real user built 110 rows with "Install Date" as
      // text; every calendar view and reminder was dead on arrival.)
      if (!force) {
        const objection = columnTypeObjection(name, type, settings);
        if (objection) return ok({ created: false, ...objection });
      }
      const column = await getApi().request<any>(
        'POST',
        `/projects/${projectId}/boards/${boardId}/columns`,
        {
          name,
          type,
          ...(settings ? { settings } : {}),
          ...(isRequired !== undefined ? { isRequired } : {}),
        },
      );
      return ok(column);
    },
  );

  tool(
    'get_board_schema',
    'Get a board with its full column schema (ids, names, types, settings). Call this before creating items with cells.',
    { projectId: z.string(), boardId: z.string() },
    async ({ projectId, boardId }) => {
      const [board, columns] = await Promise.all([
        getApi().request('GET', `/projects/${projectId}/boards/${boardId}`),
        getApi().request('GET', `/projects/${projectId}/boards/${boardId}/columns`),
      ]);
      return ok({ board, columns });
    },
  );

  // ── Group B: data ──────────────────────────────────────────────────────────

  tool(
    'query_items',
    'List items (rows) of a board, including their cell values. Returns all items unless limit/page are given (the API defaults to 50 per page when unpaged, so the tool pages through and concatenates).',
    {
      projectId: z.string(),
      boardId: z.string(),
      limit: z.number().int().positive().max(500).optional().describe('Page size; omit to fetch all items'),
      page: z.number().int().positive().optional().describe('1-based page, only with limit'),
    },
    async ({ projectId, boardId, limit, page }) => {
      const base = `/projects/${projectId}/boards/${boardId}/items`;
      if (limit) {
        const qs = new URLSearchParams({ limit: String(limit) });
        if (page) qs.set('page', String(page));
        return ok(await getApi().request('GET', `${base}?${qs.toString()}`));
      }
      // No explicit paging: fetch everything in 200-item pages and concatenate.
      const all: unknown[] = [];
      for (let p = 1; p <= 50; p++) {
        const res = await getApi().request('GET', `${base}?limit=200&page=${p}`);
        const batch = Array.isArray(res)
          ? res
          : ((res as { items?: unknown[]; data?: unknown[] })?.items ??
             (res as { data?: unknown[] })?.data ?? []);
        all.push(...batch);
        if (batch.length < 200) break;
      }
      return ok(all);
    },
  );

  tool(
    'create_item',
    'Create an item (row) on a board. cells maps columnId -> value (use get_board_schema for column ids).',
    {
      projectId: z.string(),
      boardId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      dueDate: z.string().optional().describe('ISO date'),
      tags: z.array(z.string()).optional(),
      cells: z.record(z.any()).optional(),
    },
    async ({ projectId, boardId, ...body }) =>
      ok(await getApi().request('POST', `/projects/${projectId}/boards/${boardId}/items`, body)),
  );

  tool(
    'update_item',
    'Update item fields (title, description, status, priority, dueDate, tags).',
    {
      projectId: z.string(),
      boardId: z.string(),
      itemId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      dueDate: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ projectId, boardId, itemId, ...body }) =>
      ok(
        await getApi().request(
          'PATCH',
          `/projects/${projectId}/boards/${boardId}/items/${itemId}`,
          body,
        ),
      ),
  );

  tool(
    'set_cell',
    'Set a single cell value on an item by columnId.',
    {
      projectId: z.string(),
      boardId: z.string(),
      itemId: z.string(),
      columnId: z.string(),
      value: z
        .union([
          z.string(),
          z.number(),
          z.boolean(),
          z.null(),
          z.array(z.unknown()),
          z.record(z.unknown()),
        ])
        .describe('The new cell value; shape depends on the column type'),
    },
    async ({ projectId, boardId, itemId, columnId, value }) =>
      ok(
        await getApi().request(
          'PUT',
          `/projects/${projectId}/boards/${boardId}/items/${itemId}/cells/by-column/${columnId}`,
          { value },
        ),
      ),
  );

  tool(
    'delete_item',
    'Delete an item. Destructive — confirm with the user before calling.',
    { projectId: z.string(), boardId: z.string(), itemId: z.string() },
    async ({ projectId, boardId, itemId }) =>
      ok(
        await getApi().request(
          'DELETE',
          `/projects/${projectId}/boards/${boardId}/items/${itemId}`,
        ),
      ),
  );

  // ── Group B2: comments (the item's correspondence thread) ──────────────────

  tool(
    'list_comments',
    'List the comments (the correspondence thread) on an item, oldest first. Each comment includes its author and any @mentions. Needs projectId and itemId (get itemId from query_items).',
    {
      projectId: z.string(),
      itemId: z.string(),
      page: z.number().int().positive().optional().describe('1-based page, default 1'),
      limit: z.number().int().positive().max(100).optional().describe('Page size, default 20'),
    },
    async ({ projectId, itemId, page, limit }) => {
      const qs = new URLSearchParams();
      if (page) qs.set('page', String(page));
      if (limit) qs.set('limit', String(limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return ok(
        await getApi().request(
          'GET',
          `/projects/${projectId}/items/${itemId}/comments${suffix}`,
        ),
      );
    },
  );

  tool(
    'add_comment',
    "Post a comment on an item's thread. To notify people, pass their user ids in mentionedUserIds (each also appears as an @mention). attachmentIds references already-uploaded files. Needs projectId and itemId.",
    {
      projectId: z.string(),
      itemId: z.string(),
      content: z.string().describe('The comment text'),
      mentionedUserIds: z
        .array(z.string())
        .optional()
        .describe('User ids to @mention and notify'),
      attachmentIds: z
        .array(z.string())
        .optional()
        .describe('Ids of already-uploaded attachments to link'),
    },
    async ({ projectId, itemId, content, mentionedUserIds, attachmentIds }) =>
      ok(
        await getApi().request(
          'POST',
          `/projects/${projectId}/items/${itemId}/comments`,
          {
            content,
            ...(mentionedUserIds ? { mentionedUserIds } : {}),
            ...(attachmentIds ? { attachmentIds } : {}),
          },
        ),
      ),
  );

  tool(
    'update_comment',
    'Edit the text of an existing comment. Only the author can edit their comment. Needs projectId, itemId and the commentId.',
    {
      projectId: z.string(),
      itemId: z.string(),
      commentId: z.string(),
      content: z.string().describe('The new comment text'),
    },
    async ({ projectId, itemId, commentId, content }) =>
      ok(
        await getApi().request(
          'PATCH',
          `/projects/${projectId}/items/${itemId}/comments/${commentId}`,
          { content },
        ),
      ),
  );

  tool(
    'delete_comment',
    'Delete a comment from an item thread. Destructive — confirm with the user before calling. Needs projectId, itemId and the commentId.',
    { projectId: z.string(), itemId: z.string(), commentId: z.string() },
    async ({ projectId, itemId, commentId }) =>
      ok(
        await getApi().request(
          'DELETE',
          `/projects/${projectId}/items/${itemId}/comments/${commentId}`,
        ),
      ),
  );

  // ── Group C: app layer (the backend of an external frontend) ───────────────

  tool(
    'create_app',
    'Create an app — a named API surface over the boards of a project, for an external frontend. Then add endpoints and an API key.',
    { name: z.string(), projectId: z.string(), organizationId: z.string().optional() },
    async ({ name, projectId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      const app = await getApi().request<any>('POST', `/organizations/${orgId}/apps`, {
        name,
        projectId,
      });
      return ok({ app, adminUrl: getApi().appUrl(`/apps/${app.id}`) });
    },
  );

  tool(
    'publish_app',
    'Publish an app — required before its API endpoints accept external calls.',
    { appId: z.string(), organizationId: z.string().optional() },
    async ({ appId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(await getApi().request('POST', `/organizations/${orgId}/apps/${appId}/publish`, {}));
    },
  );

  tool(
    'create_app_endpoint',
    'Expose a board as a REST endpoint of an app: /apps/{appSlug}/api/{slug}. exposedColumns limits which columns are readable/writable. rowLevelSecurity.enabled makes the endpoint per-user: the developer\'s server sends `X-App-User: <their user id>` next to the API key, and the endpoint returns, updates and deletes ONLY that user\'s rows (401 without the header). Use it whenever the app has its own users.',
    {
      appId: z.string(),
      boardId: z.string(),
      slug: z.string(),
      name: z.string(),
      allowedMethods: z.array(z.enum(['GET', 'POST', 'PATCH', 'DELETE'])).optional(),
      exposedColumns: z
        .array(
          z.object({
            columnId: z.string(),
            alias: z.string().optional(),
            readOnly: z.boolean().optional(),
          }),
        )
        .optional(),
      rowLevelSecurity: z
        .object({ enabled: z.boolean(), filterByUserId: z.boolean().optional() })
        .optional(),
      organizationId: z.string().optional(),
    },
    async ({ appId, organizationId, ...body }) => {
      // Without exposedColumns the endpoint answers reads with bare item
      // metadata and drops every field on write. It looks like it works, so
      // say so here rather than let it be discovered weeks later.
      if (!body.exposedColumns?.length) {
        return ok({
          error:
            'exposedColumns is required in practice: an endpoint without it returns only id/title/status on GET and stores nothing on POST/PATCH. Call get_board_schema for the board and pass its column ids.',
        });
      }
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request('POST', `/organizations/${orgId}/apps/${appId}/endpoints`, body),
      );
    },
  );

  tool(
    'list_app_endpoints',
    'List an app\'s REST endpoints — slug, board, allowed methods, and how many columns each exposes. An endpoint exposing 0 columns is broken: it returns only item metadata and silently discards writes.',
    { appId: z.string(), organizationId: z.string().optional() },
    async ({ appId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request('GET', `/organizations/${orgId}/apps/${appId}/endpoints`),
      );
    },
  );

  tool(
    'update_app_endpoint',
    'Change an existing endpoint — most often to set exposedColumns on one that was created without them. Get the endpoint id from list_app_endpoints and the column ids from get_board_schema.',
    {
      appId: z.string(),
      endpointId: z.string(),
      slug: z.string().optional(),
      name: z.string().optional(),
      allowedMethods: z.array(z.enum(['GET', 'POST', 'PATCH', 'DELETE'])).optional(),
      exposedColumns: z
        .array(
          z.object({
            columnId: z.string(),
            alias: z.string().optional(),
            readOnly: z.boolean().optional(),
          }),
        )
        .optional(),
      isActive: z.boolean().optional(),
      organizationId: z.string().optional(),
    },
    async ({ appId, endpointId, organizationId, ...body }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          'PATCH',
          `/organizations/${orgId}/apps/${appId}/endpoints/${endpointId}`,
          body,
        ),
      );
    },
  );

  tool(
    'create_app_api_key',
    'Create an API key for an app. SECURITY: the key must live server-side only (env var, Next.js API routes) — never in browser code. If the app has its own users, the server also sends `X-App-User: <user id>` with the key so per-user endpoints know who is acting.',
    { appId: z.string(), name: z.string().optional(), organizationId: z.string().optional() },
    async ({ appId, name, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request('POST', `/organizations/${orgId}/apps/${appId}/api-keys`, {
          name: name || 'frontend',
        }),
      );
    },
  );

  tool(
    'create_automation',
    'Create an automation on a board: when something happens, do something. The most useful action here is http_request, which calls an external API and writes the answer back into columns — pair it with the "scheduled" trigger and the board keeps itself up to date (prices, exchange rates, shipment status, weather). Triggers: item_created, status_changed, column_value_changed, date_approaching, scheduled. Actions: http_request, send_notification, send_email, change_status, set_column_value, create_cross_board_item, send_webhook.',
    {
      projectId: z.string(),
      boardId: z.string(),
      name: z.string(),
      trigger: z.enum([
        'item_created',
        'status_changed',
        'column_value_changed',
        'date_approaching',
        'scheduled',
      ]),
      triggerConfig: z
        .record(z.any())
        .optional()
        .describe('e.g. { cron: "0 8 * * *" } for scheduled, { columnName } for column_value_changed'),
      actions: z
        .array(
          z.object({
            type: z.string(),
            config: z.record(z.any()),
          }),
        )
        .describe(
          'e.g. [{ type: "http_request", config: { url: "https://api.frankfurter.app/latest?from=USD&to=ILS", method: "GET", responseMapping: [{ path: "rates.ILS", columnId: "<column id from get_board_schema>" }] } }]',
        ),
      isActive: z.boolean().optional(),
    },
    async ({ projectId, boardId, name, trigger, triggerConfig, actions, isActive }) => {
      // http_request maps response paths onto real column ids. A model that
      // guessed a name instead would create an automation that runs, succeeds,
      // and writes nothing — so say it plainly rather than let it fail quietly.
      for (const action of actions) {
        if (action.type !== 'http_request') continue;
        const mapping = (action.config as { responseMapping?: unknown })?.responseMapping;
        if (!Array.isArray(mapping) || !mapping.length) {
          return ok({
            error:
              'http_request needs responseMapping: [{ path, columnId }]. Without it the call runs and stores nothing. Get the column ids from get_board_schema.',
          });
        }
        const missing = mapping.filter((m: { columnId?: string }) => !m?.columnId);
        if (missing.length) {
          return ok({
            error:
              'Every responseMapping entry needs a columnId (not a column name). Call get_board_schema for the real ids.',
          });
        }
      }

      const automation = await getApi().request<any>(
        'POST',
        `/projects/${projectId}/boards/${boardId}/automations`,
        { name, trigger, triggerConfig, actions, isActive: isActive ?? true },
      );
      return ok({ automation, adminUrl: getApi().appUrl(`/projects/${projectId}/boards/${boardId}`) });
    },
  );

  tool(
    'list_automations',
    'List the automations on a board, so you can see what already runs before adding another.',
    { projectId: z.string(), boardId: z.string() },
    async ({ projectId, boardId }) =>
      ok(await getApi().request('GET', `/projects/${projectId}/boards/${boardId}/automations`)),
  );

  tool(
    'list_apps',
    'List the apps in the organization — id, slug, status. Call this first when you need an app id: the slug (app-xxxxxx) is what shows up in URLs and in generated code, and this is how you map it back to the app.',
    { organizationId: z.string().optional() },
    async ({ organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(await getApi().request('GET', `/organizations/${orgId}/apps`));
    },
  );

  tool(
    'get_app_spec',
    'Get the machine-readable spec of an app (base URL, endpoints, methods, fields) — use it to generate frontend API calls. appId accepts either the app UUID or its slug (app-xxxxxx); list_apps shows both. The returned baseUrl is absolute — use it verbatim, do not rebuild it from the admin URL.',
    { appId: z.string(), organizationId: z.string().optional() },
    async ({ appId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(await getApi().request('GET', `/organizations/${orgId}/apps/${appId}/spec/json`));
    },
  );

  tool(
    'get_frontend_prompt',
    'Get a ready-made prompt describing the app backend, for pasting into a frontend generator (v0/bolt/lovable/cursor). appId accepts the app UUID or its slug (app-xxxxxx) — use list_apps to find it.',
    {
      appId: z.string(),
      tool: z.enum(['v0', 'bolt', 'lovable', 'cursor']),
      organizationId: z.string().optional(),
    },
    async ({ appId, tool, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          'GET',
          `/organizations/${orgId}/apps/${appId}/spec/prompt/${tool}`,
        ),
      );
    },
  );

  // ── Frontend hosting ({slug}.tasklite.dev) ────────────────────────────────

  tool(
    'deploy_frontend',
    'Deploy a built static frontend to TaskLite hosting: zips the build output directory (dist/, build/, out/ — the folder that contains index.html), uploads it, and returns the live URL https://{slug}.tasklite.dev. The app is auto-published on first deploy. Runs only where the files are (local/stdio mode). In the frontend, call the app API via relative /api/{endpoint} — the hosting proxy injects the app identity.',
    {
      appId: z.string().describe('App UUID or slug (app-xxxxxx) — see list_apps'),
      dir: z.string().describe('Path to the BUILD OUTPUT directory (the one containing index.html), not the project root'),
      organizationId: z.string().optional(),
    },
    async ({ appId, dir, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      const abs = resolvePath(dir);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        throw new Error(`Directory not found: ${abs}. Run the build first, then pass the output folder (dist/, build/, out/).`);
      }
      if (!existsSync(joinPath(abs, 'index.html'))) {
        const candidate = ['dist', 'build', 'out'].find((d) =>
          existsSync(joinPath(abs, d, 'index.html')),
        );
        throw new Error(
          candidate
            ? `No index.html in ${abs} — did you mean ${joinPath(abs, candidate)}?`
            : `No index.html in ${abs}. Pass the build OUTPUT directory, and build first if you haven't.`,
        );
      }
      const zip = new AdmZip();
      zip.addLocalFolder(abs);
      const buffer = zip.toBuffer();
      if (buffer.length > 50 * 1024 * 1024) {
        throw new Error(`Bundle is ${Math.round(buffer.length / 1024 / 1024)}MB zipped — the limit is 50MB. Static frontends should not embed large media; upload those as attachments instead.`);
      }
      const result = await getApi().requestUpload<Record<string, unknown>>(
        `/organizations/${orgId}/apps/${appId}/deployments`,
        'file',
        'frontend.zip',
        buffer,
      );
      return ok({
        ...result,
        note: 'Live now. Old versions are kept for rollback (rollback_deployment); only the last 5 stay on disk.',
      });
    },
  );

  tool(
    'list_deployments',
    'List the hosted-frontend deployments of an app — versions, which one is live, and the public URL.',
    { appId: z.string(), organizationId: z.string().optional() },
    async ({ appId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request('GET', `/organizations/${orgId}/apps/${appId}/deployments`),
      );
    },
  );

  tool(
    'rollback_deployment',
    'Point the live URL back at a previous deployment version (see list_deployments for available versions).',
    {
      appId: z.string(),
      version: z.number().int().positive(),
      organizationId: z.string().optional(),
    },
    async ({ appId, version, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          'POST',
          `/organizations/${orgId}/apps/${appId}/deployments/${version}/activate`,
        ),
      );
    },
  );
}
