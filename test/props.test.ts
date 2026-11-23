import { describe, expect, it, vi } from 'vitest'
import { Glyphway } from '../src/core'
import { install } from '../src/snippet'
import { HOST, make, mockFetch, queued, useEnv } from './helpers'

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

// Reserved properties the web SDK sets on every event.
const ALL = ['$lib', '$lib_version', '$session_id', '$device_id', '$os', '$os_version', '$device_type', '$screen_width', '$screen_height', '$locale', '$timezone']
const WEB = ['$window_id', '$current_url', '$host', '$pathname', '$referrer', '$referring_domain', '$browser', '$browser_version', '$viewport_width', '$viewport_height']

describe('default properties', () => {
  useEnv()

  it('sets exactly the default properties', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(CHROME_MAC)
    Object.defineProperty(document, 'referrer', { configurable: true, get: () => 'https://www.google.com/search?q=x' })
    history.replaceState(null, '', '/docs/start?ref=1')
    const a = make()
    a.capture('x')
    const p = queued(a)[0]!.properties
    expect(Object.keys(p).sort()).toEqual([...ALL, ...WEB].sort())
    expect(p).toMatchObject({
      $lib: 'web',
      $lib_version: '1.0.0',
      $os: 'Mac OS X',
      $os_version: '10.15.7',
      $device_type: 'Desktop',
      $browser: 'Chrome',
      $browser_version: 130,
      $current_url: 'http://localhost:3000/docs/start?ref=1',
      $host: 'localhost:3000',
      $pathname: '/docs/start',
      $referrer: 'https://www.google.com/search?q=x',
      $referring_domain: 'www.google.com',
      $screen_width: screen.width,
      $screen_height: screen.height,
      $viewport_width: innerWidth,
      $viewport_height: innerHeight,
      $locale: navigator.language,
      $timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    expect(p.$device_id).toBe(a.getDistinctId())
  })

  it('uses $direct when there is no referrer (posthog-js)', () => {
    const a = make()
    a.capture('x')
    expect(queued(a)[0]!.properties).toMatchObject({ $referrer: '$direct', $referring_domain: '$direct' })
  })

  it('adds UTMs and click ids on events of the landing page only', () => {
    history.replaceState(null, '', '/land?utm_source=news&utm_medium=email&utm_campaign=fall&utm_term=t&utm_content=c&gclid=G&fbclid=F&msclkid=M&ttclid=T&other=1')
    const a = make({ capturePageview: true })
    a.capture('on-landing')
    history.pushState(null, '', '/next')
    a.capture('after')
    const want = { utm_source: 'news', utm_medium: 'email', utm_campaign: 'fall', utm_term: 't', utm_content: 'c', gclid: 'G', fbclid: 'F', msclkid: 'M', ttclid: 'T' }
    const [pv, landing, leave, pv2, after] = queued(a)
    for (const e of [pv, landing, leave]) expect(e!.properties).toMatchObject(want)
    expect(landing!.properties.other).toBeUndefined()
    for (const e of [pv2, after]) expect(Object.keys(e!.properties).some((k) => k in want)).toBe(false)
  })

  it('debug: adds $debug: true and logs', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const a = make({ debug: true })
    a.capture('x')
    expect(queued(a)[0]!.properties.$debug).toBe(true)
    expect(log).toHaveBeenCalled()
    a.teardown_()
    const b = make()
    b.capture('y')
    expect(queued(b).at(-1)!.properties.$debug).toBeUndefined()
  })
})

describe('beforeSend', () => {
  useEnv()

  it('can modify or drop events; invalid results are dropped with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = make({
      beforeSend: (e) => {
        if (e.event === 'drop') return null
        if (e.event === 'break') return { ...e, distinct_id: '' }
        if (e.event === 'throw') throw new Error('boom')
        e.properties.$current_url = 'redacted'
        return e
      },
    })
    a.capture('keep')
    a.capture('drop')
    a.capture('break')
    a.capture('throw')
    expect(queued(a).map((e) => e.event)).toEqual(['keep'])
    expect(queued(a)[0]!.properties.$current_url).toBe('redacted')
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('init / snippet', () => {
  useEnv()

  it('ignores calls before init and a second init, with warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = new Glyphway()
    a.capture('early')
    expect(a.getDistinctId()).toBe('')
    a.init('', { host: HOST })
    expect(a.on_).toBe(false)
    a.init('wk_x', { host: HOST, capturePageview: false, autocapture: false })
    a.init('wk_y', { host: HOST })
    expect(a.key_).toBe('wk_x')
    expect(warn).toHaveBeenCalledTimes(3)
    a.teardown_()
  })

  it('replays calls queued by the <script> snippet stub', async () => {
    const f = mockFetch()
    ;(window as unknown as { glyphway?: unknown }).glyphway = {
      _q: [
        ['init', ['wk_snip', { host: HOST, capturePageview: false, autocapture: false }]],
        ['register', [{ plan: 'pro' }]],
        ['capture', ['early', { n: 1 }]],
        ['nope', []],
      ],
    }
    const a = new Glyphway()
    install(a)
    expect((window as unknown as { glyphway?: unknown }).glyphway).toBe(a)
    await a.flush()
    expect(f.events()[0]!).toMatchObject({ event: 'early', properties: { n: 1, plan: 'pro' } })
    a.teardown_()
  })
})

describe('device state written before the rename', () => {
  useEnv()

  // Guards device data: storage keys keep the `an_` prefix, so an app update keeps the same ids.
  it('reads the state stored under an_<key> with the same distinct and device id', async () => {
    localStorage.setItem('an_wk_old', JSON.stringify({ d: 'user-77', v: 'device-aaa', i: 1, p: { plan: 'pro' }, g: {} }))
    const f = mockFetch()
    const a = new Glyphway()
    a.init('wk_old', { host: HOST, capturePageview: false, autocapture: false, compression: 'none', projectSettings: false })
    expect(a.getDistinctId()).toBe('user-77')
    a.capture('after_update')
    await a.flush()
    expect(f.events()[0]!).toMatchObject({ event: 'after_update', properties: { $device_id: 'device-aaa', plan: 'pro' } })
    a.teardown_()
  })
})

describe('release', () => {
  it('goes out as $app_version', async () => {
    const m = mockFetch()
    const a = make({ release: '2.0.1' })
    a.capture('x')
    await a.flush()
    expect(m.events().find((e) => e.event === 'x')?.properties.$app_version).toBe('2.0.1')
  })
})
