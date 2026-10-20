import type { Session, WebContents } from 'electron'
import type { PermissionState, SensorKind } from '../../shared/contracts/sensors'
import type { MediaPermissionPort } from './hardware'

type OsAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

interface SystemMediaAccess {
  getMediaAccessStatus(mediaType: 'camera' | 'microphone' | 'screen'): OsAccessStatus
  askForMediaAccess?(mediaType: 'camera' | 'microphone'): Promise<boolean>
}

function mapStatus(status: OsAccessStatus): PermissionState {
  switch (status) {
    case 'granted':
      return 'granted'
    case 'denied':
      return 'denied'
    case 'restricted':
      return 'restricted'
    case 'not-determined':
      return 'not_determined'
    // Windows cannot always tell; Chromium then decides and a refusal surfaces from getUserMedia.
    default:
      return 'granted'
  }
}

/** macOS and Windows report OS-level state. Other platforms defer to the Chromium prompt. */
export function createSystemMediaPermissions(
  system: SystemMediaAccess,
  platform: NodeJS.Platform
): MediaPermissionPort {
  const hasOsGate = platform === 'darwin' || platform === 'win32'
  const status = (kind: SensorKind): PermissionState =>
    hasOsGate ? mapStatus(system.getMediaAccessStatus(kind)) : 'granted'
  return {
    status,
    async request(kind) {
      if (!hasOsGate || status(kind) !== 'not_determined') return status(kind)
      // Only macOS can ask; Windows reports a definite state or `unknown`.
      if (platform !== 'darwin' || !system.askForMediaAccess) return status(kind)
      return (await system.askForMediaAccess(kind)) ? 'granted' : 'denied'
    }
  }
}

/** Development stand-in used with Chromium's fake devices; never reaches the OS. */
export const fakeMediaPermissions: MediaPermissionPort = {
  status: () => 'granted',
  request: async () => 'granted'
}

interface PermissionPolicyOptions {
  session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>
  getMediaContents(): WebContents | null
  entryUrl: string
  /** True only while a sensor of this kind is being opened or is open for an active lease. */
  isKindPermitted(kind: SensorKind): boolean
}

const KIND_OF_MEDIA_TYPE: Record<string, SensorKind> = { video: 'camera', audio: 'microphone' }

/**
 * Deny by default. Only the media window may use camera/microphone, only for sensors Main is
 * currently opening, and no other permission is ever granted (the UI window gets none).
 */
export function installMediaPermissionPolicy({
  session,
  getMediaContents,
  entryUrl,
  isKindPermitted
}: PermissionPolicyOptions): void {
  const fromMediaWindow = (contents: WebContents | null, url: string | undefined): boolean => {
    const media = getMediaContents()
    return media !== null && contents === media && !media.isDestroyed() && url === entryUrl
  }
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') return callback(false)
    const requested = (
      (details as { mediaTypes?: string[] }).mediaTypes ?? ['video', 'audio']
    ).flatMap((type) => (KIND_OF_MEDIA_TYPE[type] ? [KIND_OF_MEDIA_TYPE[type]] : []))
    callback(
      fromMediaWindow(contents, details.requestingUrl) &&
        requested.length > 0 &&
        requested.every(isKindPermitted)
    )
  })
  // Device enumeration (labels) asks this synchronously; it never opens a device by itself.
  session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    return permission === 'media' && fromMediaWindow(contents, details.requestingUrl)
  })
}
