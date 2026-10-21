import { app } from 'electron'
import { LocalState } from './local-state'
import { NodeLocalFiles } from './node-local-files'

/** Called after Electron readiness. Settings files never share the credential-store format. */
export function createLocalState(): LocalState {
  return new LocalState(new NodeLocalFiles(app.getPath('userData')))
}
