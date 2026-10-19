import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 880,
    height: 620,
    minWidth: 640,
    minHeight: 440,
    title: 'Jarvis',
    webPreferences: {
      preload: join(__dirname, '../preload/ui.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/ui/index.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/ui/index.html'))
  }
}

void app.whenReady().then(() => {
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
