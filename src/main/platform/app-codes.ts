/**
 * The server's fixed application codes and the OS application each stands for. A code with no entry
 * for a platform is not supported there; it is never guessed from a name.
 */
export const APP_CODES = [
  'chrome',
  'edge',
  'whale',
  'vscode',
  'notion',
  'slack',
  'teams',
  'outlook',
  'spotify',
  'kakaotalk',
  'terminal',
  'explorer',
  'notepad',
  'calculator'
] as const
export type AppCode = (typeof APP_CODES)[number]

export function isAppCode(value: string): value is AppCode {
  return (APP_CODES as readonly string[]).includes(value)
}

/**
 * macOS bundle identifiers. Those marked "checked" were read from the installed apps on a real
 * Mac; the others are the vendors' published identifiers and have not been checked on a device.
 * A wrong identifier can only cause "not installed", never a different app being opened, because
 * the app control resolves it against the apps the OS reports.
 */
const MACOS_APPS: Readonly<Record<AppCode, { id: string; name: string }>> = {
  chrome: { id: 'com.google.Chrome', name: 'Google Chrome' }, // checked
  edge: { id: 'com.microsoft.edgemac', name: 'Microsoft Edge' },
  whale: { id: 'com.naver.Whale', name: 'Whale' },
  vscode: { id: 'com.microsoft.VSCode', name: 'Visual Studio Code' }, // checked
  notion: { id: 'notion.id', name: 'Notion' }, // checked
  slack: { id: 'com.tinyspeck.slackmacgap', name: 'Slack' }, // checked
  teams: { id: 'com.microsoft.teams2', name: 'Microsoft Teams' },
  outlook: { id: 'com.microsoft.Outlook', name: 'Microsoft Outlook' },
  spotify: { id: 'com.spotify.client', name: 'Spotify' },
  kakaotalk: { id: 'com.kakao.KakaoTalkMac', name: '카카오톡' }, // checked
  terminal: { id: 'com.apple.Terminal', name: 'Terminal' }, // checked
  explorer: { id: 'com.apple.finder', name: 'Finder' }, // checked: the file manager
  notepad: { id: 'com.apple.TextEdit', name: 'TextEdit' }, // checked: the plain text editor
  calculator: { id: 'com.apple.calculator', name: 'Calculator' } // checked
}

/** The OS application ID for a code on a platform; undefined when it is not supported there. */
export function osAppIdFor(code: AppCode, platform: NodeJS.Platform): string | undefined {
  return platform === 'darwin' ? MACOS_APPS[code].id : undefined
}

/** The name the app goes by on that platform, for telling the server which app was meant. */
export function appDisplayNameFor(code: AppCode, platform: NodeJS.Platform): string | undefined {
  return platform === 'darwin' ? MACOS_APPS[code].name : undefined
}

/** The server code for an OS application ID, when it is one of the fixed set. */
export function appCodeFor(osAppId: string, platform: NodeJS.Platform): AppCode | undefined {
  return APP_CODES.find((code) => osAppIdFor(code, platform) === osAppId)
}
