import { contextBridge } from 'electron'
import type { BootstrapUiApi } from '../shared/ipc/ui-api'

const api = {
  platform: process.platform
} satisfies BootstrapUiApi

contextBridge.exposeInMainWorld('jarvis', api)
