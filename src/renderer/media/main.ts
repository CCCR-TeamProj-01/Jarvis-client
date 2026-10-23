import { ElementAudioPlayback } from './audio-playback/element-playback'
import { WebAudioCapture } from './audio-capture/web-audio-capture'
import { HandTrackingPipeline } from './hand-tracking/hand-tracking-pipeline'
import { createCanvasPreviewEncoder } from './hand-tracking/preview-encoder'
import { WorkerHandTracker } from './hand-tracking/tracker-client'
import { VideoFrameSource } from './hand-tracking/video-frame-source'
import type { VideoLike } from './hand-tracking/video-frame-source'
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
    }),
    new HandTrackingPipeline({
      source: new VideoFrameSource({
        createVideo: () => document.createElement('video') as unknown as VideoLike,
        createBitmap: (video) => createImageBitmap(video as unknown as HTMLVideoElement),
        now: () => performance.now(),
        every: (callback, intervalMs) => {
          const timer = setInterval(callback, intervalMs)
          return () => clearInterval(timer)
        }
      }),
      createTracker: (model) =>
        new WorkerHandTracker(
          new Worker(new URL('./hand-tracking/hand-landmarker.worker.ts', import.meta.url), {
            type: 'module'
          }),
          model
        ),
      publish: (event) => window.jarvisMedia.publish(event),
      preview: createCanvasPreviewEncoder()
    })
  )
  window.addEventListener('pagehide', () => controller.dispose())
}
