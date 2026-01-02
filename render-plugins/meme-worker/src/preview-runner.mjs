// @ts-check
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * @param {Buffer} buffer
 */
function detectMime(buffer) {
  if (!buffer || buffer.length < 12) return null
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  // GIF87a / GIF89a
  const head6 = buffer.slice(0, 6).toString('ascii')
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif'
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  // WebP
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  // MP4
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp') return 'video/mp4'
  return null
}

/**
 * @param {any} error
 */
function describeError(error) {
  switch (error?.type) {
    case 'ImageAssetMissing':
      return { type: error.type, message: `缺少资源：${error.field0.path}` }
    case 'ImageDecodeError':
      return { type: error.type, message: String(error.field0?.error || '图片解码失败。') }
    case 'ImageEncodeError':
      return { type: error.type, message: String(error.field0?.error || '图片编码失败。') }
    case 'DeserializeError':
      return { type: error.type, message: String(error.field0?.error || '反序列化失败。') }
    case 'ImageNumberMismatch':
      return {
        type: error.type,
        message: `该模板需要 ${error.field0.min}~${error.field0.max} 张图片，实际提供了 ${error.field0.actual} 张。`,
      }
    case 'TextNumberMismatch':
      return {
        type: error.type,
        message: `该模板允许 ${error.field0.min}~${error.field0.max} 段文字，实际提供了 ${error.field0.actual} 段。`,
      }
    case 'TextOverLength':
      return { type: error.type, message: `存在超长文本：${error.field0.text}` }
    case 'MemeFeedback':
      return { type: error.type, message: String(error.field0.feedback || '生成表情失败。') }
    default:
      return { type: 'Unknown', message: '生成表情失败（未知错误）。' }
  }
}

function usage() {
  console.log(JSON.stringify({ ok: false, message: 'missing args' }))
}

const memeGeneratorUrl = process.env.MEME_GENERATOR_URL
const outPath = process.env.OUT_PATH
const placeholderB64 = process.env.PLACEHOLDER_B64 || ''

const key = process.argv[2] || ''
const minImages = Number(process.argv[3] || '0') || 0
const minTexts = Number(process.argv[4] || '0') || 0
const maxTexts = Number(process.argv[5] || String(minTexts)) || minTexts

if (!memeGeneratorUrl || !outPath || !key) {
  usage()
  process.exit(0)
}

let generatorSpecifier = memeGeneratorUrl
try {
  // Allow passing either an absolute path/file URL OR a bare package specifier.
  // When it's a bare specifier, resolve it to an absolute file URL in this subprocess.
  if (!/^(file:|\/|\.{1,2}\/)/.test(generatorSpecifier)) {
    const require = createRequire(import.meta.url)
    generatorSpecifier = pathToFileURL(require.resolve(generatorSpecifier)).href
  }
} catch (e) {
  console.log(
    JSON.stringify({
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    }),
  )
  process.exit(0)
}

let mod
try {
  // @ts-ignore
  mod = await import(generatorSpecifier)
} catch (e) {
  console.log(
    JSON.stringify({
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    }),
  )
  process.exit(0)
}
const { getMeme, Resources } = mod

Resources?.checkResourcesInBackground?.()

const meme = getMeme(key)
if (!meme) {
  console.log(JSON.stringify({ ok: false, message: `未找到模板：${key}` }))
  process.exit(0)
}

const placeholder = Buffer.from(placeholderB64, 'base64')
const images =
  minImages > 0 ? Array.from({ length: minImages }, (_, i) => ({ name: String.fromCharCode(97 + (i % 26)) + '.png', data: placeholder })) : []

// IMPORTANT:
// - Prefer template-provided `defaultTexts` whenever present.
// - Only fill our own placeholder texts when the template requires texts (`minTexts > 0`)
//   but provides insufficient `defaultTexts`.
const p = meme?.info?.params
const defaultsRaw = Array.isArray(p?.defaultTexts) ? p.defaultTexts : []
const defaults = defaultsRaw.map((t) => String(t))
const textPlaceholder = '1'

const requiredTexts = Math.max(0, minTexts)

// Only provide texts when the template requires them.
// When required, prefer defaultTexts; only fill placeholders if defaults are insufficient.
let texts = requiredTexts > 0 ? defaults.slice(0, requiredTexts) : []
if (texts.length < requiredTexts) {
  texts = texts.concat(Array.from({ length: requiredTexts - texts.length }, () => textPlaceholder))
}

let result
try {
  result = meme.generate(images, texts, {})
} catch {
  console.log(JSON.stringify({ ok: false, message: '生成表情失败，请稍后重试。' }))
  process.exit(0)
}

if (result?.type === 'Err') {
  const err = describeError(result.field0)
  console.log(JSON.stringify({ ok: false, message: err.message, errType: err.type }))
  process.exit(0)
}

const buf = Buffer.from(result.field0)
await fs.writeFile(outPath, buf)
console.log(
  JSON.stringify({
    ok: true,
    mime: detectMime(buf) || 'application/octet-stream',
    bytes: buf.length,
  }),
)
