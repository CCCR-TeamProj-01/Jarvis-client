// Offline native-runtime check. Reads an explicitly supplied WAV; never opens a microphone.
const { app, utilityProcess } = require('electron')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const source = process.argv.slice(2).find((arg) => arg !== '--')
const result = {
  electron: process.versions.electron,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  detections: []
}
let child
let timer
let finished = false
function finish(code, error) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  if (error) result.error = error
  console.log(JSON.stringify(result, null, 2))
  child?.kill()
  app.exit(code)
}
function pcm(file) {
  const bytes = readFileSync(file)
  if (
    bytes.length > 2_000_000 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('Expected a short PCM WAV')
  let formatValid = false
  let audio
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4)
    const tag = bytes.toString('ascii', offset, offset + 4)
    const start = offset + 8
    if (start + size > bytes.length) throw new Error('Incomplete WAV')
    if (tag === 'fmt ' && size >= 16)
      formatValid =
        bytes.readUInt16LE(start) === 1 &&
        bytes.readUInt16LE(start + 2) === 1 &&
        bytes.readUInt32LE(start + 4) === 16000 &&
        bytes.readUInt16LE(start + 14) === 16
    if (tag === 'data') audio = bytes.subarray(start, start + size)
    offset = start + size + (size % 2)
  }
  if (!formatValid || !audio?.length || audio.length % 2)
    throw new Error('Expected mono 16 kHz signed 16-bit PCM')
  return Buffer.concat([audio, Buffer.alloc(64_000)])
}

app
  .whenReady()
  .then(() => {
    try {
      if (!source) return finish(1, 'Usage: pnpm wake:probe <mono-16k-pcm.wav>')
      const audio = pcm(source)
      const platform =
        process.platform === 'darwin'
          ? 'osx-universal/libvosk.dylib'
          : process.platform === 'win32' && process.arch === 'x64'
            ? 'win-x86_64/libvosk.dll'
            : null
      if (!platform) return finish(1, 'Unsupported platform/CPU')
      const started = performance.now()
      result.sampleCount = audio.length / 2 - 32_000
      const generation = { sessionId: 'offline-probe', revision: 0 }
      let offset = 0
      let sequence = 0
      child = utilityProcess.fork(join(root, 'out/main/wake-worker.js'), [], {
        serviceName: 'jarvis-wake-probe',
        stdio: 'ignore'
      })
      const next = () => {
        if (finished) return
        if (offset >= audio.length)
          return setTimeout(() => {
            result.elapsedMs = Math.round(performance.now() - started)
            finish(0)
          }, 100)
        const bytes = audio.subarray(offset, offset + 3200)
        child.postMessage({
          type: 'pcm',
          chunk: {
            generation,
            sequence: sequence++,
            startSample: offset / 2,
            format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
            audio: new Uint8Array(bytes)
          }
        })
        offset += bytes.length
      }
      child.on('message', (message) => {
        if (message.type === 'ready') {
          result.loadMs = Math.round(performance.now() - started)
          child.postMessage({ type: 'start', generation })
          next()
        } else if (message.type === 'consumed') setImmediate(next)
        else if (message.type === 'event') result.detections.push(message.event)
        else if (message.type === 'error')
          finish(1, 'Native model initialization or decoding failed')
      })
      child.on('exit', () => {
        if (!finished) finish(1, 'Inference process exited')
      })
      timer = setTimeout(() => finish(1, 'Inference timed out'), 30_000)
      child.postMessage({
        type: 'init',
        modelPath: join(root, 'resources/models/vosk-model-small-ko-0.22'),
        libraryPath: join(root, 'resources/models/vosk-native', platform)
      })
    } catch {
      finish(1, 'Could not read the requested PCM WAV or start inference')
    }
  })
  .catch(() => finish(1, 'Electron initialization failed'))
