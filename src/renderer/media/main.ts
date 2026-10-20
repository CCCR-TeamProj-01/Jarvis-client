import { MediaController } from './media-controller'
import type { MediaDevicesLike, PermissionQuery } from './media-controller'

const queryPermission: PermissionQuery = async (kind) => {
  try {
    const status = await navigator.permissions.query({
      name: (kind === 'camera' ? 'camera' : 'microphone') as PermissionName
    })
    return status.state
  } catch {
    return 'unknown'
  }
}

if (window.jarvisMedia && navigator.mediaDevices) {
  const controller = new MediaController(
    window.jarvisMedia,
    navigator.mediaDevices as unknown as MediaDevicesLike,
    queryPermission
  )
  window.addEventListener('pagehide', () => controller.dispose())
}
