/** UUIDv7 (RFC 9562): 48-bit unix ms timestamp, version 7, variant 10, 74 random bits. */
export function uuidv7(): string {
  const b = new Uint8Array(16)
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  if (c && c.getRandomValues) c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0
  let ms = Date.now()
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256
    ms = Math.floor(ms / 256)
  }
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  let h = ''
  for (let i = 0; i < 16; i++) {
    h += (b[i]! + 256).toString(16).slice(1)
    if (i === 3 || i === 5 || i === 7 || i === 9) h += '-'
  }
  return h
}

let enc: TextEncoder | undefined
/** UTF-8 byte length of a string. */
export const utf8 = (s: string): number => (enc || (enc = new TextEncoder())).encode(s).length

/** UTF-8 byte length of a value's JSON form. Throws on cycles / BigInt. */
export const jsonSize = (v: unknown): number => utf8(JSON.stringify(v))

const P = '[glyphway]'
export const warn = (...a: unknown[]): void => console.warn(P, ...a)
