import type { FolderAlias } from '../../../shared/contracts/tools'
import type { AssistantTools } from '../../conversation/ports'

const SITES: { pattern: RegExp; url: string; name: string }[] = [
  { pattern: /유튜브|youtube/i, url: 'https://www.youtube.com', name: '유튜브' },
  { pattern: /구글|google/i, url: 'https://www.google.com', name: '구글' },
  { pattern: /네이버|naver/i, url: 'https://www.naver.com', name: '네이버' }
]

/** Spoken names for common apps, since their installed names are English. */
const ALIASES: Record<string, string> = {
  사파리: 'safari',
  크롬: 'chrome',
  메모: 'notes',
  캘린더: 'calendar',
  달력: 'calendar',
  메시지: 'messages',
  메일: 'mail',
  음악: 'music',
  터미널: 'terminal',
  파인더: 'finder',
  계산기: 'calculator'
}

/** Spoken names for the standard folders the folder tool can open. */
const FOLDERS: { pattern: RegExp; alias: FolderAlias; name: string }[] = [
  { pattern: /다운로드|download/i, alias: 'downloads', name: '다운로드' },
  { pattern: /바탕\s*화면|desktop/i, alias: 'desktop', name: '바탕 화면' },
  { pattern: /문서|documents/i, alias: 'documents', name: '문서' },
  { pattern: /사진|pictures/i, alias: 'pictures', name: '사진' },
  { pattern: /동영상|비디오|videos/i, alias: 'videos', name: '동영상' },
  { pattern: /음악\s*폴더|music/i, alias: 'music', name: '음악' },
  { pattern: /홈\s*폴더|home/i, alias: 'home', name: '홈' }
]

const OPEN_WORDS = /열어|실행|켜|띄워|보여|가줘|가 줘/
const LAUNCH = /^(.+?)\s*(?:앱\s*)?(?:열어|실행|켜|띄워)/

const normalise = (value: string) => value.toLowerCase().replace(/\s+/g, '')

/**
 * Reads a few plain requests and carries them out with the tools, the way a real assistant would
 * after understanding them. It exists so the whole path (words → tool calls → reports → answer)
 * can be tried without a server. Anything it does not recognise returns null.
 */
export async function runDevIntent(text: string, tools: AssistantTools): Promise<string | null> {
  let counter = 0
  const nextId = (label: string) => `dev-${label}-${++counter}`

  if (/앱\s*목록|어떤\s*앱|설치된\s*앱/.test(text)) {
    const report = await tools.execute({
      executionId: nextId('list'),
      command: { tool: 'apps.list', arguments: {} }
    })
    if (report.outcome.status !== 'observed' || report.outcome.observation.kind !== 'app_list')
      return '앱 목록을 확인하지 못했어요.'
    const names = report.outcome.observation.apps.map((app) => app.displayName)
    return names.length === 0
      ? '확인된 앱이 없어요.'
      : `앱 ${names.length}개를 찾았어요: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' 등' : ''}`
  }

  if (/돌아가|이전\s*(작업|앱)|복귀/.test(text)) {
    const report = await tools.execute({
      executionId: nextId('restore'),
      command: { tool: 'apps.restore', arguments: {} }
    })
    return report.outcome.status === 'observed'
      ? '이전 작업으로 돌아가도록 요청했어요.'
      : '이전 작업으로 돌아가지 못했어요.'
  }

  // Only an explicit "folder" request: "음악 열어줘" still means the Music app.
  const folder = /폴더|folder/i.test(text)
    ? FOLDERS.find((candidate) => candidate.pattern.test(text))
    : undefined
  if (folder && OPEN_WORDS.test(text)) {
    const report = await tools.execute({
      executionId: nextId('folder'),
      command: { tool: 'folder.open', arguments: { alias: folder.alias } }
    })
    return report.outcome.status === 'observed'
      ? `${folder.name} 폴더를 열도록 요청했어요.`
      : `${folder.name} 폴더를 열지 못했어요.`
  }

  const link = /https?:\/\/\S+/.exec(text)?.[0]
  const site = SITES.find((candidate) => candidate.pattern.test(text))
  if ((link || site) && OPEN_WORDS.test(text)) {
    const report = await tools.execute({
      executionId: nextId('url'),
      command: { tool: 'browser.open', arguments: { url: link ?? site!.url } }
    })
    const label = site && !link ? site.name : '주소'
    return report.outcome.status === 'observed'
      ? `${label}을(를) 브라우저로 열었어요.`
      : `${label}을(를) 열지 못했어요.`
  }

  const wanted = LAUNCH.exec(text)?.[1]?.trim()
  if (wanted) {
    const key = normalise(ALIASES[wanted] ?? wanted)
    const listing = await tools.execute({
      executionId: nextId('list'),
      command: { tool: 'apps.list', arguments: {} }
    })
    if (listing.outcome.status !== 'observed' || listing.outcome.observation.kind !== 'app_list')
      return `${wanted} 앱을 열지 못했어요.`
    const match = listing.outcome.observation.apps
      .filter((app) => normalise(app.displayName).includes(key))
      .sort((a, b) => a.displayName.length - b.displayName.length)[0]
    if (!match) return `${wanted} 앱을 찾지 못했어요.`
    const launched = await tools.execute({
      executionId: nextId('launch'),
      command: { tool: 'apps.launch', arguments: { appId: match.appId } }
    })
    return launched.outcome.status === 'observed'
      ? `${match.displayName}을(를) 열었어요.`
      : `${match.displayName}을(를) 열지 못했어요.`
  }
  return null
}
