import { z } from 'zod'
import type { AuthPort } from '../auth/auth-manager'
import { ToolInvocationSchema } from '../../shared/contracts/tools'
import type { ToolStack } from './create-tools'

/**
 * Development only (unpackaged app with JARVIS_TOOL_SELFTEST set to a JSON array of invocations):
 * once signed in, run each invocation in order and print the report, so the real desktop
 * adapter can be exercised without a server. A repeated executionId shows deduplication.
 */
export function startToolSelfTest(
  rawInvocations: string,
  auth: Pick<AuthPort, 'subscribe'>,
  tools: ToolStack,
  log: (line: string) => void = console.log
): () => void {
  const print = (label: string, value: unknown) =>
    log(`TOOL_SELFTEST ${label} ${JSON.stringify(value)}`)
  let invocations: z.infer<typeof ToolInvocationSchema>[]
  try {
    invocations = z.array(ToolInvocationSchema).parse(JSON.parse(rawInvocations))
  } catch {
    print('error', 'JARVIS_TOOL_SELFTEST must be a JSON array of tool invocations')
    return () => undefined
  }
  const run = async () => {
    print('capabilities', tools.registry.getSnapshot())
    for (const invocation of invocations)
      print('report', await tools.executor.execute(invocation, { signal: undefined }))
    print('done', invocations.length)
  }
  return auth.subscribe((event) => {
    if (event.type === 'auth.state_changed' && event.snapshot.phase === 'signed_in')
      void run().catch((error: unknown) => print('error', String(error)))
  })
}
