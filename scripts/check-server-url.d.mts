export function validateReleaseServerUrl(
  raw: unknown
): { ok: true; baseUrl: string } | { ok: false; reason: string }
export function valueTheBuildWillSee(root: string): string | undefined
export function checkBuilt(
  out: string,
  raw: string
): Promise<{ ok: true } | { ok: false; reason: string }>
