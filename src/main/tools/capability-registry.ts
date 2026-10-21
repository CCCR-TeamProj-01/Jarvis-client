import type { Unsubscribe } from '../../shared/contracts/common'
import type { Capability, ToolName } from '../../shared/contracts/tools'
import type { CapabilityRegistryPort } from './ports'

type Availability = Capability['availability']

/**
 * What this device can run right now. The revision lets a server or caller tell that a request
 * was made against an older view; it only moves when something actually changed.
 */
export class CapabilityRegistry implements CapabilityRegistryPort {
  private capabilities: Capability[]
  private revision = 1
  private readonly listeners = new Set<
    (snapshot: ReturnType<CapabilityRegistry['getSnapshot']>) => void
  >()

  constructor(initial: readonly Capability[]) {
    this.capabilities = structuredClone([...initial])
  }

  getSnapshot(): { revision: number; capabilities: Capability[] } {
    return { revision: this.revision, capabilities: structuredClone(this.capabilities) }
  }

  find(tool: ToolName): Capability | undefined {
    return this.capabilities.find((capability) => capability.tool === tool)
  }

  /** Returns true if the state changed (and the revision advanced). */
  update(tool: ToolName, availability: Availability, reason?: string): boolean {
    const index = this.capabilities.findIndex((capability) => capability.tool === tool)
    if (index === -1) return false
    const current = this.capabilities[index]
    if (current.availability === availability && current.reason === reason) return false
    this.capabilities[index] = {
      tool,
      version: current.version,
      availability,
      ...(reason ? { reason } : {})
    }
    this.revision += 1
    const snapshot = this.getSnapshot()
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot)
      } catch {
        /* One observer cannot affect others. */
      }
    }
    return true
  }

  subscribe(
    listener: (snapshot: ReturnType<CapabilityRegistry['getSnapshot']>) => void
  ): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

const AUDIO_TOOLS: readonly ToolName[] = ['system.volume', 'system.mute']
const APP_TOOLS: readonly ToolName[] = ['apps.list', 'apps.launch', 'apps.activate', 'apps.restore']

/** Tool availability for a platform: app tools need an OS adapter, the browser handoff does not, and the file manager exists on both supported desktops. */
export function platformCapabilities(platform: NodeJS.Platform): Capability[] {
  const appsSupported = platform === 'darwin'
  const folderSupported = platform === 'darwin' || platform === 'win32'
  const audioSupported = platform === 'darwin'
  return [
    ...APP_TOOLS.map<Capability>((tool) =>
      appsSupported
        ? { tool, version: 1, availability: 'available' }
        : {
            tool,
            version: 1,
            availability: 'unsupported',
            reason: '이 운영체제의 앱 제어는 아직 지원하지 않습니다.'
          }
    ),
    { tool: 'browser.open', version: 1, availability: 'available' },
    folderSupported
      ? { tool: 'folder.open', version: 1, availability: 'available' }
      : {
          tool: 'folder.open',
          version: 1,
          availability: 'unsupported',
          reason: '이 운영체제의 폴더 열기는 아직 지원하지 않습니다.'
        },
    ...AUDIO_TOOLS.map<Capability>((tool) =>
      audioSupported
        ? { tool, version: 1, availability: 'available' }
        : {
            tool,
            version: 1,
            availability: 'unsupported',
            reason: '이 운영체제의 볼륨 제어는 아직 지원하지 않습니다.'
          }
    )
  ]
}
