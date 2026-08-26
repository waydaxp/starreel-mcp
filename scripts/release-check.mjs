#!/usr/bin/env node
/**
 * v0.1.39 — MCP 发版闸(P2-10)。prepublishOnly 自动跑;任一断言失败 exit 1 拒发。
 * 历史事故:package.json/server.json 三处版本号漂移过(0.1.10/0.1.12/0.1.24 并存);
 * dist 陈旧发包(tsc 注释泄密那次也是 dist 面审计缺失)。闸必须真退出码,echo 不算闸。
 */
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (msg) => { console.error(`❌ release-check: ${msg}`); process.exit(1) }

// ① 版本三处一致(package.json ×1 + server.json ×2)
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const serverRaw = readFileSync(join(ROOT, 'server.json'), 'utf8')
const versionsInServer = [...serverRaw.matchAll(/"version"\s*:\s*"([^"]+)"/g)].map(m => m[1])
if (!versionsInServer.length) fail('server.json 里找不到 version')
for (const v of versionsInServer) {
  if (v !== pkg.version) fail(`版本漂移:package.json=${pkg.version} 但 server.json 含 ${v}(两文件三处必须一致)`)
}
// Claude Code plugin 清单若带 version 也必须同步(.claude-plugin/plugin.json,第四处)
const pluginManifest = join(ROOT, '.claude-plugin', 'plugin.json')
if (existsSync(pluginManifest)) {
  const plug = JSON.parse(readFileSync(pluginManifest, 'utf8'))
  if (plug.version && plug.version !== pkg.version) fail(`版本漂移:plugin.json=${plug.version} ≠ package.json=${pkg.version}`)
}
// openapi.json 若存在也必须同版本(防 spec 陈旧发包;重生成 = npm run generate:openapi)
const specPath = join(ROOT, 'openapi.json')
if (existsSync(specPath)) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'))
  if (spec?.info?.version !== pkg.version) {
    fail(`openapi.json 陈旧:info.version=${spec?.info?.version} ≠ package.json=${pkg.version}(先 npm run generate:openapi)`)
  }
}

// ② dist 新鲜:dist 最新 mtime 不得早于 src 最新 mtime(prepublishOnly 先跑 build,此闸兜底手滑)
function latestMtime(dir) {
  let latest = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) latest = Math.max(latest, latestMtime(p))
    else latest = Math.max(latest, statSync(p).mtimeMs)
  }
  return latest
}
const srcM = latestMtime(join(ROOT, 'src'))
let distM = 0
try { distM = latestMtime(join(ROOT, 'dist')) } catch { fail('dist/ 不存在:先 npm run build') }
if (distM < srcM) fail('dist 比 src 陈旧:先 npm run build 再发')

// ③ 本地版本必须领先 npm 线上(防重发旧版/忘 bump)
let published = ''
try {
  published = execSync('npm view @starreel/mcp version', { encoding: 'utf8', timeout: 15000 }).trim()
} catch { console.warn('⚠ release-check: npm view 不可达,跳过线上版本比对(离线?)') }
if (published) {
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0) }
    return 0
  }
  if (cmp(pkg.version, published) <= 0) fail(`本地 ${pkg.version} ≤ npm 线上 ${published}:先 bump 版本(两文件三处)`)
}

// ④ 发布面脱敏抽查:dist 不得含禁发串(0.1.28 教训:tsc 不删注释,注释泄密)。
//    禁发词表经环境变量 RELEASE_BANNED_WORDS(逗号分隔)注入,未设置则跳过本项。
const grep = (dir, needle) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { const hit = grep(p, needle); if (hit) return hit }
    else if (/\.(js|d\.ts|md|json)$/.test(e.name) && readFileSync(p, 'utf8').toLowerCase().includes(needle)) return p
  }
  return null
}
const banned = (process.env.RELEASE_BANNED_WORDS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
for (const needle of banned) {
  const leak = grep(join(ROOT, 'dist'), needle)
  if (leak) fail(`dist 含禁发串「${needle}」(${leak}):清理后重新 build`)
}

console.log(`✅ release-check 通过:v${pkg.version}(线上 ${published || '未知'})· dist 新鲜 · 版本三处一致 · 脱敏抽查过`)
console.log('📋 人工核对(无法自动断言):本次若给端点新增了返回字段/能力,对应工具描述与 SKILL.md 是否已同步?——「门面有能力≠第三方找得到」已两次成为事故。')
