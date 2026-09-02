#!/usr/bin/env node
/**
 * StarReel MCP 服务器(stdio 形态)。
 *
 * 接入(Claude Code):
 *   claude mcp add starreel -e STARREEL_API_KEY=srk_live_... -- npx -y @starreel/mcp
 *
 * ⚠️ stdio 传输下 stdout 是 JSON-RPC 通道 —— 任何诊断输出只许走 stderr
 * (console.error),console.log 一次就会把整条会话打坏。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StarReelClient } from './client.js'
import { registerLocalizeTools } from './tools/localize.js'
import { registerProduceTools } from './tools/produce.js'
import { registerGuideTools } from './tools/guide.js'
import { buildInstructions } from './tools/guide-data.js'

const apiKey = process.env.STARREEL_API_KEY
if (!apiKey) {
  console.error(
    'STARREEL_API_KEY is not set.\n' +
      'Create one in StarReel → Settings → API Keys, then:\n' +
      '  claude mcp add starreel -e STARREEL_API_KEY=srk_live_... -- npx -y @starreel/mcp',
  )
  process.exit(1)
}

// server 级 instructions:客户端 initialize 时拿到,多数客户端注入系统提示——agent 在看任何工具之前
// 就先拿到「客户这种材料该走哪条入口」的决策树。全文与 get_capabilities_guide 同源(tools/guide-data.ts),
// 后端哨兵测试钉住:引导里提到的每个工具名都必须真的注册了。
const server = new McpServer({ name: 'starreel', version: '0.1.0' }, { instructions: buildInstructions() })
const client = new StarReelClient(apiKey)
registerGuideTools(server)             // 功能地图(免费·本地·不联网):什么情况下该用哪个工具
registerProduceTools(server, client)   // 短剧编排产线(需 produce scope)——从剧本到成片
// 出海本地化工具:translator worker 暂时离线(2026-08),发布版先不注册,免得客户拿到只会
// 报错的工具。worker 重建后取消下一行注释即可(工具代码保留在 tools/localize.ts)。
// registerLocalizeTools(server, client)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[starreel-mcp] ready (drama production toolset, stdio)')
