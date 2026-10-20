import { contextBridge, ipcRenderer } from 'electron'
import { createUiBridge } from './ui-bridge'

contextBridge.exposeInMainWorld('jarvis', createUiBridge(ipcRenderer, process.platform))
