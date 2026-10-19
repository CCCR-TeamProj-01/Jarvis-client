import type { Result, Unsubscribe } from '../../shared/contracts/common'
import type {
  SensorAcquireRequest,
  SensorDevice,
  SensorEvent,
  SensorKind,
  SensorLease,
  SensorReleaseResult,
  SensorSnapshot
} from '../../shared/contracts/sensors'
import type { LocalExecutionOptions } from '../ports'

export interface SensorPort {
  listDevices(kind: SensorKind): Promise<Result<SensorDevice[]>>
  acquire(
    request: SensorAcquireRequest,
    options?: LocalExecutionOptions
  ): Promise<Result<SensorLease>>
  /** Idempotent; close hardware only after its final lease has been returned. */
  release(leaseId: string): Promise<Result<SensorReleaseResult>>
  getSnapshot(kind: SensorKind): SensorSnapshot
  subscribe(listener: (event: SensorEvent) => void): Unsubscribe
}
