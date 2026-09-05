# Changelog

All notable changes to `@tasklite/mcp`. Versions that were never published
are folded into the next published one, so the numbers on npm may skip.

## 0.7.1 — 2026-09-06

### Changed
- Every tool parameter now carries a description (89 added), so clients and directories show what each argument means.

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
