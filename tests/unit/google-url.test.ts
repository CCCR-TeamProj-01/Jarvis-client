import { describe, expect, it } from 'vitest'
import { isGoogleConsentUrl } from '../../src/main/google-connection/google-url'

describe('the consent address', () => {
  it('is Google’s account page over https, as the server sends it', () => {
    expect(
      isGoogleConsentUrl(
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcb&state=abc'
      )
    ).toBe(true)
    expect(isGoogleConsentUrl('https://accounts.google.com/o/oauth2/v2/auth')).toBe(true)
  })

  it('is refused for any other host, however close it looks', () => {
    for (const url of [
      'https://accounts.google.com.evil.example/auth',
      'https://evil.example/https://accounts.google.com/',
      'https://accounts.google.com@evil.example/auth',
      'https://evil.example/?next=accounts.google.com',
      'https://google.com/auth',
      'https://www.accounts.google.com/auth',
      'https://accounts.google.co/auth',
      'https://accounts-google.com/auth',
      'https://xn--accounts.google.com/'
    ])
      expect(isGoogleConsentUrl(url)).toBe(false)
  })

  it('is refused unless it is plain https', () => {
    for (const url of [
      'http://accounts.google.com/o/oauth2/v2/auth',
      'ftp://accounts.google.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'x-apple.systempreferences:',
      '//accounts.google.com/auth',
      'accounts.google.com/auth'
    ])
      expect(isGoogleConsentUrl(url)).toBe(false)
  })

  it('is refused with a port or credentials', () => {
    for (const url of [
      'https://accounts.google.com:8443/auth',
      'https://user@accounts.google.com/auth',
      'https://user:pass@accounts.google.com/auth'
    ])
      expect(isGoogleConsentUrl(url)).toBe(false)
  })

  it('is refused when it is not a text address at all, or too long', () => {
    for (const value of [
      null,
      undefined,
      42,
      {},
      [],
      '',
      ' ',
      'not a url',
      ' https://accounts.google.com/'
    ])
      expect(isGoogleConsentUrl(value)).toBe(false)
    expect(isGoogleConsentUrl(`https://accounts.google.com/auth?${'a'.repeat(4100)}`)).toBe(false)
  })
})
