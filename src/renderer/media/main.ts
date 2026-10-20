import { ElementAudioPlayback } from './audio-playback/element-playback'
import { WebAudioCapture } from './audio-capture/web-audio-capture'
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
    queryPermission,
    new WebAudioCapture((chunk) => window.jarvisMedia.publish({ type: 'audio.pcm', chunk })),
    new ElementAudioPlayback({
      createAudio: () => new Audio(),
      createUrl: (bytes, mimeType) =>
        URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType })),
      revokeUrl: (url) => URL.revokeObjectURL(url)
    })
  )
  window.addEventListener('pagehide', () => controller.dispose())
}
