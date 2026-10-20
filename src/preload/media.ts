import { contextBridge, ipcRenderer } from 'electron'
import { createMediaBridge } from './media-bridge'

contextBridge.exposeInMainWorld('jarvisMedia', createMediaBridge(ipcRenderer, process.platform))
