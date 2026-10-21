// Pinned official assets. Archives stay in the ignored cache and are never packaged.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { x } from 'tar'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'models')
const cache = join(root, '.wake-cache')
const modelName = 'vosk-model-small-ko-0.22'
const modelHash = 'eea36124087fed26c59996a4761519458e3bd185e8ea9d9865ad8760c4a1d989'
const engineHash = 'f0acfb81236e492f29193ffbd1029204cd0af7107fca4e5e5a410432b3291ad3'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function archive(name, url, hash) {
  const file = join(cache, name)
  try {
    const cached = await readFile(file)
    if (digest(cached) === hash) return cached
  } catch {
    /* No verified cache yet. */
  }
  console.log(`download ${name}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (digest(bytes) !== hash) throw new Error(`${name}: checksum mismatch`)
  await writeFile(`${file}.download`, bytes)
  await rename(`${file}.download`, file)
  return bytes
}

await mkdir(cache, { recursive: true })
const zip = await archive(
  `${modelName}.zip`,
  `https://alphacephei.com/vosk/models/${modelName}.zip`,
  modelHash
)
const stage = join(cache, 'model-stage')
await rm(stage, { recursive: true, force: true })
await mkdir(stage)
for (const [name, bytes] of Object.entries(unzipSync(zip))) {
  if (
    !name.startsWith(`${modelName}/`) ||
    name.split('/').some((p) => p === '..' || p === '.') ||
    name.includes('\\')
  )
    throw new Error('unexpected model path')
  if (name.endsWith('/')) continue
  const destination = join(stage, name)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
}
// This is an explicit model installation while the app is closed, never an in-app update.
await rm(join(root, modelName), { recursive: true, force: true })
await rename(join(stage, modelName), join(root, modelName))
await rm(stage, { recursive: true, force: true })

await archive('vosk-0.3.39.tgz', 'https://registry.npmjs.org/vosk/-/vosk-0.3.39.tgz', engineHash)
const nativeStage = join(cache, 'native-stage')
await rm(nativeStage, { recursive: true, force: true })
await mkdir(nativeStage)
const platform =
  process.platform === 'darwin'
    ? 'osx-universal'
    : process.platform === 'win32' && process.arch === 'x64'
      ? 'win-x86_64'
      : null
if (!platform) throw new Error('wake runtime supports macOS x64/arm64 and Windows x64 only')
const names =
  platform === 'osx-universal'
    ? ['libvosk.dylib']
    : ['libvosk.dll', 'libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll']
const allowed = new Set(names.map((name) => `package/lib/${platform}/${name}`))
await x({
  file: join(cache, 'vosk-0.3.39.tgz'),
  cwd: nativeStage,
  filter: (name) => allowed.has(name)
})
const destination = join(root, 'vosk-native', platform)
await mkdir(destination, { recursive: true })
for (const name of names) {
  await copyFile(
    join(nativeStage, 'package', 'lib', platform, name),
    join(destination, `${name}.download`)
  )
  await rename(join(destination, `${name}.download`), join(destination, name))
}
await rm(nativeStage, { recursive: true, force: true })
console.log(`installed ${modelName} / Vosk 0.3.39 ${platform}`)
