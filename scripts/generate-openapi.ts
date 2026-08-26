/**
 * OpenAPI 3.1 spec 生成器 —— 从 MCP 工具面(zod schema + handler)运行时内省生成,
 * 不手写、不静态解析源码。原理:
 *   1. 假 McpServer 收集 (name, description, zod shape);
 *   2. 按 zod 类型给每个参数造「哨兵值」(全局唯一,可在 URL 里反查);
 *   3. 假 StarReelClient 记录 handler 发出的第一笔 produce* 调用(method+path+body)后立刻中止;
 *   4. 路径里的哨兵回替成 {param} 还原路径模板;body 里出现的键即请求体字段
 *      (键在 zod shape 里 → 用 zod 转 JSON Schema;键是 handler 变换出来的 → 按哨兵结构推断)。
 *
 * 覆盖范围:仅 /v1/produce/* 门面 + /v1/agent/token 鉴权。localize 工具是多端点
 * 编排(卖结果不搬 REST),不映射成 REST 文档,排除在外。
 * 无法自动映射的工具(如需本地文件上传的)会列入 x-unmapped-tools 并在 stderr 报告——
 * 不静默截断。
 *
 * 运行:npm run generate:openapi(tsx 直跑,产出 openapi.json,info.version 取 package.json)。
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { registerProduceTools } from '../src/tools/produce.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// ---------- 1. 收集工具 ----------
type ToolReg = { name: string; description: string; shape: Record<string, z.ZodTypeAny>; handler: (args: any) => Promise<unknown> }
const tools: ToolReg[] = []
const fakeServer = {
  tool(name: string, description: string, shape: Record<string, z.ZodTypeAny>, handler: (args: any) => Promise<unknown>) {
    tools.push({ name, description, shape, handler })
  },
}

// ---------- 2. 哨兵值合成 ----------
let numSeq = 0
const NUM_BASE = 917_000_000 // 不会出现在任何真实字面量里的量级
const numToKey = new Map<string, string>()
const strToKey = new Map<string, string>()

function unwrap(t: z.ZodTypeAny): z.ZodTypeAny {
  let cur: any = t
  for (;;) {
    const tn = cur?._def?.typeName
    if (tn === 'ZodOptional' || tn === 'ZodNullable') cur = cur._def.innerType
    else if (tn === 'ZodDefault') cur = cur._def.innerType
    else if (tn === 'ZodEffects') cur = cur._def.schema
    else return cur
  }
}

function sentinelFor(key: string, t: z.ZodTypeAny): unknown {
  const cur: any = unwrap(t)
  const tn = cur?._def?.typeName
  switch (tn) {
    case 'ZodNumber': {
      const v = NUM_BASE + ++numSeq
      numToKey.set(String(v), key)
      return v
    }
    case 'ZodString': {
      const v = `__S_${key}__`
      strToKey.set(v, key)
      return v
    }
    case 'ZodEnum': return cur._def.values[0]
    case 'ZodNativeEnum': return Object.values(cur._def.values)[0]
    case 'ZodLiteral': return cur._def.value
    case 'ZodBoolean': return true
    case 'ZodArray': return [sentinelFor(key, cur._def.type)]
    case 'ZodObject': {
      const out: Record<string, unknown> = {}
      for (const [k, sub] of Object.entries(cur.shape as Record<string, z.ZodTypeAny>)) out[k] = sentinelFor(`${key}.${k}`, sub)
      return out
    }
    case 'ZodUnion': return sentinelFor(key, cur._def.options[0])
    case 'ZodRecord': return {}
    default: {
      const v = `__S_${key}__`
      strToKey.set(v, key)
      return v
    }
  }
}

// ---------- 3. 假 client:记录第一笔调用后中止 ----------
class Stop extends Error { constructor(public call: RecordedCall) { super('__stop__') } }
type RecordedCall = { method: string; path: string; body?: unknown }
const record = (method: string) => (path: string, body?: unknown): never => { throw new Stop({ method, path, body }) }
const fakeClient: any = {
  produceGet: record('get'),
  producePost: record('post'),
  producePut: record('put'),
  produceDelete: record('delete'),
  // 走本地文件直传/本地化服务的 handler 无法映射为单一 REST 调用 → 记为 unmapped
  uploadLocalFile: () => { throw new Error('unmappable: local file upload flow') },
  uploadFile: () => { throw new Error('unmappable: local file upload flow') },
  loc: () => { throw new Error('unmappable: localization orchestration') },
  locPost: () => { throw new Error('unmappable: localization orchestration') },
}

// ---------- 4. zod 属性 → JSON Schema(剥 optional,description 保留) ----------
function propSchema(t: z.ZodTypeAny): Record<string, unknown> {
  const js: any = zodToJsonSchema(t, { $refStrategy: 'none', target: 'jsonSchema7' })
  delete js.$schema
  return js
}

/** handler 变换出来的键(不在 zod shape 里):按哨兵结构反推 schema。 */
function inferFromValue(v: unknown): Record<string, unknown> {
  if (typeof v === 'number') return numToKey.has(String(v)) ? { type: 'number' } : { type: 'number' }
  if (typeof v === 'string') return { type: 'string' }
  if (typeof v === 'boolean') return { type: 'boolean' }
  if (Array.isArray(v)) return { type: 'array', items: v.length ? inferFromValue(v[0]) : {} }
  if (v && typeof v === 'object') {
    const props: Record<string, unknown> = {}
    for (const [k, sub] of Object.entries(v)) props[k] = inferFromValue(sub)
    return { type: 'object', properties: props }
  }
  return {}
}

// ---------- 5. 逐工具执行 ----------
registerProduceTools(fakeServer as any, fakeClient)

const ENVELOPE = {
  description: 'StarReel envelope',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          code: { type: 'integer' },
          message: { type: 'string' },
          data: { description: 'Operation result payload' },
        },
      },
    },
  },
}

const paths: Record<string, Record<string, unknown>> = {}
const unmapped: Array<{ tool: string; reason: string }> = []
const collisions: string[] = []

for (const tool of tools) {
  const args: Record<string, unknown> = {}
  for (const [k, t] of Object.entries(tool.shape)) args[k] = sentinelFor(k, t)

  let call: RecordedCall | null = null
  try {
    await tool.handler(args)
    unmapped.push({ tool: tool.name, reason: 'handler returned without HTTP call' })
    continue
  } catch (e) {
    if (e instanceof Stop) call = e.call
    else { unmapped.push({ tool: tool.name, reason: (e as Error).message.slice(0, 120) }); continue }
  }

  // 路径模板还原 + query 参数拆分
  let [rawPath, rawQuery] = call.path.split('?')
  const pathParams: string[] = []
  for (const [sent, key] of [...numToKey.entries(), ...strToKey.entries()]) {
    for (const enc of [sent, encodeURIComponent(sent)]) {
      if (rawPath.includes(enc)) { rawPath = rawPath.split(enc).join(`{${key}}`); if (!pathParams.includes(key)) pathParams.push(key) }
    }
  }
  const queryParams: Array<{ name: string; sentKey?: string }> = []
  if (rawQuery) {
    for (const pair of rawQuery.split('&')) {
      const [qk, qv = ''] = pair.split('=')
      const dec = decodeURIComponent(qv)
      queryParams.push({ name: qk, sentKey: strToKey.get(dec) ?? numToKey.get(dec) })
    }
  }

  const parameters: unknown[] = []
  for (const p of pathParams) {
    const inShape = tool.shape[p.split('.')[0]]
    parameters.push({
      name: p, in: 'path', required: true,
      schema: inShape ? propSchema(unwrap(inShape)) : { type: 'string' },
    })
  }
  for (const q of queryParams) {
    const src = q.sentKey ? tool.shape[q.sentKey.split('.')[0]] : undefined
    parameters.push({
      name: q.name, in: 'query', required: src ? !src.isOptional() : false,
      schema: src ? propSchema(unwrap(src)) : { type: 'string' },
    })
  }

  // 请求体:以 handler 真实发出的 body 键为准
  let requestBody: unknown
  if (call.body !== undefined && call.body !== null && typeof call.body === 'object') {
    const props: Record<string, unknown> = {}
    const required: string[] = []
    for (const [k, v] of Object.entries(call.body as Record<string, unknown>)) {
      if (k in tool.shape) {
        props[k] = propSchema(unwrap(tool.shape[k]))
        if (!tool.shape[k].isOptional()) required.push(k)
      } else {
        const inferred = inferFromValue(v)
        ;(inferred as any).description = `(assembled by the client from tool args — see tool '${tool.name}')`
        props[k] = inferred
      }
    }
    requestBody = {
      required: required.length > 0,
      content: { 'application/json': { schema: { type: 'object', properties: props, ...(required.length ? { required } : {}) } } },
    }
  }

  const tag = rawPath.split('/').filter(Boolean)[0] ?? 'misc'
  const op: Record<string, unknown> = {
    operationId: tool.name,
    summary: tool.description.split(/[。.]/)[0].slice(0, 120),
    description: tool.description,
    tags: [tag],
    ...(parameters.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: { '200': ENVELOPE, '402': { description: 'Insufficient prepaid balance (never overdrafts); response carries `needed` points' } },
  }

  paths[rawPath] ??= {}
  if (paths[rawPath][call.method]) {
    collisions.push(`${call.method.toUpperCase()} ${rawPath}: ${tool.name} (kept ${(paths[rawPath][call.method] as any).operationId})`)
    const kept: any = paths[rawPath][call.method]
    kept['x-also-tools'] = [...(kept['x-also-tools'] ?? []), tool.name]
    continue
  }
  paths[rawPath][call.method] = op
}

// ---------- 6. 鉴权端点(手工声明:不在工具面里) ----------
const authPath = {
  '/v1/agent/token': {
    post: {
      operationId: 'exchange_api_key',
      summary: 'Exchange a long-lived API key for a short-lived (15 min) bearer token',
      description: 'POST your `srk_live_...` API key (created in StarReel → Settings → API Keys) to obtain a 15-minute JWT. All /v1/produce/* calls require `Authorization: Bearer <token>`. On 401, re-exchange once and replay.',
      security: [],
      servers: [{ url: 'https://api.shortreelai.com' }],
      tags: ['auth'],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['api_key'], properties: { api_key: { type: 'string', description: 'srk_live_... key; stored server-side as a hash' } } } } },
      },
      responses: {
        '200': { description: 'Token envelope', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { access_token: { type: 'string' }, expires_in: { type: 'integer' } } } } } } } },
        '401': { description: 'API key rejected (revoked or invalid)' },
      },
    },
  },
}

// ---------- 7. 组装并落盘 ----------
const spec = {
  openapi: '3.1.0',
  info: {
    title: 'StarReel Production API',
    version: pkg.version,
    description: [
      'Turn a script into a finished, downloadable short-drama episode over REST.',
      '',
      'Pipeline: script → AI rewrite → cast/scenes/props extraction → portraits & sheets → storyboards → keyframes → video shots → TTS → final cut (.mp4).',
      '',
      '**Billing is prepaid and agent-safe**: big-ticket stages are quote-then-generate (`quote_*` returns a `quote_id`; for video, quote == actual charge). Insufficient balance returns 402 — nothing half-runs and the account never goes negative.',
      '',
      'Auth: exchange your API key at `POST /v1/agent/token` for a 15-minute bearer token.',
      '',
      `Generated from the @starreel/mcp v${pkg.version} tool surface (operationIds match MCP tool names 1:1).`,
    ].join('\n'),
  },
  servers: [{ url: 'https://api.shortreelai.com/v1/produce', description: 'Production facade (paths below are relative to this base)' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Short-lived token from POST /v1/agent/token' },
    },
  },
  tags: [...new Set(Object.keys(paths).map((p) => p.split('/').filter(Boolean)[0] ?? 'misc'))].sort().map((t) => ({ name: t, description: `Operations under /${t}` })),
  paths: { ...Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))), ...authPath },
  ...(unmapped.length ? { 'x-unmapped-tools': unmapped } : {}),
}
;(spec.tags as Array<{ name: string; description?: string }>).push({ name: 'auth', description: 'API-key → short-lived bearer token exchange' })

writeFileSync(join(ROOT, 'openapi.json'), JSON.stringify(spec, null, 2) + '\n')

const opCount = Object.values(paths).reduce((n, m) => n + Object.keys(m).length, 0)
console.log(`✅ openapi.json: ${opCount} operations from ${tools.length} tools (${unmapped.length} unmapped)`)
if (unmapped.length) console.error('⚠ unmapped tools (documented in x-unmapped-tools):\n' + unmapped.map((u) => `  - ${u.tool}: ${u.reason}`).join('\n'))
if (collisions.length) console.error('⚠ path collisions (merged into x-also-tools):\n' + collisions.map((c) => `  - ${c}`).join('\n'))
