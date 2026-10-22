import { app } from 'electron'
import { loadDevEnv } from './application/dev-env'
import { startApplication } from './application/application-manager'

// Settings kept in a `.env` file are read before anything looks at the environment (development only).
loadDevEnv({ isPackaged: app.isPackaged, root: app.getAppPath() })
startApplication()
