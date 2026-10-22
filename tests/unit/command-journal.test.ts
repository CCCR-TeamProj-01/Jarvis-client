import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandJournal } from '../../src/main/commands/command-journal'
import type { CommandKey } from '../../src/main/commands/command-journal'
import { CommandResultSchema } from '../../src/main/commands/command-result'
import type { CommandResult } from '../../src/main/commands/command-result'
import { NodeLocalFiles } from '../../src/main/settings/node-local-files'

class MemoryFiles {
  contents: string | null = null
  writes = 0
  failWrites = false
  failReads = false
  async read(): Promise<string | null> {
    if (this.failReads) throw new Error('read failed')
    return this.contents
  }
  async replace(_name: string, contents: string): Promise<void> {
    if (this.failWrites) throw new Error('write failed')
    this.writes += 1
    this.contents = contents
  }
}

const HOUR = 60 * 60 * 1000
let now = 1_000_000_000_000

function journalOver(
  files: MemoryFiles,
  extra: { retentionMs?: number; maxEntriesPerUser?: number } = {}
) {
  return new CommandJournal({ files, now: () => now, ...extra })
}

const key = (commandId: string, attemptNo = 1): CommandKey => ({ commandId, attemptNo })

const result = (attemptNo = 1): CommandResult =>
  CommandResultSchema.parse({
    attempt_no: attemptNo,
    status: 'success',
    observation_status: 'confirmed',
    result_message: '폴더 열기을(를) 마쳤어요.',
    started_at: '2026-10-22T03:00:00.000Z',
    finished_at: '2026-10-22T03:00:01.000Z',
    reported_at: '2026-10-22T03:00:01.000Z'
  })

describe('begin', () => {
  it('records a new command as started and writes it before returning', async () => {
    const files = new MemoryFiles()
    const view = journalOver(files).forUser('u1')
    expect(await view.begin(key('7'))).toEqual({ ok: true, value: { kind: 'started' } })
    expect(files.writes).toBe(1)
    expect(JSON.parse(files.contents ?? '{}').entries[0]).toMatchObject({
      userId: 'u1',
      commandId: '7',
      attemptNo: 1,
      state: 'started'
    })
  })

  it('reports a command it has already seen instead of starting it again', async () => {
    const view = journalOver(new MemoryFiles()).forUser('u1')
    await view.begin(key('7'))
    const again = await view.begin(key('7'))
    expect(again).toMatchObject({
      ok: true,
      value: { kind: 'existing', entry: { state: 'started' } }
    })
  })

  it('treats another attempt of the same command as a different command', async () => {
    const view = journalOver(new MemoryFiles()).forUser('u1')
    await view.begin(key('7', 1))
    expect(await view.begin(key('7', 2))).toEqual({ ok: true, value: { kind: 'started' } })
  })

  it('starts exactly one of many simultaneous requests for the same command', async () => {
    const view = journalOver(new MemoryFiles()).forUser('u1')
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => view.begin(key('7'))))
    const started = outcomes.filter((o) => o.ok && o.value.kind === 'started')
    expect(started).toHaveLength(1)
  })

  it('does not start the command when the record cannot be written, and may be tried again', async () => {
    const files = new MemoryFiles()
    const view = journalOver(files).forUser('u1')
    files.failWrites = true
    const failed = await view.begin(key('7'))
    expect(failed).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(await view.get(key('7'))).toEqual({ ok: true, value: undefined })
    files.failWrites = false
    expect(await view.begin(key('7'))).toEqual({ ok: true, value: { kind: 'started' } })
  })
})

describe('finish and report', () => {
  it('keeps the result until the server has stored it', async () => {
    const view = journalOver(new MemoryFiles()).forUser('u1')
    await view.begin(key('7'))
    await view.finish(key('7'), result())
    const waiting = await view.unreported()
    expect(waiting).toMatchObject({
      ok: true,
      value: [{ commandId: '7', state: 'finished', result: result() }]
    })
    await view.markReported(key('7'))
    expect(await view.unreported()).toEqual({ ok: true, value: [] })
    expect(await view.get(key('7'))).toMatchObject({ ok: true, value: { state: 'reported' } })
  })

  it('lists waiting results oldest first', async () => {
    const view = journalOver(new MemoryFiles()).forUser('u1')
    await view.begin(key('1'))
    await view.begin(key('2'))
    now += 10
    await view.finish(key('2'), result())
    now += 10
    await view.finish(key('1'), result())
    const waiting = await view.unreported()
    expect(waiting.ok && waiting.value.map((entry) => entry.commandId)).toEqual(['2', '1'])
  })

  it('refuses to finish a command it never started', async () => {
    const view = journalOver(new MemoryFiles()).forUser('u1')
    expect(await view.finish(key('9'), result())).toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
    expect(await view.markReported(key('9'))).toMatchObject({ ok: false })
  })

  it('still remembers in this run that a command finished when the write fails', async () => {
    const files = new MemoryFiles()
    const view = journalOver(files).forUser('u1')
    await view.begin(key('7'))
    files.failWrites = true
    expect(await view.finish(key('7'), result())).toMatchObject({ ok: false })
    expect(await view.get(key('7'))).toMatchObject({ ok: true, value: { state: 'finished' } })
    expect(await view.begin(key('7'))).toMatchObject({ ok: true, value: { kind: 'existing' } })
  })
})

describe('after a restart', () => {
  it('turns a command cut off while running into an unknown result and never starts it again', async () => {
    const files = new MemoryFiles()
    const before = journalOver(files).forUser('u1')
    await before.begin(key('7', 2))

    const after = journalOver(files).forUser('u1') // a new process reading the same file
    const waiting = await after.unreported()
    expect(waiting).toMatchObject({
      ok: true,
      value: [
        {
          commandId: '7',
          attemptNo: 2,
          state: 'finished',
          result: {
            attempt_no: 2,
            status: 'unknown',
            observation_status: 'unknown'
          }
        }
      ]
    })
    expect(await after.begin(key('7', 2))).toMatchObject({ ok: true, value: { kind: 'existing' } })
  })

  it('dates an interrupted result from when the command began to when the app came back', async () => {
    const files = new MemoryFiles()
    now = Date.parse('2026-10-22T03:00:00.000Z')
    await journalOver(files).forUser('u1').begin(key('7'))
    now = Date.parse('2026-10-22T03:05:00.000Z')
    const waiting = await journalOver(files).forUser('u1').unreported()
    expect(waiting.ok && waiting.value[0]?.result).toMatchObject({
      started_at: '2026-10-22T03:00:00.000Z',
      finished_at: '2026-10-22T03:05:00.000Z',
      reported_at: '2026-10-22T03:05:00.000Z'
    })
    expect(waiting.ok && waiting.value[0]?.result?.failure_stage).toBeUndefined()
  })

  it('keeps finished and reported entries as they were', async () => {
    const files = new MemoryFiles()
    const before = journalOver(files).forUser('u1')
    await before.begin(key('1'))
    await before.finish(key('1'), result())
    await before.begin(key('2'))
    await before.finish(key('2'), result())
    await before.markReported(key('2'))

    const after = journalOver(files).forUser('u1')
    expect(await after.get(key('1'))).toMatchObject({ ok: true, value: { state: 'finished' } })
    expect(await after.get(key('2'))).toMatchObject({ ok: true, value: { state: 'reported' } })
    expect(await after.begin(key('1'))).toMatchObject({ ok: true, value: { kind: 'existing' } })
  })
})

describe('users', () => {
  it('shows a user nothing of another user, even for the same command', async () => {
    const journal = journalOver(new MemoryFiles())
    await journal.forUser('u1').begin(key('7'))
    await journal.forUser('u1').finish(key('7'), result())
    const other = journal.forUser('u2')
    expect(await other.get(key('7'))).toEqual({ ok: true, value: undefined })
    expect(await other.unreported()).toEqual({ ok: true, value: [] })
    expect(await other.begin(key('7'))).toEqual({ ok: true, value: { kind: 'started' } })
    expect(await other.markReported(key('8'))).toMatchObject({ ok: false })
  })

  it("removes every other user's entries when a different account signs in", async () => {
    const files = new MemoryFiles()
    const journal = journalOver(files)
    await journal.forUser('u1').begin(key('1'))
    await journal.forUser('u2').begin(key('2'))
    expect(await journal.purgeOthers('u2')).toEqual({ ok: true, value: undefined })
    expect(await journal.forUser('u1').get(key('1'))).toEqual({ ok: true, value: undefined })
    expect(await journal.forUser('u2').get(key('2'))).toMatchObject({ ok: true })
    expect(files.contents).not.toContain('"u1"')
    const writes = files.writes
    await journal.purgeOthers('u2') // nothing left to remove: no needless write
    expect(files.writes).toBe(writes)
  })
})

describe('a file that cannot be trusted', () => {
  it.each([
    ['not JSON', '{oops'],
    ['an unknown version', JSON.stringify({ version: 2, entries: [] })],
    ['an unknown field', JSON.stringify({ version: 1, entries: [], extra: 1 })],
    ['a damaged entry', JSON.stringify({ version: 1, entries: [{ userId: 'u1' }] })],
    [
      'an entry with a stray field',
      JSON.stringify({
        version: 1,
        entries: [
          {
            userId: 'u1',
            commandId: '1',
            attemptNo: 1,
            state: 'started',
            updatedAtUnixMs: 1,
            url: 'https://x'
          }
        ]
      })
    ]
  ])('fails every call and leaves the file alone when it holds %s', async (_name, contents) => {
    const files = new MemoryFiles()
    files.contents = contents
    const view = journalOver(files).forUser('u1')
    expect(await view.begin(key('7'))).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(await view.get(key('7'))).toMatchObject({ ok: false })
    expect(await view.unreported()).toMatchObject({ ok: false })
    expect(await journalOver(files).purgeOthers('u1')).toMatchObject({ ok: false })
    expect(files.writes).toBe(0)
    expect(files.contents).toBe(contents)
  })

  it('fails when the file cannot be read, and recovers when it can be again', async () => {
    const files = new MemoryFiles()
    const view = journalOver(files).forUser('u1')
    files.failReads = true
    expect(await view.begin(key('7'))).toMatchObject({ ok: false })
    files.failReads = false
    expect(await view.begin(key('7'))).toEqual({ ok: true, value: { kind: 'started' } })
  })

  it('does not put the error text of the file into its message', async () => {
    const files = new MemoryFiles()
    files.contents = '{"secret":"abc"}'
    const outcome = await journalOver(files).forUser('u1').begin(key('7'))
    expect(JSON.stringify(outcome)).not.toContain('secret')
  })
})

describe('retention', () => {
  it('drops entries older than the retention period', async () => {
    const files = new MemoryFiles()
    const journal = journalOver(files, { retentionMs: 24 * HOUR })
    const view = journal.forUser('u1')
    await view.begin(key('1'))
    await view.finish(key('1'), result())
    now += 25 * HOUR
    await view.begin(key('2')) // the next write prunes
    expect(await view.get(key('1'))).toEqual({ ok: true, value: undefined })
    expect(await view.get(key('2'))).toMatchObject({ ok: true, value: { state: 'started' } })
  })

  it('keeps recent entries', async () => {
    const view = journalOver(new MemoryFiles(), { retentionMs: 24 * HOUR }).forUser('u1')
    await view.begin(key('1'))
    now += 23 * HOUR
    await view.begin(key('2'))
    expect(await view.get(key('1'))).toMatchObject({ ok: true, value: { commandId: '1' } })
  })

  it('over the cap drops the oldest reported entries and never a waiting result', async () => {
    const view = journalOver(new MemoryFiles(), { maxEntriesPerUser: 3 }).forUser('u1')
    for (const id of ['1', '2', '3']) {
      await view.begin(key(id))
      now += 1
      await view.finish(key(id), result())
    }
    await view.markReported(key('1'))
    now += 1
    await view.markReported(key('2'))
    now += 1
    await view.begin(key('4'))
    expect(await view.get(key('1'))).toEqual({ ok: true, value: undefined })
    expect(await view.get(key('2'))).toMatchObject({ ok: true, value: { state: 'reported' } })
    expect(await view.get(key('3'))).toMatchObject({ ok: true, value: { state: 'finished' } })
    expect(await view.get(key('4'))).toMatchObject({ ok: true, value: { state: 'started' } })
  })

  it('keeps waiting results even beyond the cap', async () => {
    const view = journalOver(new MemoryFiles(), { maxEntriesPerUser: 2 }).forUser('u1')
    for (const id of ['1', '2', '3', '4']) {
      await view.begin(key(id))
      await view.finish(key(id), result())
    }
    const waiting = await view.unreported()
    expect(waiting.ok && waiting.value).toHaveLength(4)
  })
})

describe('what is stored', () => {
  it('holds IDs, state and the fixed result and nothing else', async () => {
    const files = new MemoryFiles()
    const view = journalOver(files).forUser('u1')
    await view.begin(key('7'))
    await view.finish(key('7'), result())
    const entry = JSON.parse(files.contents ?? '{}').entries[0]
    expect(Object.keys(entry).sort()).toEqual(
      ['attemptNo', 'commandId', 'result', 'state', 'updatedAtUnixMs', 'userId'].sort()
    )
  })
})

describe('on a real disk', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    )
  })

  it('survives a restart through the real file store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-journal-'))
    directories.push(directory)
    const first = new CommandJournal({ files: new NodeLocalFiles(directory), now: () => now })
    await first.forUser('u1').begin(key('7'))
    await first.forUser('u1').finish(key('7'), result())
    await first.forUser('u1').begin(key('8'))

    const second = new CommandJournal({ files: new NodeLocalFiles(directory), now: () => now })
    const view = second.forUser('u1')
    expect(await view.begin(key('7'))).toMatchObject({ ok: true, value: { kind: 'existing' } })
    const waiting = await view.unreported()
    expect(waiting.ok && waiting.value.map((e) => [e.commandId, e.result?.status])).toEqual([
      ['7', 'success'],
      ['8', 'unknown']
    ])
  })

  it('does not overwrite a damaged file on disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-journal-'))
    directories.push(directory)
    await writeFile(join(directory, 'command-journal.json'), 'garbage', 'utf8')
    const journal = new CommandJournal({ files: new NodeLocalFiles(directory), now: () => now })
    expect(await journal.forUser('u1').begin(key('7'))).toMatchObject({ ok: false })
    expect(await readFile(join(directory, 'command-journal.json'), 'utf8')).toBe('garbage')
  })
})
