import { contextBridge } from 'electron'
import type { BootstrapMediaApi } from '../shared/ipc/media-api'

const api = {
  platform: process.platform
} satisfies BootstrapMediaApi

contextBridge.exposeInMainWorld('jarvisMedia', api)
