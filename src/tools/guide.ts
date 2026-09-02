/**
 * 功能地图工具:get_capabilities_guide。纯本地、不联网、不扣费——数据在 guide-data.ts。
 * 独立于 produce.ts 注册,好让 openapi 生成器把它列进 x-unmapped-tools(它没有 REST 对应面)。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { buildGuide, GUIDE_SECTIONS, GUIDE_VERSION, HOW_TO_READ } from './guide-data.js'

export function registerGuideTools(server: McpServer) {
  server.tool(
    'get_capabilities_guide',
    '★功能地图(免费 · 本地 · 不联网 · 不扣费)。**第一次接触本服务器、客户问「你们能做什么 / 该从哪开始」、' +
      '或不确定客户这种材料该走哪个工具时,先调它**。返回:' +
      'entry_points(客户手上是小说/成熟剧本/想去外部 AI 改写/成品分镜表/自有素材/声音样本/歌曲/产品/已有成片要改/想自己剪/多语言 → 各走哪些工具、别走哪条路)、' +
      'pipeline(10 步产线每步的工具、免费还是收费、哪道审查闸)、review_gates(三道免费硬闸规则)、' +
      'qa_tools(按客户描述的症状选检测工具与修法)、optional_boosts(可选增强及何时做)、billing(报价确认与免费族)、' +
      'common_requests(客户常见原话 → 该做什么)。传 section 只取一段。' +
      '★工具描述回答"这个工具做什么",本工具回答"什么情况下该用哪个"——客户交来的是成品分镜表却被 set_script→rewrite_script 改写成散文,就是没先看这张表。',
    {
      section: z.enum(GUIDE_SECTIONS).optional().describe('只取某一段;不传返回全部'),
    },
    async ({ section }) => {
      const guide = buildGuide()
      const data = section ? { version: GUIDE_VERSION, how_to_read: HOW_TO_READ, [section]: guide[section] } : guide
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
  )
}
