/**
 * Whether an address the server sent may be handed to the browser as Google's consent page. The
 * server is trusted to send it, but what opens on the user's machine is checked anyway: only
 * `https` to Google's account host, on its normal port, with no credentials in the address.
 */
export function isGoogleConsentUrl(value: unknown): value is string {
  // Surrounding blanks are dropped by the address parser; what is opened should be exactly what was checked.
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false
  if (value !== value.trim()) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === 'accounts.google.com' &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  )
}
