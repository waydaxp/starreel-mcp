/**
 * StarReel API 客户端 —— MCP 工具层与后端之间唯一的 HTTP 通道。
 *
 * 鉴权模型:长期 API Key(环境变量,绝不出现在工具参数/返回里)→ 换 15min
 * 短期 JWT(POST {auth}/v1/agent/token)→ 带 Bearer 调业务 API。token 过期
 * 或 401 时自动重换一次再重放;重放仍失败则原样抛错(不无限循环)。
 *
 * 安全边界:
 *   - key/token 永不写 stdout(stdio 传输的 JSON-RPC 通道)也不进工具返回值。
 *   - 返回给模型的下载链接只能是我方 COS 预签名 URL(服务端已保证,这里不转发
 *     任何厂商直链字段)。
 */
import { createReadStream, statSync } from 'node:fs'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import { assertSafeLocalMediaPath } from './path-guard.js'   // v0.1.37 — P0③ 路径安全闸

/** 扩展名 → MIME(presign 需要 content_type)。 */
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac',
}

const AUTH_BASE = process.env.STARREEL_AUTH_BASE ?? 'https://api.shortreelai.com'
const LOC_BASE = process.env.STARREEL_LOC_BASE ?? 'https://translator.starreel.ai'

export class StarReelClient {
  private token: string | null = null
  private tokenExpiresAt = 0 // epoch ms

  constructor(private readonly apiKey: string) {
    if (!apiKey?.startsWith('srk_')) {
      throw new Error('STARREEL_API_KEY missing or malformed (expected srk_live_...)')
    }
  }

  /** API key → 短期 access token(提前 60s 视为过期,避免边界竞态)。 */
  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token
    const res = await fetch(`${AUTH_BASE}/v1/agent/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: this.apiKey }),
    })
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? 'API key rejected (revoked or invalid) — create a new key in StarReel settings'
          : `token exchange failed: HTTP ${res.status}`,
      )
    }
    const body = (await res.json()) as { data: { access_token: string; expires_in: number } }
    this.token = body.data.access_token
    this.tokenExpiresAt = Date.now() + body.data.expires_in * 1000
    return this.token
  }

  /** 带 Bearer 的 fetch;401 时强制重换 token 重放一次。 */
  private async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async (): Promise<Response> => {
      const token = await this.ensureToken()
      return fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } })
    }
    let res = await attempt()
    if (res.status === 401) {
      this.token = null // 服务端时钟/吊销边界:强制重换一次
      res = await attempt()
    }
    return res
  }

  /** 本地化服务(translator.starreel.ai)的 JSON 调用。 */
  async loc<T>(path: string, init: RequestInit = {}): Promise<T> {
    // 网络层失败(DNS/TLS/超时)与业务 4xx/5xx 分开报——agent 拿到 "fetch failed"
    // 无从行动;点名服务与建议,它才能正确转述/重试/放弃。
    let res: Response
    try {
      res = await this.authedFetch(`${LOC_BASE}${path}`, init)
    } catch (e: any) {
      throw new Error(
        `StarReel localization service unreachable (${LOC_BASE}): ${e?.cause?.code ?? e?.message ?? e}. ` +
          'The service may be down or your network blocks it — retry later or check with StarReel.',
      )
    }
    const text = await res.text()
    let body: any
    try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status} on ${path}`)
    return body as T
  }

  locPost<T>(path: string, body: unknown): Promise<T> {
    return this.loc<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** 短剧编排产线(网关 /v1/produce/*)。返回 StarReel 信封里的 data。 */
  async produce<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response
    try {
      res = await this.authedFetch(`${AUTH_BASE}/v1/produce${path}`, init)
    } catch (e: any) {
      throw new Error(
        `StarReel production pipeline unreachable (${AUTH_BASE}): ${e?.cause?.code ?? e?.message ?? e}. ` +
          'Retry later or check with StarReel.',
      )
    }
    const text = await res.text()
    let body: any
    try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
    if (!res.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status} on ${path}`)
    return (body?.data ?? body) as T  // StarReel 信封 {code,data,message}
  }

  produceGet<T>(path: string): Promise<T> {
    return this.produce<T>(path, { method: 'GET' })
  }

  producePost<T>(path: string, body?: unknown): Promise<T> {
    return this.produce<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  producePut<T>(path: string, body: unknown): Promise<T> {
    return this.produce<T>(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  produceDelete<T>(path: string): Promise<T> {
    return this.produce<T>(path, { method: 'DELETE' })
  }

  /**
   * 把本地文件流式 PUT 到 COS 预签名 URL(字节不经我们任何服务器)。
   * Content-Length 必带 —— 预签名 PUT 对 chunked 编码不友好。
   */
  async uploadFile(uploadUrl: string, filePath: string, extraHeaders: Record<string, string> = {}): Promise<void> {
    const size = statSync(filePath).size
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-length': String(size), ...extraHeaders },
      body: Readable.toWeb(createReadStream(filePath)) as unknown as BodyInit,
      // Node fetch(undici) 流式请求体必须显式声明半双工
      duplex: 'half',
    } as RequestInit)
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status} (${(await res.text()).slice(0, 200)})`)
  }

  /**
   * 本地文件 → 我方 COS:presign(门面 /upload-url)→ 直传字节到预签名 URL → 返回 public_url。
   * 字节不经我们的业务服务器,只走 COS。kind: image(默认)/video/audio。
   */
  async uploadLocalFile(filePath: string, kind: 'image' | 'video' | 'audio' = 'image'): Promise<string> {
    // v0.1.37 — P0③:媒体扩展名白名单 + 隐藏/系统目录拒绝(realpath 后判,防符号链接绕过)。
    const safePath = assertSafeLocalMediaPath(filePath, kind)
    filePath = safePath
    const size = statSync(filePath).size
    const filename = basename(filePath)
    const ext = (filename.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase()
    const content_type = MIME_BY_EXT[ext] || 'application/octet-stream'
    const res = await this.producePost<{ put_url: string; public_url: string; headers?: Record<string, string> }>(
      '/upload-url',
      { filename, content_type, size, kind },
    )
    // presign 可能要求 PUT 带特定头(content-type 等)——按 presign 返回的 headers 送;
    // 未返回则至少带 content-type(COS 签名常把它纳入)。
    await this.uploadFile(res.put_url, filePath, res.headers ?? { 'content-type': content_type })
    return res.public_url
  }
}
