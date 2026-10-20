// Downloads the local inference models the app needs into resources/models/ and verifies them.
// Models are not committed (see .gitignore). Run: pnpm models:fetch
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODELS = [
  {
    name: 'silero_vad.onnx',
    // Silero VAD (MIT), as packaged by sherpa-onnx.
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'
  }
]

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'models')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

async function present(model) {
  try {
    return sha256(await readFile(join(target, model.name))) === model.sha256
  } catch {
    return false
  }
}

await mkdir(target, { recursive: true })
let failed = false
for (const model of MODELS) {
  if (await present(model)) {
    console.log(`ok       ${model.name}`)
    continue
  }
  console.log(`download ${model.name}`)
  const response = await fetch(model.url, { redirect: 'follow' })
  if (!response.ok) {
    console.error(`failed   ${model.name}: HTTP ${response.status}`)
    failed = true
    continue
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (sha256(data) !== model.sha256) {
    console.error(`failed   ${model.name}: checksum mismatch, not installed`)
    failed = true
    continue
  }
  // Write to a temporary name first so an interrupted download never leaves a bad model behind.
  const temporary = join(target, `${model.name}.download`)
  await writeFile(temporary, data)
  await rename(temporary, join(target, model.name))
  console.log(`installed ${model.name}`)
}
await rm(join(target, 'silero_vad.onnx.download'), { force: true })
process.exit(failed ? 1 : 0)
