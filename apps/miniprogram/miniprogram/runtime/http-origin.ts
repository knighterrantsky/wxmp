function originError(label: string): TypeError {
  return new TypeError(`${label} must contain only an HTTP(S) origin`)
}

function hasForbiddenAuthorityCharacter(authority: string): boolean {
  for (let index = 0; index < authority.length; index += 1) {
    const character = authority[index]
    const codeUnit = authority.charCodeAt(index)
    if (
      codeUnit <= 0x20 ||
      codeUnit === 0x7f ||
      character === '/' ||
      character === '\\' ||
      character === '?' ||
      character === '#' ||
      character === '@'
    ) {
      return true
    }
  }
  return false
}

function validPort(port: string): boolean {
  if (!/^\d{1,5}$/u.test(port)) return false
  const numericPort = Number(port)
  return numericPort >= 0 && numericPort <= 65_535
}

function hasValidAuthorityShape(authority: string): boolean {
  if (authority.length < 1 || hasForbiddenAuthorityCharacter(authority)) return false

  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']')
    if (closingBracket <= 1) return false
    const address = authority.slice(1, closingBracket)
    if (!/^[0-9a-f:.]+$/iu.test(address)) return false
    const suffix = authority.slice(closingBracket + 1)
    return suffix === '' || (suffix.startsWith(':') && validPort(suffix.slice(1)))
  }

  const colon = authority.lastIndexOf(':')
  if (colon < 0) return authority.length > 0
  const hostname = authority.slice(0, colon)
  return hostname.length > 0 && !hostname.includes(':') && validPort(authority.slice(colon + 1))
}

/**
 * Validates a trusted configuration origin without relying on browser-only URL globals.
 * Deployment config generation already canonicalizes the value before it reaches the app.
 */
export function normalizeHttpOrigin(value: string, label: string): string {
  let scheme: 'http' | 'https'
  let authorityWithOptionalSlash: string
  if (value.startsWith('https://')) {
    scheme = 'https'
    authorityWithOptionalSlash = value.slice('https://'.length)
  } else if (value.startsWith('http://')) {
    scheme = 'http'
    authorityWithOptionalSlash = value.slice('http://'.length)
  } else {
    throw originError(label)
  }

  const authority = authorityWithOptionalSlash.endsWith('/')
    ? authorityWithOptionalSlash.slice(0, -1)
    : authorityWithOptionalSlash
  if (!hasValidAuthorityShape(authority)) throw originError(label)
  return `${scheme}://${authority}`
}
