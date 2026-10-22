import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseServerBaseUrl } from '../../src/main/connection/server-config'

const ROOT = join(__dirname, '..', '..')
const example = readFileSync(join(ROOT, '.env.example'), 'utf8')

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|cjs|mjs)$/.test(entry.name) ? [path] : []
  })
}

/** The JARVIS_ variables the code reads from the environment. */
function variablesTheCodeReads(): Set<string> {
  const found = new Set<string>()
  for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'scripts'))]) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(
      /\benv\.(JARVIS_[A-Z0-9_]+)\b|\benv\[['"](JARVIS_[A-Z0-9_]+)['"]\]/g
    ))
      found.add(match[1] ?? match[2]!)
  }
  return found
}

/** Every `NAME=value` line of the example, whether it is switched on or commented out. */
function variablesTheExampleNames(): Map<string, { active: boolean; line: string }> {
  const named = new Map<string, { active: boolean; line: string }>()
  for (const line of example.split('\n')) {
    const match = /^(#\s*)?(JARVIS_[A-Z0-9_]+)=/.exec(line)
    if (match) named.set(match[2]!, { active: match[1] === undefined, line })
  }
  return named
}

describe('.env.example', () => {
  it('names every variable the code reads, so a new one cannot be left out', () => {
    const named = variablesTheExampleNames()
    const missing = [...variablesTheCodeReads()].filter((name) => !named.has(name))
    expect(missing).toEqual([])
  })

  it('names nothing the code no longer reads, so a removed one cannot linger', () => {
    const reads = variablesTheCodeReads()
    const stale = [...variablesTheExampleNames().keys()].filter((name) => !reads.has(name))
    expect(stale).toEqual([])
  })

  it('switches on only the server address, so copying it turns no stand-in on', () => {
    expect(Object.keys(parseEnv(example))).toEqual(['JARVIS_SERVER_URL'])
  })

  it('has a server address the app accepts', () => {
    const url = parseEnv(example).JARVIS_SERVER_URL
    expect(parseServerBaseUrl(url ?? '')).toEqual({ status: 'ready', baseUrl: url })
  })

  it('has lines that work when a comment mark is taken off', () => {
    const broken: string[] = []
    for (const [name, { active, line }] of variablesTheExampleNames()) {
      if (active) continue
      const parsed = parseEnv(line.replace(/^#\s*/, ''))
      const keys = Object.keys(parsed)
      if (keys.length !== 1 || keys[0] !== name || parsed[name] === '') broken.push(name)
    }
    expect(broken).toEqual([])
  })

  it('gives the tool self-test a value that is a JSON list once it is switched on', () => {
    const line = variablesTheExampleNames().get('JARVIS_TOOL_SELFTEST')!.line
    const value = parseEnv(line.replace(/^#\s*/, '')).JARVIS_TOOL_SELFTEST
    expect(Array.isArray(JSON.parse(value ?? ''))).toBe(true)
  })

  it('says a packaged app does not read the file and that the shell comes first', () => {
    expect(example).toMatch(/패키징된 앱은 이 파일이 있어도 읽지 않는다/)
    expect(example).toMatch(/셸에서 이미 지정한 값이 우선/)
  })
})
