import { describe, expect, it, vi } from 'vitest'
import { parseUA } from '../src/ua'
import { jsonSize, utf8, uuidv7 } from '../src/util'

describe('uuidv7', () => {
  it('is a version-7, variant-10 UUID carrying the unix ms timestamp', () => {
    vi.useFakeTimers({ now: new Date('2026-11-04T10:00:00.123Z') })
    const u = uuidv7()
    vi.useRealTimers()
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const ms = parseInt(u.replace(/-/g, '').slice(0, 12), 16)
    expect(ms).toBe(new Date('2026-11-04T10:00:00.123Z').getTime())
  })

  it('is unique and sorts by time', () => {
    const s = new Set(Array.from({ length: 5000 }, uuidv7))
    expect(s.size).toBe(5000)
    vi.useFakeTimers({ now: 1_000_000 })
    const a = uuidv7()
    vi.setSystemTime(1_000_001)
    const b = uuidv7()
    vi.useRealTimers()
    expect(a < b).toBe(true)
  })
})

describe('sizes', () => {
  it('counts UTF-8 bytes', () => {
    expect(utf8('abc')).toBe(3)
    expect(utf8('é')).toBe(2)
    expect(utf8('😀')).toBe(4)
    expect(jsonSize({ a: 'é' })).toBe(10) // {"a":"é"}: 9 chars, é is 2 bytes
  })
})

describe('parseUA', () => {
  const cases: [string, Record<string, unknown>, number?][] = [
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36',
      { $browser: 'Chrome', $browser_version: 130, $os: 'Windows', $os_version: '10', $device_type: 'Desktop' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68',
      { $browser: 'Microsoft Edge', $browser_version: 130, $os: 'Windows' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      { $browser: 'Safari', $browser_version: 18.1, $os: 'Mac OS X', $os_version: '10.15.7', $device_type: 'Desktop' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      { $browser: 'Safari', $os: 'iOS', $device_type: 'Tablet' },
      5,
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      { $browser: 'Mobile Safari', $browser_version: 18.1, $os: 'iOS', $os_version: '18.1', $device_type: 'Mobile' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
      { $browser: 'Chrome iOS', $browser_version: 130, $os: 'iOS', $os_version: '17.6', $device_type: 'Mobile' },
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
      { $browser: 'Mobile Safari', $os: 'iOS', $device_type: 'Tablet' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.102 Mobile Safari/537.36',
      { $browser: 'Chrome', $os: 'Android', $os_version: '14', $device_type: 'Mobile' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Safari/537.36',
      { $browser: 'Samsung Internet', $browser_version: 26, $os: 'Android', $device_type: 'Tablet' },
    ],
    [
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
      { $browser: 'Firefox', $browser_version: 132, $os: 'Linux', $device_type: 'Desktop' },
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      { $browser: 'Chrome', $os: 'Chrome OS' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
      { $browser: 'Opera', $browser_version: 114 },
    ],
  ]
  it.each(cases)('%s', (ua, want, touch) => {
    expect(parseUA(ua, touch)).toMatchObject(want)
  })
})
