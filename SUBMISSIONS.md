# Submission copy

Everything below is verified against the live registries on 2026-09-09, not
written from memory. Copy the blocks as they are.

| | |
| --- | --- |
| Name | **TaskLite** |
| Package | `@tasklite/mcp` |
| Version | **0.14.1** |
| Tools | **48** |
| Repo | https://github.com/shimon-ks/tasklite-mcp |
| Site | https://tasklite.net |
| Docs | https://tasklite.net/docs |
| Hosted | `https://mcp.tasklite.net/mcp` (Streamable HTTP, OAuth) |
| Local | `npx -y @tasklite/mcp` (stdio) |
| Registry id | `net.tasklite/mcp` |
| Licence | MIT |
| Logo | https://tasklite.net/logo-400.png (400×400) |

**One rule that applies to every form below.** There is an older, unrelated
TaskLite: [ad-si/TaskLite](https://github.com/ad-si/TaskLite) at tasklite.org,
a command-line task manager, on GitHub since 2019 with 288 stars. It is in
every model's training data and we are not. **Never submit the bare name.**
Lead with `tasklite.net`, every time. That is the whole reason the wording
below looks the way it does.

---

## 1. Smithery — the one worth doing first

You are already listed, and the entry is wrong: it says **44 tools** (there are
48), the description does not separate us from the CLI, and the slug is
`tasklite/tasklite` rather than the repo.

A wrong tool count is worse than a missing listing, because everything that
scrapes Smithery repeats it.

**Where:** smithery.ai → your server → Edit.

**Display name**

```
TaskLite
```

**Description** — replaces the one that says 44

```
tasklite.net: a hosted backend and admin for apps built by AI agents. Describe a system and get a project with typed tables, relations, rows, REST endpoints and an API key, plus an admin interface the business operates itself afterwards. 48 tools. Not the tasklite.org CLI task manager.
```

**Homepage:** `https://tasklite.net` · **Repo:** `https://github.com/shimon-ks/tasklite-mcp`

---

## 2. LobeHub — three commands, the manifest is ready

`lhm.plugin.json` is already in this repo, on 0.14.1, with the icon and the
disambiguating description. All three commands need a browser, which is why
they are yours and not mine.

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

## 3. mcp.so — not listed at all

`https://mcp.so/server/tasklite` answers 404 today.

**Where:** mcp.so → Submit.

**Name**

```
TaskLite
```

**Short description** (one line)

```
tasklite.net: a hosted backend, REST API and admin for apps built by AI agents
```

**Long description**

```
TaskLite gives an app built by an AI agent the part the agent cannot invent: a real backend. Describe a system in a sentence and one call creates the project behind it — typed tables with relations, rows, REST endpoints and an API key — plus an admin interface the business itself operates afterwards, instead of a schema the developer keeps maintaining.

Works from Claude Code, Claude Desktop, ChatGPT, Gemini CLI, Cursor and VS Code. Run it locally with `npx -y @tasklite/mcp`, or connect the hosted server at https://mcp.tasklite.net/mcp over OAuth with nothing to install.

48 tools. Every one declares readOnlyHint, destructiveHint and openWorldHint, so a client can tell what is safe to run unattended.

Unrelated to the TaskLite CLI task manager at tasklite.org.
```

**GitHub:** `https://github.com/shimon-ks/tasklite-mcp` ·
**Install:** `npx -y @tasklite/mcp` · **Category:** Database / Developer Tools

---

## 4. cursor.directory — blocked to bots, needs you

Returns 429 to anything automated. Same copy as mcp.so.

**Config block** — this is the shape Cursor users paste, so give them the
hosted one; it needs no install and no key.

```json
{
  "mcpServers": {
    "tasklite": {
      "url": "https://mcp.tasklite.net/mcp"
    }
  }
}
```

And the local alternative, now that `npx` works:

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

## 5. PulseMCP — submissions were paused

Check whether they reopened. If they did, the mcp.so copy fits as is.

---

## What is already done, so you do not redo it

| Where | State |
| --- | --- |
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
