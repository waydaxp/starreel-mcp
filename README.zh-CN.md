# @starreel/mcp

StarReel 的 MCP 服务器 —— 把 AI 短剧**编排产线**暴露给 Claude Code / Cursor /
任何 MCP 客户端:让 AI agent 一句话从**剧本跑到可下载的成片**。

完整接入文档:https://api.shortreelai.com/docs/mcp

**给 AI agent 的操作 Skill 与纪律**:本包内 [`SKILL.md`](./SKILL.md) —— 一份平台无关的
操作手册(完整产线顺序 + 十条接入纪律 + 失败处理决策)。支持 Skill 的客户端会自动加载;
不能 npx 的平台(Coze / Dify / GPTs / 自研 agent)可把它整段贴进 system prompt。

也可用 [`skills`](https://skills.sh) CLI 一条命令装成独立 agent skill
(Claude Code / Codex / Cursor / OpenCode 等 70+ 工具):

```bash
npx skills add waydaxp/starreel-mcp
```

## 接入

1. 在 StarReel → 设置 → API Key 创建一把 `produce` scope 的 key(`srk_live_...`,只展示一次)。
2. Claude Code:

```bash
claude mcp add starreel -e STARREEL_API_KEY=srk_live_xxx -- npx -y @starreel/mcp
```

也可装 **Claude Code 插件**——MCP server + agent skill 一步到位
(先在 shell 里 `export STARREEL_API_KEY=srk_live_xxx`):

```text
/plugin marketplace add waydaxp/starreel-mcp
/plugin install starreel@starreel
```

一键安装:
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=starreel&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBzdGFycmVlbC9tY3AiXSwiZW52Ijp7IlNUQVJSRUVMX0FQSV9LRVkiOiJzcmtfbGl2ZV94eHgifX0=)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP-0098FF)](https://vscode.dev/redirect/mcp/install?name=starreel&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40starreel%2Fmcp%22%5D%2C%22env%22%3A%7B%22STARREEL_API_KEY%22%3A%22srk_live_xxx%22%7D%7D)

## 全客户端接入

要求 Node ≥ 18(能跑 `npx`)。下面这段**标准配置**在
**Cursor · Windsurf · Cline / Roo Code · Claude Desktop · Trae · Cherry Studio ·
Chatbox · DeepChat** 及任何读 `mcpServers` JSON 的客户端里通用:

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

格式不同的客户端:

- **Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.starreel]
command = "npx"
args = ["-y", "@starreel/mcp"]
env = { "STARREEL_API_KEY" = "srk_live_xxx" }
```

- **VS Code(Copilot agent 模式)** — `.vscode/mcp.json` 或用户级 `mcp.json`,外层键是 `servers` 而非 `mcpServers`,内容同标准配置。
- **Gemini CLI** — `~/.gemini/settings.json`,直接放标准配置。
- **跑不了 npx 的平台(扣子 Coze / Dify / GPTs / 自研 agent)** — 走 REST(`/v1/produce/*`)+ 把 [`SKILL.md`](./SKILL.md) 整段贴进 system prompt,见[接入文档](https://api.shortreelai.com/docs/mcp)。

## 产线工具(从剧本到成片)

一集短剧的完整链路,每个花钱阶段先报价、你确认后才执行:

| 阶段 | 工具 |
|---|---|
| 建剧 | `create_drama`(建剧壳+自动建集,返回 episode_id) |
| 灌本 | `set_script` |
| 拆镜 | `quote_storyboards` → `generate_storyboards` → `get_storyboards`(审阅) |
| 出首帧 | `quote_frames` → `generate_frames` |
| 出视频 | `quote_videos` → `generate_videos`(大额,报价与扣费同函数) |
| 成片 | `compose_episode`(免费终拼) → `get_final_cut`(拿 COS 下载链接) |

**批量报价确认**:每个 `quote_*` 返回预估点数,agent 应把点数告诉你、你同意后才用返回的
`quote_id` 调 `generate_*`。整集一次执行,不逐图打扰。长任务后台异步,用 `get_storyboards`/
`get_final_cut` 轮询到完成。

## 计费与安全

- 预付制:必须有余额才能生成,账户**永不为负**;成本在调厂商**之前**预授权,不够返回 402。
- 视频报价 == 实际扣费(同一函数);终拼(成片)免费。
- API key 只存哈希;换取的是 15 分钟短期令牌;泄露在设置页吊销即失效,不影响网页登录。

## 环境变量

| 变量 | 必填 | 默认 |
|---|---|---|
| `STARREEL_API_KEY` | ✅ | — |
| `STARREEL_AUTH_BASE` | | `https://api.shortreelai.com` |
