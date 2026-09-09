# Submission copy

Verified against the live registries on 2026-09-09, not written from memory.
Copy the blocks as they are.

| | |
| --- | --- |
| Name | **TaskLite** |
| Package | `@tasklite/mcp` |
| Version | **0.14.1** |
| Tools | **43 hosted**, 48 local |
| Repo | https://github.com/shimon-ks/tasklite-mcp |
| Site | https://tasklite.net |
| Docs | https://tasklite.net/docs |
| Hosted | `https://mcp.tasklite.net/mcp` (Streamable HTTP, OAuth) |
| Local | `npx -y @tasklite/mcp` (stdio) |
| Registry id | `net.tasklite/mcp` |
| Licence | MIT |
| Logo | https://tasklite.net/logo-400.png (400x400) |

**Use 43, not 48.** The hosted server has no `sign_up`, `connect`, `login`,
`disconnect` or `connection_status`; those exist only over stdio. Every
directory below lists the hosted server, and Smithery's own scan counted 43.

**Never submit the bare name.** There is an older, unrelated TaskLite:
[ad-si/TaskLite](https://github.com/ad-si/TaskLite) at tasklite.org, a
command-line task manager, on GitHub since 2019 with 288 stars. It is in every
model's training data and we are not, so a listing that says only "TaskLite" is
a listing for their product. Lead with `tasklite.net`, every time. That is why
the wording below looks the way it does.

---

## 1. Smithery: done

Nothing to do. Fixed on 2026-09-09 and verified by reloading the field from
their server.

The scan had gone stale three versions back, so the page said **40 tools** and
the description said **44**. Republishing against `mcp.tasklite.net/mcp`
re-scanned it to the correct **43**, and the description was rewritten to lead
with the domain and name the CLI it is not.

Two things that turned up in their deploy log and are worth remembering:

- `Server info retrieved. name: tasklite, version: 0.14.0`. The hosted server
  runs the global npm package and **nobody updated it after 0.14.1 went out**.
  Harmless this time, since the only change was the bin, but a real gap.
- Smithery has been acquired by Arcade.dev. Worth watching before investing
  more there.

---

## 2. LobeHub: three commands, the manifest is ready

`lhm.plugin.json` is in this repo, on 0.14.1, with the icon and the
disambiguating description. All three need a browser, which is why they are
yours.

```bash
& "C:\Program Files\Git\bin\bash.exe" -c "cd /c/kristech/websites/tasklite/tasklite-mcp; npx lhm login"
```

```bash
& "C:\Program Files\Git\bin\bash.exe" -c "cd /c/kristech/websites/tasklite/tasklite-mcp; npx lhm github connect"
```

```bash
& "C:\Program Files\Git\bin\bash.exe" -c "cd /c/kristech/websites/tasklite/tasklite-mcp; npx lhm plugin publish"
```

If it asks for a category: **Developer Tools** or **Productivity**.

---

## 3. mcp.so: not listed at all

`https://mcp.so/server/tasklite` answers 404 today. Go to mcp.so and Submit.

**Name**

```
TaskLite
```

**Short description**

```
tasklite.net: a hosted backend, REST API and admin for apps built by AI agents
```

**Long description**

```
TaskLite gives an app built by an AI agent the part the agent cannot invent: a real backend. Describe a system in a sentence and one call creates the project behind it, with typed tables and relations, rows, REST endpoints and an API key, plus an admin interface the business itself operates afterwards rather than a schema the developer keeps maintaining.

Works from Claude Code, Claude Desktop, ChatGPT, Gemini CLI, Cursor and VS Code. Run it locally with `npx -y @tasklite/mcp`, or connect the hosted server at https://mcp.tasklite.net/mcp over OAuth with nothing to install.

43 tools over the hosted server, 48 when run locally, which adds the account tools. Every one declares readOnlyHint, destructiveHint and openWorldHint, so a client can tell what is safe to run unattended.

Unrelated to the TaskLite CLI task manager at tasklite.org.
```

**GitHub:** `https://github.com/shimon-ks/tasklite-mcp`
**Install:** `npx -y @tasklite/mcp`
**Category:** Database, or Developer Tools

---

## 4. cursor.directory: blocked to bots, needs you

Returns 429 to anything automated. Same copy as mcp.so, plus the config block
Cursor users actually paste. Give them the hosted one first: no install, no
key.

```json
{
  "mcpServers": {
    "tasklite": {
      "url": "https://mcp.tasklite.net/mcp"
    }
  }
}
```

And the local alternative, which works now that the npx bug is fixed:

```json
{
  "mcpServers": {
    "tasklite": {
      "command": "npx",
      "args": ["-y", "@tasklite/mcp"]
    }
  }
}
```

---

## 5. PulseMCP: submissions were paused

Check whether they reopened. If so, the mcp.so copy fits unchanged.

---

## Already done, so you do not redo it

| Where | State |
| --- | --- |
| Smithery | **fixed 2026-09-09**: 43 tools, new description |
| MCP official registry | **0.14.1**, with `repository` and the disambiguating description |
| npm | **0.14.1**, `npx -y @tasklite/mcp` verified working |
| Anthropic connector | live |
| Glama | A/A/A |
| Gemini CLI gallery | automatic, via the `gemini-cli-extension` topic |
| awesome-mcp-servers | PR #14026 open |
| docker/mcp-registry | PR #5029 open |
| cline/mcp-marketplace | issue #2490 open |
| OpenAI plugin | submitted, status Review |

## After OpenAI approves

- Revoke the demo `tl_` key
- Delete test project `0f4da20b`
- Delete `https://tasklite.net/openai-review-8bc468d719bc80d4.mp4`
