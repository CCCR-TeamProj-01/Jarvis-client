import { contextBridge, ipcRenderer } from 'electron'
import { createPopupBridge } from './popup-bridge'

contextBridge.exposeInMainWorld('jarvisPopup', createPopupBridge(ipcRenderer))
