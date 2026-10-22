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

/**
 * Windows AppUserModelIDs, as `Get-StartApps` reports them. Those marked "checked" were read from
 * a Windows 11 PC that has the app installed; the others are the vendors' published identifiers
 * (installers can register another ID, for example per-user and Store builds of the same app) and
 * have not been checked on a device. A wrong ID can only cause "not installed", never a different
 * app being opened, because the app control resolves it against the apps the Start menu lists.
 */
const WINDOWS_APPS: Readonly<Record<AppCode, { id: string; name: string }>> = {
  chrome: { id: 'Chrome', name: 'Google Chrome' }, // checked
  edge: { id: 'MSEdge', name: 'Microsoft Edge' }, // checked
  whale: { id: 'Whale', name: 'Whale' },
  vscode: { id: 'Microsoft.VisualStudioCode', name: 'Visual Studio Code' }, // checked
  notion: { id: 'com.electron.notion', name: 'Notion' }, // checked
  slack: { id: 'com.squirrel.slack.slack', name: 'Slack' },
  teams: { id: 'MSTeams_8wekyb3d8bbwe!MSTeams', name: 'Microsoft Teams' }, // checked: new Teams
  outlook: {
    id: 'Microsoft.OutlookForWindows_8wekyb3d8bbwe!Microsoft.OutlookforWindows',
    name: 'Microsoft Outlook'
  }, // checked: new Outlook
  spotify: { id: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', name: 'Spotify' }, // Store build
  kakaotalk: {
    id: '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\Kakao\\KakaoTalk\\KakaoTalk.exe',
    name: '카카오톡'
  }, // checked: the folder GUID is Program Files (x86)
  terminal: { id: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App', name: 'Windows Terminal' }, // checked
  explorer: { id: 'Microsoft.Windows.Explorer', name: 'File Explorer' }, // checked: the file manager
  notepad: { id: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', name: 'Notepad' }, // checked
  calculator: { id: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', name: 'Calculator' } // checked
}

function appsFor(platform: NodeJS.Platform) {
  if (platform === 'darwin') return MACOS_APPS
  if (platform === 'win32') return WINDOWS_APPS
  return undefined
}

/** The OS application ID for a code on a platform; undefined when it is not supported there. */
export function osAppIdFor(code: AppCode, platform: NodeJS.Platform): string | undefined {
  return appsFor(platform)?.[code].id
}

/** The name the app goes by on that platform, for telling the server which app was meant. */
export function appDisplayNameFor(code: AppCode, platform: NodeJS.Platform): string | undefined {
  return appsFor(platform)?.[code].name
}

/** The server code for an OS application ID, when it is one of the fixed set. */
export function appCodeFor(osAppId: string, platform: NodeJS.Platform): AppCode | undefined {
  return APP_CODES.find((code) => osAppIdFor(code, platform) === osAppId)
}
