import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('jarvisMedia', {
  platform: process.platform
})
