import { contextBridge, ipcRenderer } from 'electron'
import { createOverlayBridge } from './overlay-bridge'

contextBridge.exposeInMainWorld('jarvisOverlay', createOverlayBridge(ipcRenderer))
