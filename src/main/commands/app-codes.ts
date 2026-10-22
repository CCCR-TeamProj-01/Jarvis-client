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
const MACOS_APP_IDS: Readonly<Record<AppCode, string>> = {
  chrome: 'com.google.Chrome', // checked
  edge: 'com.microsoft.edgemac',
  whale: 'com.naver.Whale',
  vscode: 'com.microsoft.VSCode', // checked
  notion: 'notion.id', // checked
  slack: 'com.tinyspeck.slackmacgap', // checked
  teams: 'com.microsoft.teams2',
  outlook: 'com.microsoft.Outlook',
  spotify: 'com.spotify.client',
  kakaotalk: 'com.kakao.KakaoTalkMac', // checked
  terminal: 'com.apple.Terminal', // checked
  explorer: 'com.apple.finder', // checked: the file manager
  notepad: 'com.apple.TextEdit', // checked: the plain text editor
  calculator: 'com.apple.calculator' // checked
}

/** The OS application ID for a code on a platform; undefined when it is not supported there. */
export function osAppIdFor(code: AppCode, platform: NodeJS.Platform): string | undefined {
  return platform === 'darwin' ? MACOS_APP_IDS[code] : undefined
}

/** The server code for an OS application ID, when it is one of the fixed set. */
export function appCodeFor(osAppId: string, platform: NodeJS.Platform): AppCode | undefined {
  return APP_CODES.find((code) => osAppIdFor(code, platform) === osAppId)
}
