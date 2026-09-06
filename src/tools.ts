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
  configure_external_access: { title: 'Configure external user access', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  list_projects: { title: 'List projects', readOnlyHint: true },
  create_project: { title: 'Create project', readOnlyHint: false, destructiveHint: false },
  create_board: { title: 'Create board', readOnlyHint: false, destructiveHint: false },
  create_column: { title: 'Add column', readOnlyHint: false, destructiveHint: false },
  get_board_schema: { title: 'Read board schema', readOnlyHint: true },
  update_board: { title: 'Update board', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  delete_board: { title: 'Delete board', readOnlyHint: false, destructiveHint: true },
  update_column: { title: 'Update column', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  delete_column: { title: 'Delete column', readOnlyHint: false, destructiveHint: true },
  reorder_columns: { title: 'Reorder columns', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
  build_backend: { title: 'Build a backend in one call', readOnlyHint: false, destructiveHint: false },
  list_boards: { title: 'List boards', readOnlyHint: true },
  list_apps: { title: 'List apps', readOnlyHint: true },
  list_app_endpoints: { title: 'List app endpoints', readOnlyHint: true },
  update_app_endpoint: { title: 'Update app endpoint', readOnlyHint: false, destructiveHint: false },
  get_app_spec: { title: 'Get app spec', readOnlyHint: true },
  get_frontend_prompt: { title: 'Get frontend prompt', readOnlyHint: true },
  search: { title: 'Search projects, boards and items', readOnlyHint: true },
  export_project: { title: 'Export project as JSON', readOnlyHint: true },
  fetch: { title: 'Fetch one record by id', readOnlyHint: true },
  deploy_frontend: { title: 'Deploy frontend to TaskLite hosting', readOnlyHint: false, destructiveHint: false },
  list_deployments: { title: 'List frontend deployments', readOnlyHint: true },
  rollback_deployment: { title: 'Roll back a frontend deployment', readOnlyHint: false, destructiveHint: false },
  create_automation: { title: 'Create automation', readOnlyHint: false, destructiveHint: false },
  list_automations: { title: 'List automations', readOnlyHint: true },
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
  ) => {
    // An empty annotations object is indistinguishable from an empty zod shape
    // to the SDK's overload parser, which then treats it as the callback and the
    // tool dies with "typedHandler is not a function". Only pass real annotations.
    const annotations = ANNOTATIONS[name];
    return annotations
      ? server.tool(name, description, schema as any, annotations, cb)
      : server.tool(name, description, schema as any, cb);
  };

  const resolveOrg = async (organizationId?: string): Promise<string> => {
    if (organizationId) return organizationId;
    const fallback = await getApi().defaultOrganizationId();
    if (fallback) return fallback;
    // No usable default. Name the candidates here so the model can choose in
    // this same turn instead of spending a round trip on list_organizations.
    const orgs = await getApi().writableOrganizations();
    if (orgs.length === 0) {
      throw new Error(
        `This account has no organization it can write to. Create one at ${getApi().appUrl('/')} or ask an organization admin for access.`,
      );
    }
    const named = orgs.map((o) => `"${o.name}" = ${o.id}`).join('; ');
    throw new Error(
      `This account belongs to ${orgs.length} organizations, so pass organizationId. Candidates: ${named}. If the user did not say which, ask, or pick the one whose name matches the request.`,
    );
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
        email: z.string().email().describe('Email address'),
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
        email: z.string().email().describe('Email address'),
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
    'configure_external_access',
    'Read or change how EXTERNAL users (people who sign up to your app through TaskLite auth: POST /auth/register-external with this organizationId, then POST /auth/login) get into an organization. registrationPolicy: "open" — in at once; "approval" — an organization admin approves each signup (TaskLite mails the admins on every signup, and the person once approved; unapproved users are never billed); "closed" — invite only, self-signup refused. appLoginUrl: the page of YOUR app where these users log in — it becomes the "Log in" button in the approval email, so set it whenever you deploy an app that uses this flow; pass "" to clear. Call with no changes to just read the current settings. Requires organization admin.',
    {
      organizationId: z.string().optional().describe('Defaults to the credential organization'),
      registrationPolicy: z.enum(['closed', 'approval', 'open']).optional().describe('How external sign-ups are admitted: open, approval or closed'),
      appLoginUrl: z
        .string()
        .optional()
        .describe("https URL of your app's login page for external users; \"\" clears it"),
    },
    async ({ organizationId, registrationPolicy, appLoginUrl }) => {
      const orgId = await resolveOrg(organizationId);
      const settings: Record<string, unknown> = {};
      if (registrationPolicy !== undefined) settings.externalRegistrationPolicy = registrationPolicy;
      if (appLoginUrl !== undefined) {
        const value = appLoginUrl.trim();
        if (value && !/^https?:\/\/\S+$/i.test(value)) {
          throw new Error('appLoginUrl must be an absolute http(s) URL, e.g. https://app.example.com/login');
        }
        settings.externalAppUrl = value;
      }
      const org =
        Object.keys(settings).length > 0
          ? await getApi().request<any>('PATCH', `/organizations/${orgId}`, { settings })
          : await getApi().request<any>('GET', `/organizations/${orgId}`);
      const current = (org && org.settings) || {};
      return ok({
        organizationId: orgId,
        registrationPolicy: current.externalRegistrationPolicy || 'closed',
        appLoginUrl: current.externalAppUrl || null,
        approvalsUrl: `${envAppUrl()}/organization/settings`,
        signupEndpoint: `${envApiUrl()}/auth/register-external`,
        loginEndpoint: `${envApiUrl()}/auth/login`,
        note:
          (current.externalRegistrationPolicy || 'closed') === 'approval'
            ? 'Each signup waits for an admin; admins are emailed with a link to approvalsUrl, and the user is emailed (with appLoginUrl as the button) once approved.'
            : (current.externalRegistrationPolicy || 'closed') === 'open'
              ? 'Signups are active immediately.'
              : 'Self-signup is refused; external users are created by an admin.',
      });
    },
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
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
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
      name: z.string().describe('Human-readable name'),
      description: z.string().optional().describe('Free-text description'),
      organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted'),
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
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      name: z.string().describe('Human-readable name'),
      description: z.string().optional().describe('Free-text description'),
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
    'Add a typed column to a board. Valid types: text, rich_text, number, status, date, datetime, duration, people, checkbox, dropdown, label, priority, link, email, phone, relation, lookup, rollup, formula, rating, currency, file. Choose by meaning — date for dates, phone for phones, number/currency for amounts, dropdown/status (with settings.options as an array of labels) for closed choices; text is for free text only. An obvious name/type mismatch is rejected with the suggested type; pass force:true to override. Rules go in settings.validation: { unique, min, max, minLength, maxLength, pattern, patternMessage } — enforced on every write (UI, MCP, App API). Closed choices (dropdown/status) reject values outside settings.options unless settings.allowCustom is true.',
    {
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      boardId: z.string().describe('Board id (from list_boards / create_board)'),
      name: z.string().describe('Human-readable name'),
      type: z.string().describe('Column type: text, rich_text, number, status, date, datetime, duration, people, checkbox, dropdown, label, priority, link, email, phone, relation, lookup, rollup, rating, currency, file'),
      settings: z
        .record(z.any())
        .optional()
        .describe(
          'Type-specific settings. For dropdown/status/priority: options, either as labels ["A","B"] or as full objects [{value,label,color}] — labels are expanded server-side, and colors are assigned if you do not supply them.',
        ),
      isRequired: z.boolean().optional().describe('Require a non-blank value on every App API create'),
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
    { projectId: z.string().describe('Project id (from list_projects / create_project)'), boardId: z.string().describe('Board id (from list_boards / create_board)') },
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
    'update_board',
    'Rename a board or change its description. Structure (columns) is changed with update_column / delete_column / reorder_columns.',
    {
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      boardId: z.string().describe('Board id (from list_boards / create_board)'),
      name: z.string().optional().describe('Human-readable name'),
      description: z.string().optional().describe('Free-text description'),
    },
    async ({ projectId, boardId, ...rest }) => {
      const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      return ok(await getApi().request('PATCH', `/projects/${projectId}/boards/${boardId}`, body));
    },
  );

  tool(
    'delete_board',
    'Delete a board with every item on it. Destructive and not undoable — confirm with the user first, and prefer delete_column when only part of the model is wrong.',
    { projectId: z.string().describe('Project id (from list_projects / create_project)'), boardId: z.string().describe('Board id (from list_boards / create_board)') },
    async ({ projectId, boardId }) => {
      await getApi().request('DELETE', `/projects/${projectId}/boards/${boardId}`);
      return ok({ deleted: true, boardId });
    },
  );

  tool(
    'update_column',
    'Change a column after the fact: rename it, change its type (e.g. number -> currency), replace settings (dropdown options), or set isRequired / isHidden. A type change converts existing values (number↔currency, text→number/date/checkbox, anything→text) and clears the ones that cannot convert; the response carries conversion: { converted, cleared }. settings.validation rules apply here too.',
    {
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      boardId: z.string().describe('Board id (from list_boards / create_board)'),
      columnId: z.string().describe('Column id (from get_board_schema)'),
      name: z.string().optional().describe('Human-readable name'),
      type: z.string().optional().describe('New column type (same list as create_column)'),
      settings: z.record(z.unknown()).optional().describe('Replaces the column settings, e.g. { options: [...] } for dropdown/status'),
      isRequired: z.boolean().optional().describe('Require a non-blank value on every App API create'),
      isHidden: z.boolean().optional().describe('Hide the column in the TaskLite UI'),
      description: z.string().optional().describe('Free-text description'),
      force: z.boolean().optional().describe('Skip the name/type sanity check'),
    },
    async ({ projectId, boardId, columnId, force, ...rest }) => {
      const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      if (!force && (body.type || body.name)) {
        // Sanity-check the resulting name/type pair the same way create_column does.
        const cols = await getApi().request<any>('GET', `/projects/${projectId}/boards/${boardId}/columns`);
        const list: any[] = Array.isArray(cols) ? cols : (cols?.items ?? cols?.data ?? []);
        const current = list.find((c) => c.id === columnId);
        const name = (body.name as string | undefined) ?? current?.name;
        const type = (body.type as string | undefined) ?? current?.type;
        if (name && type) {
          const hint = columnTypeObjection(name, type, body.settings ?? current?.settings);
          if (hint) return ok(hint);
        }
      }
      return ok(await getApi().request('PATCH', `/projects/${projectId}/boards/${boardId}/columns/${columnId}`, body));
    },
  );

  tool(
    'delete_column',
    'Delete a column and every value stored in it. Destructive — confirm with the user first. Use update_column when the column is right but its name, type or options are wrong.',
    { projectId: z.string().describe('Project id (from list_projects / create_project)'), boardId: z.string().describe('Board id (from list_boards / create_board)'), columnId: z.string().describe('Column id (from get_board_schema)') },
    async ({ projectId, boardId, columnId }) => {
      await getApi().request('DELETE', `/projects/${projectId}/boards/${boardId}/columns/${columnId}`);
      return ok({ deleted: true, columnId });
    },
  );

  tool(
    'reorder_columns',
    'Set the display order of a board\'s columns. Pass every column id in the wanted order (get_board_schema lists them).',
    { projectId: z.string().describe('Project id (from list_projects / create_project)'), boardId: z.string().describe('Board id (from list_boards / create_board)'), columnIds: z.array(z.string()).min(1).describe('Column ids in the new order (every column of the board)') },
    async ({ projectId, boardId, columnIds }) => {
      return ok(await getApi().request('PUT', `/projects/${projectId}/boards/${boardId}/columns/reorder`, { columnIds }));
    },
  );

  tool(
    'export_project',
    'The whole project as JSON — boards, columns with settings, items with their cells keyed by column id. For migrations, backups and reading a system back. Items are capped per board for the model\'s sake; the REST endpoint GET /organizations/{orgId}/projects/{projectId}/export.json returns everything.',
    {
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      organizationId: z.string().optional().describe('Defaults to the credential organization'),
      maxItemsPerBoard: z.number().int().positive().max(2000).optional().describe('Default 200'),
    },
    async ({ projectId, organizationId, maxItemsPerBoard }) => {
      const orgId = await resolveOrg(organizationId);
      const data = await getApi().request<any>('GET', `/organizations/${orgId}/projects/${projectId}/export.json`);
      const cap = maxItemsPerBoard ?? 200;
      let truncated = false;
      for (const b of data?.boards ?? []) {
        if (Array.isArray(b.items) && b.items.length > cap) {
          b.items = b.items.slice(0, cap);
          b.truncated = true;
          truncated = true;
        }
      }
      return ok({
        ...data,
        ...(truncated
          ? { note: `Some boards were cut to ${cap} items; the REST endpoint returns them all.` }
          : {}),
      });
    },
  );

  tool(
    'query_items',
    'List items (rows) of a board, including their cell values. Returns all items unless limit/page are given (the API defaults to 50 per page when unpaged, so the tool pages through and concatenates).',
    {
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      boardId: z.string().describe('Board id (from list_boards / create_board)'),
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
    'Create an item (row) with all of its data in one call. cells maps columnId -> value (use get_board_schema for column ids); every cell is saved with the row. Use set_cell only for later edits.',
    {
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      boardId: z.string().describe('Board id (from list_boards / create_board)'),
      title: z.string().describe('Item title, shown as the row name'),
      description: z.string().optional().describe('Free-text description'),
      status: z.string().optional().describe('Status value (todo, in_progress, done, or a value from the board\'s status options)'),
      priority: z.string().optional().describe('Priority: low, medium, high or urgent'),
      dueDate: z.string().optional().describe('ISO date'),
      tags: z.array(z.string()).optional().describe('Tags as an array of strings'),
      cells: z.record(z.any()).optional().describe('Cell values keyed by column id: { "<columnId>": value }. Scalars, { amount, currency } for currency, { relatedItemIds: [...] } for relations'),
    },
    async ({ projectId, boardId, ...body }) =>
      ok(await getApi().request('POST', `/projects/${projectId}/boards/${boardId}/items`, body)),
  );

  tool(
    'update_item',
    'Update item fields (title, description, status, priority, dueDate, tags).',
    {
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      boardId: z.string().describe('Board id (from list_boards / create_board)'),
      itemId: z.string().describe('Item (row) id'),
      title: z.string().optional().describe('Item title, shown as the row name'),
      description: z.string().optional().describe('Free-text description'),
      status: z.string().optional().describe('Status value (todo, in_progress, done, or a value from the board\'s status options)'),
      priority: z.string().optional().describe('Priority: low, medium, high or urgent'),
      dueDate: z.string().optional().describe('Due date, ISO 8601 (YYYY-MM-DD or full timestamp)'),
      tags: z.array(z.string()).optional().describe('Tags as an array of strings'),
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
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      boardId: z.string().describe('Board id (from list_boards / create_board)'),
      itemId: z.string().describe('Item (row) id'),
      columnId: z.string().describe('Column id (from get_board_schema)'),
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
    { projectId: z.string().describe('Project id (from list_projects / create_project)'), boardId: z.string().describe('Board id (from list_boards / create_board)'), itemId: z.string().describe('Item id (from query_items / create_item)') },
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
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      itemId: z.string().describe('Item (row) id'),
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
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      itemId: z.string().describe('Item (row) id'),
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
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      itemId: z.string().describe('Item (row) id'),
      commentId: z.string().describe('Comment id (from list_comments)'),
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
    { projectId: z.string().describe('Project id (from list_projects / create_project)'), itemId: z.string().describe('Item id (from query_items / create_item)'), commentId: z.string().describe('Comment id (from list_comments / add_comment)') },
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
    { name: z.string().describe('Human-readable name'), projectId: z.string().describe('Project id (from list_projects / create_project)'), organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted') },
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
    { appId: z.string().describe('App id or slug (from list_apps / create_app)'), organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted') },
    async ({ appId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(await getApi().request('POST', `/organizations/${orgId}/apps/${appId}/publish`, {}));
    },
  );

  tool(
    'create_app_endpoint',
    'Expose a board as a REST endpoint of an app: /apps/{appSlug}/api/{slug}. exposedColumns limits which columns are readable/writable. rowLevelSecurity.enabled makes the endpoint per-user: the developer\'s server sends `X-App-User: <their user id>` next to the API key, and the endpoint returns, updates and deletes ONLY that user\'s rows (401 without the header). Use it whenever the app has its own users.',
    {
      appId: z.string().describe('App id or slug (from list_apps / create_app)'),
      boardId: z.string().describe('Board id (from list_boards / create_board)'),
      slug: z.string().describe('URL slug: lowercase letters, digits and dashes'),
      name: z.string().describe('Human-readable name'),
      allowedMethods: z.array(z.enum(['GET', 'POST', 'PATCH', 'DELETE'])).optional().describe('HTTP methods the endpoint accepts: GET, POST, PATCH, DELETE'),
      exposedColumns: z
        .array(
          z.object({
            columnId: z.string().describe('Column id (from get_board_schema)'),
            alias: z.string().optional().describe('JSON key exposed for this column: letters, digits, underscore. Never one of the reserved item fields id, title, description, status, priority, dueDate, assignedTo, createdAt, updatedAt, order, appUserId — a business status column becomes repairStatus or orderStatus, not status.'),
            readOnly: z.boolean().optional().describe('Expose the column for reading only; writes to it are refused with 400'),
          }),
        )
        .optional()
        .describe('Columns the endpoint reads and writes, with the JSON key each one gets; without it the endpoint returns bare metadata'),
      rowLevelSecurity: z
        .object({ enabled: z.boolean().describe('Scope every request to the calling app user (X-App-User header)'), filterByUserId: z.boolean().optional().describe('Also filter reads to rows the user created') })
        .optional()
        .describe('Row-level security: when enabled, each app user sees and edits only their own rows'),
      organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted'),
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
    { appId: z.string().describe('App id or slug (from list_apps / create_app)'), organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted') },
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
      appId: z.string().describe('App id or slug (from list_apps / create_app)'),
      endpointId: z.string().describe('Endpoint id (from list_app_endpoints)'),
      slug: z.string().optional().describe('URL slug: lowercase letters, digits and dashes'),
      name: z.string().optional().describe('Human-readable name'),
      allowedMethods: z.array(z.enum(['GET', 'POST', 'PATCH', 'DELETE'])).optional().describe('HTTP methods the endpoint accepts: GET, POST, PATCH, DELETE'),
      exposedColumns: z
        .array(
          z.object({
            columnId: z.string().describe('Column id (from get_board_schema)'),
            alias: z.string().optional().describe('JSON key exposed for this column: letters, digits, underscore. Never one of the reserved item fields id, title, description, status, priority, dueDate, assignedTo, createdAt, updatedAt, order, appUserId — a business status column becomes repairStatus or orderStatus, not status.'),
            readOnly: z.boolean().optional().describe('Expose the column for reading only; writes to it are refused with 400'),
          }),
        )
        .optional()
        .describe('Replacement list of exposed columns (same shape as create_app_endpoint)'),
      isActive: z.boolean().optional().describe('Whether it is active'),
      organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted'),
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
    {
      appId: z.string().describe('App id or slug (from list_apps / create_app)'),
      name: z.string().optional().describe('Human-readable name'),
      scopes: z
        .array(z.enum(['read', 'write']))
        .optional()
        .describe('Permissions recorded on the key: ["read"] or ["read","write"]. Omit to match the app: write when any endpoint accepts POST, PATCH or DELETE.'),
      organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted'),
    },
    async ({ appId, name, scopes, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request('POST', `/organizations/${orgId}/apps/${appId}/api-keys`, {
          name: name || 'frontend',
          ...(scopes?.length ? { scopes } : {}),
        }),
      );
    },
  );

  // ── One-call backend ───────────────────────────────────────────────────────
  // The model designs; this executes. Ten tool calls became one because every
  // one of them was a place for the user to see plumbing: organization ids,
  // reserved aliases, column ids, and ten verbose results (an external review
  // of the ChatGPT connector scored exactly those). Deterministic — no model
  // in here, the caller already is one.
  const RESERVED_ALIASES = new Set([
    'id', 'title', 'description', 'status', 'priority', 'duedate', 'assignedto',
    'createdat', 'updatedat', 'order', 'appuserid',
  ]);
  const toAlias = (name: string, index: number, used: Set<string>): string => {
    let base = name
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)
      .map((w, i) =>
        i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1),
      )
      .join('');
    if (!base || /^\d/.test(base)) base = `field${index + 1}`;
    if (RESERVED_ALIASES.has(base.toLowerCase())) base = `${base}Value`;
    let alias = base;
    let n = 2;
    while (used.has(alias.toLowerCase())) alias = `${base}${n++}`;
    used.add(alias.toLowerCase());
    return alias;
  };
  const toSlug = (name: string, index: number, used: Set<string>): string => {
    let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!base) base = `board-${index + 1}`;
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    return slug;
  };

  tool(
    'build_backend',
    'Build a whole backend in one call from a spec you compose: the project, its boards, their typed columns (including relations between the boards), optional sample rows, and optionally a published REST API with one endpoint per board and a server-side key. Use it whenever the user describes a system ("a backend for my repair shop: customers, orders, payments") instead of calling create_project, create_board, create_column, create_app, publish_app, create_app_endpoint and create_app_api_key one by one. You do the design — pick column types by meaning (phone, date, currency, dropdown/status with options for closed choices), link boards with a relation column (type "relation", relatedBoard: "<board name in this spec>", relationType: many_to_one for an order→customer link) — and this tool executes it and returns one compact summary. API field names are derived from column names and never collide with reserved item fields, so there is nothing to retry. Note every board also carries the built-in item fields (title, status, priority, dueDate, assignedTo); name a business status column something specific, e.g. "Repair Status", so it is not confused with the built-in one.',
    {
      project: z
        .object({
          name: z.string().describe('Project name, e.g. "Bike Repair Shop"'),
          description: z.string().optional().describe('One line on what the system is for'),
        })
        .describe('The project that holds the boards'),
      boards: z
        .array(
          z.object({
            name: z.string().describe('Board (table) name, e.g. "Repair Orders"'),
            description: z.string().optional().describe('One line on what a row is'),
            columns: z
              .array(
                z.object({
                  name: z.string().describe('Column name as the user would say it, e.g. "Customer", "Phone", "Repair Status"'),
                  type: z.string().describe('text, rich_text, number, currency, date, datetime, phone, email, link, checkbox, dropdown, status, priority, rating, file, people, relation, label, duration'),
                  options: z.array(z.string()).optional().describe('The closed choices for dropdown/status/priority, e.g. ["Received","In Repair","Ready","Completed"]'),
                  required: z.boolean().optional().describe('Reject API creates that leave it blank'),
                  validation: z.record(z.any()).optional().describe('{ unique, min, max, minLength, maxLength, pattern, patternMessage }'),
                  relatedBoard: z.string().optional().describe('relation columns only: the name of another board in this spec that this column links to, e.g. "Customers"'),
                  relationType: z
                    .enum(['many_to_one', 'one_to_many', 'many_to_many', 'one_to_one'])
                    .optional()
                    .describe('relation columns only. many_to_one: many rows here point at one row there (an order has one customer; a payment has one order). one_to_many: one row here owns many there. many_to_many: both sides several (a job has several tags). one_to_one: exactly one each way. Defaults to many_to_many, which is rarely what a business model means — say it.'),
                  settings: z.record(z.any()).optional().describe('Other type settings, e.g. { currency: "ILS" }. (relatedBoardName / relationType are also accepted here for compatibility.)'),
                  alias: z.string().optional().describe('API field name to use instead of the derived one (letters, digits, underscore; not a reserved item field)'),
                }),
              )
              .min(1)
              .describe('Typed columns of the board'),
            rows: z
              .array(z.record(z.any()))
              .optional()
              .describe('Optional sample rows keyed by column name, e.g. [{ "Customer": "Sam Miller", "Phone": "052-555-0142", "Price": 80 }]. "title" sets the row title, otherwise the first text value is used. A relation cell takes the title(s) of rows in the related board — list the related board earlier in the spec so its rows exist first.'),
          }),
        )
        .min(1)
        .describe('The boards (tables) of the backend, in dependency order: a board whose rows are referenced comes before the boards that reference it'),
      api: z
        .object({
          name: z.string().optional().describe('App name; defaults to "<project> API"'),
          methods: z.array(z.enum(['GET', 'POST', 'PATCH', 'DELETE'])).optional().describe('HTTP methods every endpoint accepts; defaults to all four'),
          rowLevelSecurity: z.boolean().optional().describe('true when the app has its own users and each may see only their rows (the caller then sends X-App-User)'),
        })
        .optional()
        .describe('Include to publish a REST API over every board and mint a key; omit for a boards-only build'),
      organizationId: z.string().optional().describe('Organization id; needed only when the account belongs to several (the error then lists them)'),
    },
    async ({ project, boards, api, organizationId }) => {
      // Validate the whole spec before creating anything: a half-built project
      // after a spec error is worse than a clear refusal.
      const problems: string[] = [];
      const boardNames = new Set(boards.map((b: { name: string }) => b.name.toLowerCase()));
      for (const b of boards) {
        for (const c of b.columns) {
          if ((c.type === 'dropdown' || c.type === 'status' || c.type === 'priority') && !c.options?.length && !(c.settings as any)?.options) {
            problems.push(`${b.name}.${c.name}: ${c.type} needs options`);
          }
          if (c.alias && RESERVED_ALIASES.has(c.alias.toLowerCase())) {
            problems.push(`${b.name}.${c.name}: alias "${c.alias}" is a reserved item field`);
          }
          if (c.type === 'relation') {
            const target = String(c.relatedBoard ?? (c.settings as any)?.relatedBoardName ?? '').toLowerCase();
            if (!target || !boardNames.has(target)) {
              problems.push(`${b.name}.${c.name}: relation needs relatedBoard naming a board in this spec (have: ${boards.map((x: { name: string }) => x.name).join(', ')})`);
            }
          } else if (c.relatedBoard || c.relationType) {
            problems.push(`${b.name}.${c.name}: relatedBoard/relationType only apply to type "relation" (got ${c.type})`);
          }
        }
      }
      if (problems.length) return ok({ built: false, problems });

      const orgId = await resolveOrg(organizationId);
      const client = getApi();
      const notes: string[] = [];
      const created = await client.request<any>('POST', `/organizations/${orgId}/projects`, {
        name: project.name,
        organizationId: orgId,
        ...(project.description ? { description: project.description } : {}),
      });
      try {
        type Col = { id: string; name: string; type: string; alias: string; relatedBoardId?: string; relationType?: string };
        type Built = { id: string; name: string; slug: string; columns: Col[]; rows: number; adminUrl: string };
        const outBoards: Built[] = [];
        const boardIdByName = new Map<string, string>();
        const usedSlugs = new Set<string>();

        // 1. boards first, so relation columns can point at any of them
        for (const [bi, b] of boards.entries()) {
          const board = await client.request<any>('POST', `/projects/${created.id}/boards`, {
            name: b.name,
            projectId: created.id,
            ...(b.description ? { description: b.description } : {}),
          });
          boardIdByName.set(b.name.toLowerCase(), board.id);
          outBoards.push({
            id: board.id,
            name: b.name,
            slug: toSlug(b.name, bi, usedSlugs),
            columns: [],
            rows: 0,
            adminUrl: client.appUrl(`/projects/${created.id}/boards/${board.id}`),
          });
        }

        // 2. columns
        for (const [bi, b] of boards.entries()) {
          const built = outBoards[bi];
          const usedAliases = new Set<string>();
          for (const [ci, c] of b.columns.entries()) {
            let type = c.type;
            const settings: Record<string, unknown> = { ...(c.settings || {}) };
            if (c.options?.length) settings.options = c.options;
            if (c.validation) settings.validation = c.validation;
            let relatedBoardId: string | undefined;
            if (type === 'relation') {
              relatedBoardId = boardIdByName.get(String(c.relatedBoard ?? settings.relatedBoardName).toLowerCase());
              delete settings.relatedBoardName;
              settings.relatedBoardId = relatedBoardId;
              settings.projectId = created.id;
              settings.relationType = c.relationType || settings.relationType || 'many_to_many';
            }
            const objection = columnTypeObjection(c.name, type, settings);
            if (objection && objection.suggestedType !== type) {
              notes.push(`${b.name}.${c.name}: created as ${objection.suggestedType} rather than ${type}, because the name says so`);
              type = objection.suggestedType;
            }
            const column = await client.request<any>(
              'POST',
              `/projects/${created.id}/boards/${built.id}/columns`,
              {
                name: c.name,
                type,
                ...(Object.keys(settings).length ? { settings } : {}),
                ...(c.required !== undefined ? { isRequired: c.required } : {}),
              },
            );
            const alias = c.alias || toAlias(c.name, ci, usedAliases);
            if (c.alias) usedAliases.add(c.alias.toLowerCase());
            built.columns.push({ id: column.id, name: c.name, type, alias, ...(relatedBoardId ? { relatedBoardId, relationType: String(settings.relationType) } : {}) });
          }
        }

        // 3. rows, in spec order; relation cells resolve titles of rows already created
        const itemIdByBoardTitle = new Map<string, Map<string, string>>();
        for (const [bi, b] of boards.entries()) {
          if (!b.rows?.length) continue;
          const built = outBoards[bi];
          const byName = new Map(built.columns.map((c) => [c.name.toLowerCase(), c]));
          const titles = new Map<string, string>();
          itemIdByBoardTitle.set(built.id, titles);
          for (const row of b.rows) {
            const cells: Record<string, unknown> = {};
            let title = typeof row.title === 'string' ? row.title : '';
            for (const [k, v] of Object.entries(row)) {
              if (k === 'title') continue;
              const col = byName.get(k.toLowerCase());
              if (!col) {
                notes.push(`${b.name}: row field "${k}" matches no column and was skipped`);
                continue;
              }
              if (col.type === 'relation' && col.relatedBoardId && (typeof v === 'string' || Array.isArray(v))) {
                const wanted = (Array.isArray(v) ? v : [v]).map(String);
                const lookup = itemIdByBoardTitle.get(col.relatedBoardId) || new Map<string, string>();
                const ids = wanted.map((t) => lookup.get(t.toLowerCase())).filter((x): x is string => Boolean(x));
                if (ids.length < wanted.length) {
                  notes.push(`${b.name}: relation "${col.name}" could not find ${wanted.length - ids.length} of ${wanted.length} referenced rows by title (put the related board and its rows earlier in the spec)`);
                }
                if (ids.length) cells[col.id] = { relatedItemIds: ids };
                continue;
              }
              cells[col.id] = v;
              if (!title && typeof v === 'string') title = v;
            }
            const item = await client.request<any>('POST', `/projects/${created.id}/boards/${built.id}/items`, {
              title: title || `${b.name} ${built.rows + 1}`,
              cells,
            });
            if (item?.id) titles.set(String(item.title ?? title).toLowerCase(), item.id);
            built.rows++;
          }
        }

        let apiOut: Record<string, unknown> | undefined;
        if (api) {
          const app = await client.request<any>('POST', `/organizations/${orgId}/apps`, {
            name: api.name || `${project.name} API`,
            projectId: created.id,
          });
          await client.request('POST', `/organizations/${orgId}/apps/${app.id}/publish`, {});
          const methods = api.methods?.length ? api.methods : ['GET', 'POST', 'PATCH', 'DELETE'];
          const endpoints: Array<Record<string, unknown>> = [];
          for (const b of outBoards) {
            await client.request('POST', `/organizations/${orgId}/apps/${app.id}/endpoints`, {
              boardId: b.id,
              slug: b.slug,
              name: b.name,
              allowedMethods: methods,
              exposedColumns: b.columns.map((c) => ({ columnId: c.id, alias: c.alias })),
              ...(api.rowLevelSecurity ? { rowLevelSecurity: { enabled: true } } : {}),
            });
            endpoints.push({
              board: b.name,
              url: `${client.apiUrl}/apps/${app.slug}/api/${b.slug}`,
              methods,
              fields: b.columns.map((c) => c.alias),
            });
          }
          const writes = methods.some((m: string) => m !== 'GET');
          const scopes = writes ? ['read', 'write'] : ['read'];
          const key = await client.request<any>('POST', `/organizations/${orgId}/apps/${app.id}/api-keys`, {
            name: 'frontend',
            scopes,
          });
          apiOut = {
            appId: app.id,
            appSlug: app.slug,
            baseUrl: `${client.apiUrl}/apps/${app.slug}/api`,
            openapi: `${client.apiUrl}/apps/${app.slug}/api/openapi.json`,
            endpoints,
            apiKey: key.rawKey,
            scopes,
            keyRule:
              'This is the only time the key is shown. Keep it server-side (env var, API route); send it as Authorization: Bearer <key>.' +
              (api.rowLevelSecurity ? ' Row-level security is on: also send X-App-User: <your user id> on every call.' : ''),
            adminUrl: client.appUrl(`/apps/${app.id}`),
          };
        }

        return ok({
          built: true,
          project: { id: created.id, name: project.name, adminUrl: client.appUrl(`/projects/${created.id}`) },
          boards: outBoards.map(({ slug, columns, ...b }) => ({
            ...b,
            ...(api ? { endpoint: slug } : {}),
            columns: columns.map(({ relatedBoardId, relationType, ...c }) =>
              relatedBoardId ? { ...c, relatedBoard: outBoards.find((x) => x.id === relatedBoardId)?.name, relationType } : c,
            ),
          })),
          ...(apiOut ? { api: apiOut } : {}),
          ...(notes.length ? { notes } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `build_backend stopped: ${message}. Project "${project.name}" (${created.id}) was created and may be partial — fix the spec and call again with a new project name, or delete it at ${client.appUrl(`/projects/${created.id}`)}.`,
        );
      }
    },
  );

  tool(
    'create_automation',
    'Create an automation on a board: when something happens, do something. The most useful action here is http_request, which calls an external API and writes the answer back into columns — pair it with the "scheduled" trigger and the board keeps itself up to date (prices, exchange rates, shipment status, weather). Triggers: item_created, status_changed, column_value_changed, date_approaching, scheduled. Actions: http_request, send_notification, send_email, change_status, set_column_value, create_cross_board_item, send_webhook. Two more things every action list can use: a { type: "delay", config: { minutes | hours | days } } action pauses the run and resumes the actions after it later (reminders, follow-ups); and any network action (http_request, send_webhook, send_email, send_whatsapp) may carry config.retry: { attempts (1-5), delaySeconds (1-60) }. send_webhook accepts config.secret for an HMAC signature.',
    {
      projectId: z.string().describe('Project id (from list_projects / create_project)'),
      boardId: z.string().describe('Board id (from list_boards / create_board)'),
      name: z.string().describe('Human-readable name'),
      trigger: z.enum([
        'item_created',
        'status_changed',
        'column_value_changed',
        'date_approaching',
        'scheduled',
      ]).describe('Event that starts the automation: item_created, status_changed, column_value_changed, date_approaching, or scheduled (cron)'),
      triggerConfig: z
        .record(z.any())
        .optional()
        .describe('e.g. { cron: "0 8 * * *" } for scheduled, { columnName } for column_value_changed'),
      actions: z
        .array(
          z.object({
            type: z.string().describe('Column type: text, rich_text, number, status, date, datetime, duration, people, checkbox, dropdown, label, priority, link, email, phone, relation, lookup, rollup, rating, currency, file'),
            config: z.record(z.any()).describe('Action-specific config, e.g. { url, method, headers, responseMapping } for http_request'),
          }),
        )
        .describe(
          'e.g. [{ type: "http_request", config: { url: "https://api.frankfurter.app/latest?from=USD&to=ILS", method: "GET", responseMapping: [{ path: "rates.ILS", columnId: "<column id from get_board_schema>" }] } }]',
        ),
      isActive: z.boolean().optional().describe('Whether it is active'),
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
    { projectId: z.string().describe('Project id (from list_projects / create_project)'), boardId: z.string().describe('Board id (from list_boards / create_board)') },
    async ({ projectId, boardId }) =>
      ok(await getApi().request('GET', `/projects/${projectId}/boards/${boardId}/automations`)),
  );

  tool(
    'list_apps',
    'List the apps in the organization — id, slug, status. Call this first when you need an app id: the slug (app-xxxxxx) is what shows up in URLs and in generated code, and this is how you map it back to the app.',
    { organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted') },
    async ({ organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(await getApi().request('GET', `/organizations/${orgId}/apps`));
    },
  );

  tool(
    'get_app_spec',
    'Get the machine-readable spec of an app (base URL, endpoints, methods, fields) — use it to generate frontend API calls. appId accepts either the app UUID or its slug (app-xxxxxx); list_apps shows both. The returned baseUrl is absolute — use it verbatim, do not rebuild it from the admin URL.',
    { appId: z.string().describe('App id or slug (from list_apps / create_app)'), organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted') },
    async ({ appId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(await getApi().request('GET', `/organizations/${orgId}/apps/${appId}/spec/json`));
    },
  );

  tool(
    'get_frontend_prompt',
    'Get a ready-made prompt describing the app backend, for pasting into a frontend generator (v0/bolt/lovable/cursor). appId accepts the app UUID or its slug (app-xxxxxx) — use list_apps to find it.',
    {
      appId: z.string().describe('App id or slug (from list_apps / create_app)'),
      tool: z.enum(['v0', 'bolt', 'lovable', 'cursor', 'claude-code']).describe('Target tool the prompt is written for'),
      organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted'),
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

  // ── Search & fetch — the two tools ChatGPT connectors and deep research require ──

  type SearchHit = {
    id: string;
    type: string;
    title: string;
    subtitle?: string;
    highlight?: string;
    url: string;
    metadata?: Record<string, unknown>;
  };
  type DocRef =
    | { kind: 'project'; projectId: string }
    | { kind: 'board'; projectId: string; boardId: string }
    | { kind: 'item'; projectId: string; boardId: string; itemId: string };

  const parseDocId = (id: string): DocRef => {
    let m =
      id.match(/^item:([^:]+):([^:]+):([^:]+)$/) ||
      id.match(/\/projects\/([^/]+)\/boards\/([^/]+)\/items\/([^/?#]+)/);
    if (m) return { kind: 'item', projectId: m[1], boardId: m[2], itemId: m[3] };
    m = id.match(/^board:([^:]+):([^:]+)$/) || id.match(/\/projects\/([^/]+)\/boards\/([^/?#]+)/);
    if (m) return { kind: 'board', projectId: m[1], boardId: m[2] };
    m = id.match(/^project:([^:]+)$/) || id.match(/\/projects\/([^/?#]+)/);
    if (m) return { kind: 'project', projectId: m[1] };
    throw new Error(
      `Unrecognized document id "${id}". Use an id returned by search (project:…, board:…:…, item:…:…:…) or an app URL path.`,
    );
  };
  const docId = (d: DocRef): string =>
    d.kind === 'item'
      ? `item:${d.projectId}:${d.boardId}:${d.itemId}`
      : d.kind === 'board'
        ? `board:${d.projectId}:${d.boardId}`
        : `project:${d.projectId}`;
  const docPath = (d: DocRef): string =>
    d.kind === 'item'
      ? `/projects/${d.projectId}/boards/${d.boardId}/items/${d.itemId}`
      : d.kind === 'board'
        ? `/projects/${d.projectId}/boards/${d.boardId}`
        : `/projects/${d.projectId}`;
  // ChatGPT contract: the object as structuredContent AND JSON-encoded in content.
  const structured = (doc: Record<string, unknown>) => {
    const clean = sanitizeUsersDeep(doc) as Record<string, unknown>;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(clean) }],
      structuredContent: clean,
    };
  };

  tool(
    'search',
    'Full-text search across the projects, boards and items of the organization. Returns { results: [{ id, title, url }] } — the shape ChatGPT connectors and deep research expect; pass a result id to fetch for the full record. When you already know the board, query_items is cheaper and complete.',
    {
      query: z.string().min(1).max(100).describe('Search text'),
      projectId: z.string().optional().describe('Limit the search to one project'),
      limit: z.number().int().positive().max(50).optional().describe('Max results, default 20'),
    },
    async ({ query, projectId, limit }) => {
      const qs = new URLSearchParams({ q: query, types: 'item,project,board', limit: String(limit ?? 20) });
      if (projectId) qs.set('projectId', projectId);
      const res = await getApi().request<{ results?: SearchHit[] }>('GET', `/search?${qs.toString()}`);
      const results: Record<string, unknown>[] = [];
      for (const r of res?.results ?? []) {
        let ref: DocRef;
        try {
          ref = parseDocId(r.url);
        } catch {
          continue; // users and anything else without a project path
        }
        results.push({
          id: docId(ref),
          title: r.title,
          url: getApi().appUrl(r.url),
          type: ref.kind,
          ...(r.subtitle ? { subtitle: r.subtitle } : {}),
          ...(r.highlight ? { snippet: r.highlight } : {}),
        });
      }
      return structured({ results });
    },
  );

  tool(
    'fetch',
    'One project, board or item in full, by the id search returned (project:<id>, board:<projectId>:<boardId>, item:<projectId>:<boardId>:<itemId>) or by an app URL path. Returns { id, title, text, url, metadata } — the ChatGPT fetch contract; text is the record as JSON.',
    {
      id: z.string().describe('An id from search, or an app URL path such as /projects/…/boards/…/items/…'),
      organizationId: z.string().optional().describe('Only needed for project ids when the credential has no default organization; otherwise resolved automatically'),
    },
    async ({ id, organizationId }) => {
      const ref = parseDocId(id);
      const api = getApi();
      const url = api.appUrl(docPath(ref));
      if (ref.kind === 'item') {
        const item = await api.request<any>('GET', docPath(ref));
        return structured({
          id: docId(ref),
          title: item?.title ?? item?.name ?? ref.itemId,
          text: JSON.stringify(sanitizeUsersDeep(item), null, 2),
          url,
          metadata: { type: 'item', projectId: ref.projectId, boardId: ref.boardId },
        });
      }
      if (ref.kind === 'board') {
        const [board, columns] = await Promise.all([
          api.request<any>('GET', docPath(ref)),
          api.request<any>('GET', `${docPath(ref)}/columns`),
        ]);
        return structured({
          id: docId(ref),
          title: board?.name ?? ref.boardId,
          text: JSON.stringify(sanitizeUsersDeep({ board, columns }), null, 2),
          url,
          metadata: {
            type: 'board',
            projectId: ref.projectId,
            columnCount: Array.isArray(columns) ? columns.length : undefined,
          },
        });
      }
      // The project record lives under its organization; boards do not.
      const loadProject = async (): Promise<unknown> => {
        let orgId: string | null = organizationId ?? null;
        if (!orgId) {
          try {
            orgId = await resolveOrg();
          } catch {
            orgId = null;
          }
        }
        const candidates: string[] = orgId ? [orgId] : [];
        if (!orgId) {
          const orgs = await api.request<any>('GET', '/organizations');
          for (const o of Array.isArray(orgs) ? orgs : (orgs?.items ?? [])) {
            if (o?.id) candidates.push(o.id);
          }
        }
        let lastErr: unknown = null;
        for (const c of candidates) {
          try {
            return await api.request<any>('GET', `/organizations/${c}/projects/${ref.projectId}`);
          } catch (e) {
            lastErr = e;
          }
        }
        throw lastErr ?? new Error(`Project ${ref.projectId} not found in any organization`);
      };
      const [project, boards] = await Promise.all([
        loadProject() as Promise<any>,
        api.request<any>('GET', `${docPath(ref)}/boards`),
      ]);
      const boardList: unknown[] = Array.isArray(boards)
        ? boards
        : ((boards as any)?.items ?? (boards as any)?.data ?? []);
      return structured({
        id: docId(ref),
        title: project?.name ?? ref.projectId,
        text: JSON.stringify(sanitizeUsersDeep({ project, boards: boardList }), null, 2),
        url,
        metadata: { type: 'project', boardCount: boardList.length },
      });
    },
  );

  // ── Frontend hosting ({slug}.tasklite.dev) ────────────────────────────────

  tool(
    'deploy_frontend',
    'Deploy a built static frontend to TaskLite hosting: zips the build output directory (dist/, build/, out/ — the folder that contains index.html), uploads it, and returns the live URL https://{slug}.tasklite.dev. The app is auto-published on first deploy. Runs only where the files are (local/stdio mode). In the frontend, call the app API via relative /api/{endpoint} — the hosting proxy injects the app identity.',
    {
      appId: z.string().describe('App UUID or slug (app-xxxxxx) — see list_apps'),
      dir: z.string().describe('Path to the BUILD OUTPUT directory (the one containing index.html), not the project root'),
      organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted'),
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
    { appId: z.string().describe('App id or slug (from list_apps / create_app)'), organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted') },
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
      appId: z.string().describe('App id or slug (from list_apps / create_app)'),
      version: z.number().int().positive().describe('Deployment version number (from list_deployments)'),
      organizationId: z.string().optional().describe('Organization id; defaults to the credential organization when omitted'),
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
