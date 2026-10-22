import { describe, expect, it, vi } from 'vitest'
import { CommandApi } from '../../src/main/commands/command-api'
import { CommandResultSchema } from '../../src/main/commands/command-result'
import { ServerClient } from '../../src/main/connection/server-client'
import type { FetchLike } from '../../src/main/connection/server-client'

const BASE = 'http://127.0.0.1:8001/api/v1'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const result = CommandResultSchema.parse({
  attempt_no: 1,
  status: 'success',
  observation_status: 'confirmed',
  result_message: '앱 실행을(를) 마쳤어요.',
  started_at: '2026-10-22T03:00:01.000Z',
  finished_at: '2026-10-22T03:00:02.000Z',
  reported_at: '2026-10-22T03:00:02.000Z',
  app: { app_code: 'chrome', os_app_id: 'com.google.Chrome', display_name: 'Google Chrome' },
  activity: {
    event_key: 'act_1',
    event_type: 'launched',
    occurred_at: '2026-10-22T03:00:02.000Z',
    collection_revision: 3,
    running_apps: ['chrome', 'vscode']
  }
})

function api(respond: (url: string, init: RequestInit) => Response) {
  const fetch = vi.fn<FetchLike>(async (url, init) => respond(url, init))
  return {
    api: new CommandApi(new ServerClient({ baseUrl: BASE, fetch, accessToken: () => 'tok' })),
    fetch
  }
}

describe('sending a result with an activity', () => {
  it('sends the activity in the body as it is', async () => {
    const t = api(() =>
      json({ command_id: 8801, attempt_no: 1, status: 'success', activity_recorded: true }, 201)
    )
    await t.api.send('8801', result)
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/commands/8801/results`)
    expect(JSON.parse(String(init.body))).toMatchObject({
      app: { app_code: 'chrome' },
      activity: {
        event_key: 'act_1',
        event_type: 'launched',
        collection_revision: 3,
        running_apps: ['chrome', 'vscode']
      }
    })
  })

  it('tells that the activity was recorded', async () => {
    const t = api(() =>
      json({ command_id: 8801, attempt_no: 1, status: 'success', activity_recorded: true }, 201)
    )
    expect(await t.api.send('8801', result)).toEqual({ kind: 'stored', activityRecorded: true })
  })

  it('tells that it was not, which is still a stored result', async () => {
    const t = api(() =>
      json({ command_id: 8801, attempt_no: 1, status: 'success', activity_recorded: false }, 201)
    )
    expect(await t.api.send('8801', result)).toEqual({ kind: 'stored', activityRecorded: false })
  })

  it('reads the answer to a result sent again the same way', async () => {
    const t = api(() =>
      json({ command_id: 8801, attempt_no: 1, status: 'success', activity_recorded: true }, 200)
    )
    expect(await t.api.send('8801', result)).toEqual({ kind: 'stored', activityRecorded: true })
  })

  it('does not say either when the server did not', async () => {
    const t = api(() => json({ command_id: 8801, attempt_no: 1, status: 'success' }, 201))
    expect(await t.api.send('8801', result)).toEqual({ kind: 'stored' })
  })

  it('does not take a recorded flag that is not a plain yes or no for a stored result', async () => {
    const t = api(() => json({ activity_recorded: 'yes' }, 201))
    expect(await t.api.send('8801', result)).toMatchObject({ kind: 'retry' })
  })

  it('keeps the old rules for a refusal, whatever is in the body', async () => {
    for (const status of [403, 404, 409, 422])
      expect(
        await api(() => json({ error: { code: 'X' } }, status)).api.send('8801', result)
      ).toEqual({
        kind: 'refused'
      })
    expect(
      await api(() => json({ error: { code: 'X' } }, 503)).api.send('8801', result)
    ).toMatchObject({
      kind: 'retry'
    })
  })
})
