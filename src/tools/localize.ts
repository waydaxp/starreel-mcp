/**
 * 本地化产线三件套工具(v1)。对接 translator.starreel.ai 既有端点,服务端零改动:
 *   presign(直传 COS)→ 登记 job → batch-process 提交处理 → 轮询状态。
 *
 * 工具设计铁律:
 *   - 卖"结果"不搬 REST:localize_video 一次调用替用户串完 4 个端点。
 *   - 会扣费的动作在 description 里写明单价来源,让 agent 能向用户转述;
 *     余额不足时服务端预扣模式会快速失败并退款,这里如实转发错误。
 *   - 返回结构化 JSON 文本;下载链接是我方 COS 预签名 URL(短时效,过期重查)。
 */
import { basename, extname } from 'node:path'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { StarReelClient } from '../client.js'

const DEFAULT_SERIES = 'MCP Uploads'

type JobRow = {
  id: number
  name: string
  status: string
  stage: string | null
  duration_sec: number | null
  points: number | null
  output_url: string | null
  error: string | null
  series_id: number | null
  target_lang: string | null
  created_at: string
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

export function registerLocalizeTools(server: McpServer, client: StarReelClient) {
  server.tool(
    'localize_video',
    '把一个中文短剧视频(mp4/mov)做出海本地化:去除中文硬字幕并压制目标语言字幕。' +
      '上传→登记→提交处理一步完成,返回 job_id;用 get_localization_job 轮询进度' +
      '(1080p 约 1.25× 实时)。会消耗账户积分(约 65 点/分钟,处理前预扣、失败自动退款)。',
    {
      file_path: z.string().describe('本地视频文件绝对路径(.mp4/.mov)'),
      target_lang: z
        .enum(['en', 'ja', 'ko', 'es', 'fr', 'vi', 'th', 'id', 'ar'])
        .describe('目标语言(en=英语 ja=日语 ko=韩语 es=西语 fr=法语 vi=越南语 th=泰语 id=印尼语 ar=阿拉伯语)'),
      series_name: z.string().max(100).optional()
        .describe(`归属剧集名(同名复用,默认 "${DEFAULT_SERIES}")`),
    },
    async ({ file_path, target_lang, series_name }) => {
      if (!existsSync(file_path)) throw new Error(`file not found: ${file_path}`)
      const ext = extname(file_path).toLowerCase()
      if (ext !== '.mp4' && ext !== '.mov') throw new Error(`unsupported format ${ext} (mp4/mov only)`)

      // 1) 找/建剧集(batch-process 以剧集为提交单元)
      const wanted = (series_name ?? DEFAULT_SERIES).trim()
      const { series } = await client.loc<{ series: Array<{ id: number; name: string }> }>('/api/series')
      let sid = series.find((s) => s.name === wanted)?.id
      if (!sid) {
        const created = await client.locPost<{ id: number }>('/api/series', { name: wanted })
        sid = created.id
      }

      // 2) 预签名 → 浏览器同款直传 COS(字节不经任何 StarReel 服务器)
      const filename = basename(file_path)
      const presign = await client.locPost<{ key: string; uploadUrl: string }>(
        '/api/uploads/presign',
        { filename },
      )
      await client.uploadFile(presign.uploadUrl, file_path)

      // 3) 登记任务 → 4) 提交处理(设语言、转 pending,worker 立即可领)
      const job = await client.locPost<{ id: number }>('/api/jobs', {
        key: presign.key,
        name: filename,
        seriesId: sid,
      })
      const submitted = await client.locPost<{ submitted: number }>(
        `/api/series/${sid}/batch-process`,
        { jobIds: [job.id], targetLang: target_lang },
      )
      if (submitted.submitted !== 1) {
        throw new Error(`job ${job.id} registered but not submitted — check series ${sid} state`)
      }
      return jsonResult({
        job_id: job.id,
        series_id: sid,
        status: 'pending',
        target_lang,
        note: 'poll with get_localization_job; processing ≈1.25× realtime',
      })
    },
  )

  server.tool(
    'get_localization_job',
    '查询一个本地化任务的状态。status=done 时返回成片下载链接(短时效预签名 URL,过期就再查一次拿新链接)。',
    { job_id: z.number().int().positive().describe('localize_video 返回的 job_id') },
    async ({ job_id }) => {
      const row = await client.loc<JobRow>(`/api/jobs/${job_id}`)
      if (!row?.id) throw new Error(`job ${job_id} not found`)
      return jsonResult({
        job_id: row.id,
        name: row.name,
        status: row.status, // uploaded|pending|processing|done|failed
        stage: row.stage,
        target_lang: row.target_lang,
        duration_sec: row.duration_sec,
        points_charged: row.points,
        download_url: row.output_url, // 我方 COS 预签名,非厂商直链
        error: row.error,
      })
    },
  )

  server.tool(
    'list_localization_jobs',
    '列出我的本地化任务(最近 200 条,可按剧集过滤)。',
    { series_id: z.number().int().positive().optional() },
    async ({ series_id }) => {
      const q = series_id ? `?seriesId=${series_id}` : ''
      const { jobs } = await client.loc<{ jobs: JobRow[] }>(`/api/jobs${q}`)
      return jsonResult({
        count: jobs.length,
        jobs: jobs.map((r) => ({
          job_id: r.id, name: r.name, status: r.status, stage: r.stage,
          target_lang: r.target_lang, points: r.points, created_at: r.created_at,
        })),
      })
    },
  )
}
