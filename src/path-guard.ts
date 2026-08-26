/**
 * v0.1.37 — 本地文件上传的路径安全闸（安全评估 P0③）。
 *
 * uploadLocalFile 此前接受任意绝对路径：一个被注入的第三方 agent 可以把
 * ~/.ssh/id_rsa、.env、浏览器资料库当"素材"上传到 COS（公共可读 URL）。
 * 本闸不引入 workspace 概念（MCP 进程不知道调用方的工作目录语义），
 * 而是用两条与"上传媒体素材"这一合法用途严格对齐的规则：
 *   ① 扩展名必须是对应 kind 的媒体白名单（.env/.pem/id_rsa 天然出局）；
 *   ② realpath 后的路径中不得含任何以 '.' 开头的路径段（~/.ssh、~/.codex、
 *      ~/.aws、.git 等敏感目录全部命中），也不得落在系统配置区（/etc、/private/etc）。
 * 符号链接先解析再判（防 media.jpg -> ~/.ssh/id_rsa 绕过）。
 */
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'

export const MEDIA_EXT_BY_KIND: Record<'image' | 'video' | 'audio', ReadonlySet<string>> = {
  image: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']),
  video: new Set(['.mp4', '.mov', '.webm', '.m4v']),
  audio: new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']),
}

const SYSTEM_PREFIXES = ['/etc/', '/private/etc/', '/proc/', '/sys/']

/** 校验通过返回解析后的真实路径；不通过抛 Error（消息面向第三方 agent，说清正路）。 */
export function assertSafeLocalMediaPath(
  filePath: string,
  kind: 'image' | 'video' | 'audio',
  resolve: (p: string) => string = realpathSync,
): string {
  const ext = (filePath.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase()
  if (!MEDIA_EXT_BY_KIND[kind].has(ext)) {
    throw new Error(
      `file_path 只接受${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}媒体文件`
      + `(${[...MEDIA_EXT_BY_KIND[kind]].join('/')});收到 "${ext || '无扩展名'}"。`
      + '不要用本工具上传配置/密钥/文档类文件。',
    )
  }
  let real: string
  try {
    real = resolve(filePath)
  } catch {
    throw new Error(`file_path 不存在或不可读:${filePath}`)
  }
  const segments = real.split(sep)
  if (segments.some(s => s.startsWith('.') && s.length > 1)) {
    throw new Error(
      `file_path 位于隐藏目录(${real}),已拒绝——敏感目录(如 ~/.ssh、~/.aws、.git)不允许作为上传源。`
      + '把素材放到普通目录再上传。',
    )
  }
  if (SYSTEM_PREFIXES.some(p => real.startsWith(p))) {
    throw new Error(`file_path 位于系统目录(${real}),已拒绝。`)
  }
  return real
}
