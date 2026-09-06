# Changelog

All notable changes to `@tasklite/mcp`. Versions that were never published
are folded into the next published one, so the numbers on npm may skip.

## 0.8.3 — 2026-09-06

### Changed
- `build_backend` no longer cares about the order of boards in the spec.
  Sample rows are created in dependency order — a board's rows after the
  rows of every board it links to — so an order that names a customer
  works whether Customers is listed first or last.
- A sample row that links to a title not present in the related board's
  rows is refused before anything is created, with the board and the
  missing title named. Previously the project was built and the gap was
  only mentioned in a note.

## 0.8.2 — 2026-09-06

### Changed
- `build_backend` relation columns take `relatedBoard` and `relationType`
  as fields of their own, and `relationType` is an enum
  (`many_to_one`, `one_to_many`, `many_to_many`, `one_to_one`) with a
  description that says what each means for a business model. A model
  reading the schema now sees the valid values instead of guessing; the
  previous `settings.relatedBoardName` form still works. The summary echoes
  the relation type of every relation column. Using either field on a
  non-relation column is refused before anything is built.

## 0.8.1 — 2026-09-06

### Added
- `build_backend` links boards: a `relation` column with
  `settings.relatedBoardName` naming another board in the same spec is
  wired to it (relation type defaults to many_to_many). Sample rows can
  fill a relation cell with the title(s) of rows in the related board, so
  "Customer": "Sam Miller" on an order links to that customer. Boards are
  created before any column, so order in the spec only matters for rows.
- The API summary echoes `scopes`, and says the key is shown once.

### Changed
- A relation to a board not in the spec is refused before anything is
  created, with the list of boards that are.

## 0.8.0 — 2026-09-06

### Added
- `build_backend` — one call builds a project, its boards, typed columns,
  optional sample rows, and optionally a published REST API with an endpoint
  per board and a server-side key. The model designs the schema; the tool
  executes it and returns one compact summary. API field names are derived
  from column names and never collide with reserved item fields, so nothing
  needs a retry. A spec problem is reported before anything is created.
- `create_app_api_key` accepts `scopes` (`["read"]` or `["read","write"]`).
  With a server from 2026-09-06 the default follows the app: write once any
  endpoint accepts POST, PATCH or DELETE. Earlier keys said `read` while
  writing, which was a label, not a restriction.

### Changed
- Organization defaulting for OAuth users (ChatGPT, Claude web): the single
  organization the user can write to is chosen automatically; with several,
  the error names them with ids so the model can choose in the same turn.
  Previously every OAuth call without `organizationId` failed and asked for
  `list_organizations` first.
- `create_app_endpoint` / `update_app_endpoint` spell out the reserved alias
  names (`status`, `title`, …) so a model never trips on them.
- Tool count 44 → 45; hosted 39 → 40.

## 0.7.1 — 2026-09-06

### Changed
- Every tool parameter now carries a description (155 parameters across 44 tools), so clients and directories show what each argument means.

### Fixed
- Hosted server: `resources/list` and `prompts/list` join the discovery methods that work without a credential (directory scanners logged them as failures).

## 0.7.0 — 2026-09-04

Requires TaskLite API from 2026-09-04 (branch `feat/app-api-hardening`) for
the new behaviour; older servers ignore the new fields.

### Added
- `search` and `fetch` — the two tools ChatGPT connectors and deep research
  require. `search` covers projects, boards and items; `fetch` returns one of
  them by the id `search` gave (or an app URL path).
- Schema editing: `update_column` (rename, retype, options, required, hidden),
  `delete_column`, `reorder_columns`, `update_board`, `delete_board`.
  A type change converts stored values and reports `{ converted, cleared }`.
- `export_project` — the whole project as JSON (boards, columns, items,
  cells), capped per board for the model; the REST endpoint returns everything.
- Column validation rules through `settings.validation` on `create_column` /
  `update_column`: `unique`, `min`, `max`, `minLength`, `maxLength`,
  `pattern`, `patternMessage`. Enforced on every write path.
- `create_automation`: the `delay` action (`{ minutes | hours | days }`) and
  `config.retry` on network actions; `send_webhook` takes `config.secret`.
- `get_frontend_prompt` accepts `claude-code` (it was documented but rejected).
- Hosted server: `initialize`, `ping` and `tools/list` work without a
  credential, so directories and client "test connection" buttons can see
  the tools before sign-in. Every `tools/call` still requires auth.

### Fixed
- `create_automation` and `list_automations` failed with
  "typedHandler is not a function": an empty annotations object was parsed
  by the SDK as the callback. Tools without annotations now register with the
  four-argument form.
- `create_item` description no longer tells agents to create title-only and
  then `set_cell`; cells are saved atomically with the row.

### Changed
- Tool count 31 → 44. Hosted server exposes 39 (no onboarding tools).

## 0.5.7 — 2026-08

Last version published before this changelog existed.
