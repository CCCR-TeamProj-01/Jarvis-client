import { app } from 'electron'
import { join } from 'node:path'

/** Models are fetched into resources/models in development and shipped under resources/ in builds. */
export function modelPath(file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'models', file)
    : join(app.getAppPath(), 'resources', 'models', file)
}
