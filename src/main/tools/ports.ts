import type { Result } from '../../shared/contracts/common'
import type {
  CancelExecutionResult,
  Capability,
  ToolExecutionReport,
  ToolInvocation
} from '../../shared/contracts/tools'
import type { LocalExecutionOptions } from '../ports'

export interface CapabilityRegistryPort {
  getSnapshot(): { revision: number; capabilities: Capability[] }
}

export interface ToolExecutorPort {
  /** Validate and recheck immediately before running; deduplicate by executionId. */
  execute(invocation: ToolInvocation, options?: LocalExecutionOptions): Promise<ToolExecutionReport>
  /** A requested cancellation is not evidence that an OS effect was undone. */
  cancel(executionId: string): Promise<Result<CancelExecutionResult>>
}
