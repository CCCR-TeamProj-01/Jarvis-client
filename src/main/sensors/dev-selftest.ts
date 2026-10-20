import type { AuthPort } from '../auth/auth-manager'
import type { SensorManager } from './sensor-manager'

const generation = { sessionId: 'selftest', revision: 0 }

/**
 * Development only (unpackaged app with JARVIS_SENSOR_SELFTEST=1): once signed in, take shared
 * diagnostics leases on both sensors and log every sensor event, so the real Electron stack
 * (media window, preload, permissions, getUserMedia) can be exercised without a consumer feature.
 * The leases are left held on purpose, so signing out shows them being revoked.
 */
export function startSensorSelfTest(
  auth: Pick<AuthPort, 'subscribe'>,
  sensors: SensorManager,
  log: (line: string) => void = console.log
): () => void {
  const print = (label: string, value: unknown) =>
    log(`SENSOR_SELFTEST ${label} ${JSON.stringify(value)}`)
  const stopSensors = sensors.subscribe((event) => print('event', event))
  const run = async () => {
    const cameraA = await sensors.acquire({ kind: 'camera', owner: 'diagnostics', generation })
    const cameraB = await sensors.acquire({ kind: 'camera', owner: 'diagnostics', generation })
    const microphone = await sensors.acquire({
      kind: 'microphone',
      owner: 'diagnostics',
      generation
    })
    print('acquired', { cameraA, cameraB, microphone })
    print('snapshots', sensors.getSnapshots())
    if (cameraA.ok) await sensors.release(cameraA.value.leaseId)
    print('after-release-one', sensors.getSnapshot('camera'))
  }
  const stopAuth = auth.subscribe((event) => {
    if (event.type === 'auth.state_changed' && event.snapshot.phase === 'signed_in')
      void run().catch((error: unknown) => print('error', String(error)))
  })
  return () => {
    stopAuth()
    stopSensors()
  }
}
