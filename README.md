# StarReel MCP

> Turn a script into a finished, downloadable short-drama episode — from Claude, Cursor, or any MCP client.

[![npm version](https://img.shields.io/npm/v/%40starreel%2Fmcp)](https://www.npmjs.com/package/@starreel/mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40starreel%2Fmcp)](https://www.npmjs.com/package/@starreel/mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

**StarReel** is a prepaid AI video-production pipeline. This MCP server exposes the
whole factory — **80+ tools** covering every stage — so an AI agent can take a raw
script all the way to a finished `.mp4`:

```
script → AI rewrite → cast / scenes / props extraction → character portraits & sheets
       → storyboards → keyframes → video shots → voiceover (TTS) → final cut (.mp4 link)
```

It is a thin, open client: all the heavy lifting (character-consistency gates,
frame chaining, best-of-N auditing, billing) runs server-side at
[starreel.ai](https://starreel.ai).

## Quick start

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=starreel&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBzdGFycmVlbC9tY3AiXSwiZW52Ijp7IlNUQVJSRUVMX0FQSV9LRVkiOiJzcmtfbGl2ZV94eHgifX0=)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP-0098FF)](https://vscode.dev/redirect/mcp/install?name=starreel&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40starreel%2Fmcp%22%5D%2C%22env%22%3A%7B%22STARREEL_API_KEY%22%3A%22srk_live_xxx%22%7D%7D)

1. Create an API key with `produce` scope in **StarReel → Settings → API Keys**
   (`srk_live_...`, shown once).
2. Add the server to Claude Code:

```bash
claude mcp add starreel -e STARREEL_API_KEY=srk_live_xxx -- npx -y @starreel/mcp
```

3. Ask your agent: *"Take this script and produce a full episode: `<your script>`"* —
   it will quote each paid stage first and only spend after you confirm.

## Works with any MCP client

Requires Node ≥ 18 (`npx`). The **standard config** below works as-is in
**Cursor · Windsurf · Cline / Roo Code · Claude Desktop · Trae · Cherry Studio ·
Chatbox · DeepChat** and any client that reads an `mcpServers` JSON block:

```json
{
  "mcpServers": {
    "starreel": {
      "command": "npx",
      "args": ["-y", "@starreel/mcp"],
      "env": { "STARREEL_API_KEY": "srk_live_xxx" }
    }
  }
}
```

Clients with their own format:

<details>
<summary><b>Codex CLI</b> — <code>~/.codex/config.toml</code></summary>

```toml
[mcp_servers.starreel]
command = "npx"
args = ["-y", "@starreel/mcp"]
env = { "STARREEL_API_KEY" = "srk_live_xxx" }
```
</details>

<details>
<summary><b>VS Code (Copilot agent mode)</b> — <code>.vscode/mcp.json</code> or user <code>mcp.json</code></summary>

```json
{
  "servers": {
    "starreel": {
      "command": "npx",
      "args": ["-y", "@starreel/mcp"],
      "env": { "STARREEL_API_KEY": "srk_live_xxx" }
    }
  }
}
```
</details>

<details>
<summary><b>Gemini CLI</b> — <code>~/.gemini/settings.json</code></summary>

```json
{
  "mcpServers": {
    "starreel": {
      "command": "npx",
      "args": ["-y", "@starreel/mcp"],
      "env": { "STARREEL_API_KEY": "srk_live_xxx" }
    }
  }
}
```
</details>

<details>
<summary><b>No Node / can't run npx?</b> (Coze, Dify, GPTs, custom agents)</summary>

Drive the same pipeline over REST (`/v1/produce/*`) and paste
[`SKILL.md`](./SKILL.md) into your system prompt — it carries the full
workflow order, billing disciplines, and failure playbook.
See the [API docs](https://api.shortreelai.com/docs/mcp).
</details>

## What's inside

| Stage | Tools (selection) |
|---|---|
| Project setup | `create_drama` · `update_project_settings` · `list_project_options` |
| Script | `set_script` · AI rewrite · `edit_rewritten_script` |
| Cast & world | asset extraction · `update_character` · `generate_world_concept` · `generate_art_bible` |
| Identity anchors | `generate_portraits_and_sheets` (portraits + character sheets = the consistency anchor) |
| Storyboards | `quote_storyboards` → `generate_storyboards` → `get_storyboards` |
| Frames & video | `quote_frames` → `generate_frames` · `quote_videos` → `generate_videos` |
| Audio | `generate_tts` · `generate_bgm` · `generate_sfx` · voice management |
| Finishing | `compose_episode` (free) · `get_final_cut` · `render_multi_aspect` · posters & covers |
| Localization | `translate_subtitles` · localization jobs |
| Ads / MV modes | product library & product sheets · MV lyrics → story → script |

Project types: `drama` / `ad` / `mv` / `brand_film`.

## Billing is agent-safe by design

- **Prepaid, never negative.** Costs are pre-authorized *before* any vendor call;
  insufficient balance returns a clean `402` — nothing half-runs.
- **Quote before spend.** Big-ticket stages are `quote_*` → show the user →
  `generate_*` with the returned `quote_id`. For video, **quote == actual charge**
  (same function computes both).
- **Final cut is free.** Composition, transitions, SFX matching and deliverable
  packaging don't bill.
- API keys are stored hashed and exchanged for 15-minute short-lived tokens;
  revoke in Settings at any time.

## Built for agents: the operating skill

[`SKILL.md`](./SKILL.md) ships inside the package — a platform-agnostic operating
manual (full pipeline order + ten operating disciplines + a failure playbook).
Skill-aware clients load it automatically; on platforms that can't run `npx`
(Coze / Dify / GPTs / custom agents) paste it into the system prompt and drive
the same pipeline over REST (`/v1/produce/*`).

## Environment variables

| Variable | Required | Default |
|---|---|---|
| `STARREEL_API_KEY` | ✅ | — |
| `STARREEL_AUTH_BASE` | | `https://api.shortreelai.com` |

## Links

- Website: [starreel.ai](https://starreel.ai)
- Full MCP / REST docs: [api.shortreelai.com/docs/mcp](https://api.shortreelai.com/docs/mcp)
- npm: [@starreel/mcp](https://www.npmjs.com/package/@starreel/mcp)
- 中文文档: [README.zh-CN.md](./README.zh-CN.md)

## License

[MIT](./LICENSE) — this client is open; the production pipeline is a hosted service.
