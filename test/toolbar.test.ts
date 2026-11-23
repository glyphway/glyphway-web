import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Glyphway } from '../src/core'
import { actionSelector, actionTargets, selectorFor, stepFor } from '../src/toolbar'
import { HOST, make, mockFetch, useEnv } from './helpers'

vi.mock('web-vitals', () => ({ onLCP: () => {}, onINP: () => {}, onCLS: () => {}, onFCP: () => {}, onTTFB: () => {} }))
const { toolbar } = await import('../src/toolbar')

describe('opening with #an_toolbar', () => {
  useEnv()

  it('reads and strips the hash before anything is sent, keeps other hash parts, and loads the script', async () => {
    history.replaceState(null, '', '/pricing?x=1#an_toolbar=at_3_abc&an_api=https%3A%2F%2Fbox.test&keep=1')
    const { events } = mockFetch()
    const a = make({ capturePageview: true, toolbarUrl: 'https://cdn.test/glyphway.toolbar.js' })
    expect(location.hash).toBe('#keep=1')
    expect(location.pathname + location.search).toBe('/pricing?x=1')
    const s = document.head.querySelector('script[src="https://cdn.test/glyphway.toolbar.js"]')
    expect(s).not.toBeNull()
    await a.flush()
    const sent = JSON.stringify(events())
    expect(sent).not.toContain('an_toolbar')
    expect(sent).not.toContain('at_3_abc')
    expect(sent).not.toContain('box.test')
    s!.remove()
  })

  it('does nothing when the hash is not there', () => {
    history.replaceState(null, '', '/#section')
    mockFetch()
    make()
    expect(document.head.querySelector('script[src$="glyphway.toolbar.js"]')).toBeNull()
    expect(location.hash).toBe('#section')
  })

  it('hands the toolbar what the page queues, newest last, at most 100', () => {
    history.replaceState(null, '', '/#an_toolbar=at_3_abc&an_api=https%3A%2F%2Fbox.test')
    mockFetch()
    let got: { token: string; api: string; events: { event: string }[] } | undefined
    ;(window as unknown as { glyphwayToolbar: unknown }).glyphwayToolbar = { toolbar: (_a: Glyphway, o: typeof got) => (got = o) }
    const a = make({ toolbarUrl: 'https://cdn.test/t.js' })
    document.head.querySelector('script')!.dispatchEvent(new Event('load'))
    for (let i = 0; i < 105; i++) a.capture('e' + i)
    expect(got!.token).toBe('at_3_abc')
    expect(got!.api).toBe('https://box.test')
    expect(got!.events).toHaveLength(100)
    expect(got!.events[99]!.event).toBe('e104')
    document.head.querySelector('script')!.remove()
    delete (window as unknown as { glyphwayToolbar?: unknown }).glyphwayToolbar
  })
})

describe('selectorFor', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('uses a unique id', () => {
    document.body.innerHTML = '<main><button id="buy" class="b">Buy</button></main>'
    expect(selectorFor(document.getElementById('buy')!)).toBe('#buy')
  })

  it('finds exactly the element otherwise, among look-alikes', () => {
    document.body.innerHTML = '<ul class="l"><li>a</li><li>b</li><li>c</li></ul><ul class="m"><li>d</li></ul>'
    for (const li of Array.from(document.querySelectorAll('li'))) {
      const sel = selectorFor(li)
      expect(document.querySelectorAll(sel), sel).toHaveLength(1)
      expect(document.querySelector(sel)).toBe(li)
    }
  })

  it('does not trust a repeated id', () => {
    document.body.innerHTML = '<p id="x">a</p><p id="x">b</p>'
    const second = document.querySelectorAll('p')[1]!
    expect(document.querySelector(selectorFor(second))).toBe(second)
  })
})

describe('the toolbar', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  const asked: { url: string; init: RequestInit }[] = []
  const box = (): void => {
    asked.length = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      asked.push({ url, init })
      if (url.endsWith('/actions')) return new Response(JSON.stringify([{ id: 1, name: 'Buy', steps: [{ event: '$autocapture', selector: 'button.buy', url_matching: 'contains' }] }]))
      if (url.endsWith('/flags')) return new Response(JSON.stringify([{ key: 'exp', active: true, filters: { multivariate: { variants: [{ key: 'control' }, { key: 'test' }] } } }]))
      return new Response(JSON.stringify({ bin: 8, bins: [[1, 1, 3]], fixed_bins: [], total: 3 }))
    }))
  }
  const a = { flagsModule: undefined } as unknown as Glyphway

  it('asks the box with the token as a bearer, for this page, and keeps the token out of the page', async () => {
    box()
    history.replaceState(null, '', '/pricing')
    const stop = toolbar(a, { token: 'at_3_abc', api: 'https://box.test/ignored', events: [] })
    await new Promise((r) => setTimeout(r, 0))
    const q = asked[0]!
    expect(q.url).toBe('https://box.test/api/projects/3/heatmaps/query')
    expect((q.init.headers as Record<string, string>).Authorization).toBe('Bearer at_3_abc')
    const body = JSON.parse(String(q.init.body))
    expect(body).toMatchObject({ url: location.origin + '/pricing', type: 'click', mode: 'total', fixed: 'keep', tolerance: 0.1 })
    const host = document.querySelector('[data-glyphway-toolbar]')!
    expect(host.shadowRoot).not.toBeNull()
    expect(document.body.innerHTML).not.toContain('at_3_abc')
    expect(host.shadowRoot!.textContent).toContain('3 points')
    stop()
    expect(document.querySelector('[data-glyphway-toolbar]')).toBeNull()
  })

  it('refuses a token that is not a toolbar token and an address that is not http(s)', () => {
    box()
    for (const o of [{ token: 'ak_3_abc', api: 'https://box.test' }, { token: 'at_x_abc', api: 'https://box.test' }, { token: 'at_3_abc', api: 'javascript:alert(1)' }, { token: 'at_3_abc', api: '' }]) {
      toolbar(a, { ...o, events: [] })
    }
    expect(document.querySelector('[data-glyphway-toolbar]')).toBeNull()
    expect(asked).toHaveLength(0)
  })

  it('shows a token that ran out as a sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    toolbar(a, { token: 'at_3_abc', api: 'https://box.test', events: [] })
    await new Promise((r) => setTimeout(r, 0))
    expect(document.querySelector('[data-glyphway-toolbar]')!.shadowRoot!.textContent).toContain('token ran out')
  })

  it('keeps flag overrides in this browser and applies them through the flags module', async () => {
    box()
    const overrideFeatureFlags = vi.fn()
    const withFlags = { flagsModule: { overrideFeatureFlags } } as unknown as Glyphway
    toolbar(withFlags, { token: 'at_3_abc', api: 'https://box.test', events: [] })
    await new Promise((r) => setTimeout(r, 0))
    const root = document.querySelector('[data-glyphway-toolbar]')!.shadowRoot!
    ;(root.querySelectorAll('.tabs button')[2] as HTMLButtonElement).click()
    await new Promise((r) => setTimeout(r, 0))
    const sel = root.querySelector('select[aria-label="Override exp"]') as HTMLSelectElement
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['', 'control', 'test'])
    sel.value = 'test'
    sel.dispatchEvent(new Event('change'))
    expect(overrideFeatureFlags).toHaveBeenLastCalledWith({ exp: 'test' })
    expect(localStorage.getItem('an_toolbar_flags')).toBe('{"exp":"test"}')
    sel.value = ''
    sel.dispatchEvent(new Event('change'))
    expect(overrideFeatureFlags).toHaveBeenLastCalledWith(false)
    expect(asked.every((r) => r.url.startsWith('https://box.test/api/projects/3/'))).toBe(true)
  })

  it('lists what the page queued, newest first', () => {
    box()
    const events = [{ event: 'a', timestamp: '2026-11-04T10:00:00.000Z', properties: { x: 1 } }, { event: 'b', timestamp: '2026-11-04T10:00:01.000Z', properties: {} }]
    toolbar(a, { token: 'at_3_abc', api: 'https://box.test', events: events as never })
    const root = document.querySelector('[data-glyphway-toolbar]')!.shadowRoot!
    ;(root.querySelectorAll('.tabs button')[3] as HTMLButtonElement).click()
    const names = Array.from(root.querySelectorAll('summary')).map((s) => s.textContent)
    expect(names).toEqual(['b · 10:00:01.000', 'a · 10:00:00.000'])
    expect(HOST).toBeTruthy()
  })

  it('inspects an element, says which action holds it, and sends a step to the app that opened the page', async () => {
    box()
    document.body.innerHTML = '<main><button class="buy">Buy now</button><a href="/x">Other</a></main>'
    const post = vi.fn()
    Object.defineProperty(window, 'opener', { configurable: true, value: { postMessage: post } })
    toolbar(a, { token: 'at_3_abc', api: 'https://box.test', events: [] })
    await new Promise((r) => setTimeout(r, 0))
    const root = document.querySelector('[data-glyphway-toolbar]')!.shadowRoot!
    ;(root.querySelectorAll('.tabs button')[1] as HTMLButtonElement).click()
    await new Promise((r) => setTimeout(r, 0))
    expect(asked.some((r) => r.url === 'https://box.test/api/projects/3/actions')).toBe(true)
    const [inspect, showAll] = Array.from(root.querySelectorAll('.row button')) as HTMLButtonElement[]
    showAll!.click()
    expect(root.querySelectorAll('.hl.on')).toHaveLength(1)
    inspect!.click()
    document.querySelector('button.buy')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }))
    expect(root.textContent).toContain('Already in: Buy')
    expect(root.textContent).toContain('Text: Buy now')
    const make = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Create action from this element')!
    make.click()
    expect(post).toHaveBeenCalledWith({ type: 'an_action', step: { event: '$autocapture', url: location.pathname, url_matching: 'contains', text: 'Buy now', selector: 'body > main > button.buy', properties: [] } }, 'https://box.test')
    Object.defineProperty(window, 'opener', { configurable: true, value: null })
  })
})

describe('action steps from elements', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('builds a selector from tags, ids and classes only, and stops at a unique id', () => {
    document.body.innerHTML = '<div id="nav"><ul class="menu big"><li><a class="x1234 link">Go</a></li></ul></div>'
    const a = document.querySelector('a')!
    expect(actionSelector(a)).toBe('#nav > ul.menu.big > li > a.link')
    document.body.innerHTML = '<div><div><div><div><div><span class="s">x</span></div></div></div></div></div>'
    expect(actionSelector(document.querySelector('span')!)).toBe('div > div > div > span.s')
  })

  it('keeps text only for an element without children, and matches by selector, text and page', () => {
    document.body.innerHTML = '<section><button class="b">Pay</button><div class="b">A <b>B</b></div><a>Pay</a></section>'
    expect(stepFor(document.querySelector('button')!, { pathname: '/shop' }).text).toBe('Pay')
    expect(stepFor(document.querySelector('div')!, { pathname: '/shop' }).text).toBeNull()
    const rows = [
      { id: 1, name: 'one', steps: [{ selector: 'button.b' }] },
      { id: 2, name: 'two', steps: [{ text: 'Pay', url: '/other', url_matching: 'contains' }] },
      { id: 3, name: 'three', steps: [{ text: 'Pay' }, { event: '$pageview', selector: 'section' }] },
    ]
    const got = actionTargets(rows, document, 'https://x.test/shop').map(([e, n]) => `${e.tagName}${n}`)
    expect(got).toEqual(['BUTTON1', 'A3', 'BUTTON3'].sort((x, y) => got.indexOf(x) - got.indexOf(y)))
    expect(got.sort()).toEqual(['A3', 'BUTTON1', 'BUTTON3'])
  })
})
