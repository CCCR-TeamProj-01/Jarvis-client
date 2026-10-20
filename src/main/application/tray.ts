import { Menu, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { UiCommand } from '../../shared/contracts/interaction'
import { createTrayIcon } from './tray-icon'

/**
 * On macOS a menu-bar icon opens its menu when clicked and the window is opened from the menu's
 * "자비스 열기"; on Windows a click on the notification-area icon opens the window directly.
 */
export const trayClickOpensWindow = (platform: NodeJS.Platform): boolean => platform !== 'darwin'

export interface TrayActions {
  showWindow(): void
  /** The call, as from the menu: a conversation with the voice side, without opening the window. */
  startConversation(): void
  dispatch(command: UiCommand): void
  quit(): void
}

/** The menu, with nothing in it that depends on being signed in; the commands decide that. */
export function trayMenu(actions: TrayActions): MenuItemConstructorOptions[] {
  const command = (label: string, command: UiCommand): MenuItemConstructorOptions => ({
    label,
    click: () => actions.dispatch(command)
  })
  return [
    { label: '자비스 열기', click: () => actions.showWindow() },
    { label: '대화 시작', click: () => actions.startConversation() },
    command('설정', { type: 'settings.open' }),
    { type: 'separator' },
    command('인식 일시 중지', { type: 'recognition.pause' }),
    command('인식 재개', { type: 'recognition.resume' }),
    command('제스처 시작', { type: 'gesture.start' }),
    command('제스처 중지', { type: 'gesture.stop' }),
    { type: 'separator' },
    { label: '앱 종료', click: () => actions.quit() }
  ]
}

/** The tray icon with its menu, or null when the system cannot show one. */
export function createAppTray(actions: TrayActions, platform: NodeJS.Platform): Tray | null {
  let tray: Tray | null = null
  try {
    tray = new Tray(createTrayIcon())
    tray.setToolTip('자비스')
    tray.setContextMenu(Menu.buildFromTemplate(trayMenu(actions)))
    if (trayClickOpensWindow(platform)) tray.on('click', () => actions.showWindow())
    return tray
  } catch {
    if (tray && !tray.isDestroyed()) tray.destroy()
    return null
  }
}
