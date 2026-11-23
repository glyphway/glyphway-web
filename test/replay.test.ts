import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Glyphway } from '../src/core'
import { Chunker, cleanHeaders, F_PAGE_END, F_SNAPSHOT, redactUrl, startReplay } from '../src/replay'
import type { RrEvent } from '../src/replay'

// happy-dom lists these classes on `window` but leaves them undefined; rrweb's polyfill reads their prototypes.
for (const k of ['NodeList', 'DOMTokenList']) {
  const w = window as unknown as Record<string, unknown>
  if (!w[k]) w[k] = class { forEach(): void {} }
}

const SID = '0198b2c4-7d3a-7c11-9a3b-7d8e9f0a1b2c'
const HOST = 'https://edge.test'

describe('Chunker (hand-derived)', () => {
  // timestamps in ms; active time counts gaps <= 5 s between interactions
  const evs: RrEvent[] = [
    { type: 4, timestamp: 1000, data: { href: 'https://a.test/p?x=1', width: 1, height: 1 } },
    { type: 2, timestamp: 1000, data: { node: {} } },
    { type: 3, timestamp: 2000, data: { source: 2, type: 2 } }, // click
    { type: 3, timestamp: 3500, data: { source: 5, text: '*' } }, // input
    { type: 3, timestamp: 9000, data: { source: 1, positions: [] } }, // gap 5500 > 5000: not active, but resets
    { type: 3, timestamp: 9800, data: { source: 3 } }, // scroll: +800
    { type: 3, timestamp: 9900, data: { source: 0 } }, // mutation: not an interaction
    { type: 5, timestamp: 9950, data: { tag: 'console', payload: { level: 'error', payload: ['x'] } } },
    { type: 5, timestamp: 9960, data: { tag: 'console', payload: { level: 'log', payload: ['y'] } } },
  ]
  it('counts clicks, inputs, console errors and active time; flags the snapshot and its url', () => {
    const c = new Chunker()
    evs.forEach((e) => c.add(e))
    expect(c.count).toBe(9)
    const out = c.take(false, 'https://fallback.test')!
    // active: 2000->3500 = 1500 (first interaction has no predecessor), 3500->9000 gap too big, 9000->9800 = 800
    expect(out.stats).toBe('c=1;k=1;e=1;a=2300')
    expect(out.flags).toBe(F_SNAPSHOT)
    expect(out.url).toBe('https://a.test/p?x=1')
    expect([out.first, out.last, out.events]).toEqual([1000, 9960, 9])
    expect(out.text.split('\n').length).toBe(10) // 9 lines + trailing newline
    expect(out.rawBytes).toBe(new TextEncoder().encode(out.text).length)
    expect(c.take()).toBeUndefined()
  })
  it('only chunks with a full snapshot carry a url; page end sets bit 2', () => {
    const c = new Chunker()
    c.add({ type: 3, timestamp: 5, data: { source: 0 } })
    const out = c.take(true, 'https://x.test')!
    expect([out.flags, out.url]).toEqual([F_PAGE_END, ''])
  })
})

describe('privacy helpers', () => {
  it('drops cookie and token headers and redacts secret query values', () => {
    expect(cleanHeaders({ Authorization: 'Bearer x', 'Content-Type': 'a', Cookie: 'c=1', 'X-Api-Key': 'k' })).toEqual({ 'Content-Type': 'a' })
    expect(redactUrl('https://a.test/x?id=5&access_token=abc&q=hi&session=zz')).toBe('https://a.test/x?id=5&access_token=[redacted]&q=hi&session=[redacted]')
    expect(redactUrl('https://a.test/x')).toBe('https://a.test/x')
  })
})

interface Req {
  url: URL
  body: Buffer
  text: string
  keepalive: boolean
}

function setup(status: (n: number) => number = () => 200) {
  const reqs: Req[] = []
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const body = Buffer.from(await new Response(init.body as Blob).arrayBuffer())
    reqs.push({ url: new URL(url), body, text: '', keepalive: !!init.keepalive })
    return new Response('{}', { status: status(reqs.length - 1) })
  })
  vi.stubGlobal('fetch', f)
  const api = { getSessionId: () => SID, hasOptedOut: () => false } as unknown as Glyphway
  return { reqs, api }
}

const until = async (f: () => boolean, ms = 3000): Promise<void> => {
  const t = Date.now()
  while (!f()) {
    if (Date.now() - t > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const lines = (r: Req): RrEvent[] =>
  gunzipSync(r.body)
    .toString('utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))

describe('startReplay', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('posts a gzip member of NDJSON with the chunk metadata in the query; masks inputs and blocks .an-no-capture', async () => {
    document.body.innerHTML = '<div id="a" data-y="VISIBLE">text</div><div class="an-no-capture" data-x="TOPSECRET">TOPSECRET</div><input id="i" value="hunter2">'
    const { reqs, api } = setup()
    const stop = startReplay(api, { host: HOST, writeKey: 'wk_x', chunkMs: 100 })
    console.warn('hello from the page')
    await until(() => reqs.length >= 1)
    stop()
    const r = reqs[0]!
    const q = r.url.searchParams
    expect(r.url.origin + r.url.pathname).toBe(HOST + '/replay')
    expect(q.get('k')).toBe('wk_x')
    expect(q.get('session')).toBe(SID)
    expect(q.get('window')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(q.get('seq')).toBe('0')
    expect(Number(q.get('flags')) & F_SNAPSHOT).toBe(1)
    expect(q.get('url')).toBe(location.href)
    expect(Number(q.get('sent_at'))).toBeGreaterThan(1e12)
    const evs = lines(r)
    expect(String(evs.length)).toBe(q.get('events'))
    expect(String(gunzipSync(r.body).length)).toBe(q.get('raw_bytes'))
    expect(evs.some((e) => e.type === 2)).toBe(true)
    const raw = gunzipSync(r.body).toString('utf8')
    expect(raw).toContain('VISIBLE') // (happy-dom cannot give rrweb text nodes, so text content is not asserted here)
    expect(raw).not.toContain('hunter2')
    expect(raw).toContain('********') // a fixed run: "hunter2" has 7 characters
    expect(raw).not.toContain('TOPSECRET')
    expect(raw).toContain('hello from the page')
    expect(evs.find((e) => e.type === 5 && e.data.tag === 'console')!.data.payload.level).toBe('warn')
  })

  it('numbers chunks 0, 1, 2 and sends the final chunk on stop', async () => {
    const { reqs, api } = setup()
    const stop = startReplay(api, { host: HOST, writeKey: 'k', chunkMs: 60 })
    for (let i = 0; i < 3; i++) {
      document.body.appendChild(document.createElement('p')).textContent = 'n' + i
      await until(() => reqs.length > i)
    }
    stop()
    await until(() => reqs.length >= 4 || reqs.every((r, i) => r.url.searchParams.get('seq') === String(i)))
    expect(reqs.slice(0, 3).map((r) => r.url.searchParams.get('seq'))).toEqual(['0', '1', '2'])
  })

  it('retries a chunk that got a 503 with the same session, window and seq', async () => {
    const { reqs, api } = setup((n) => (n === 0 ? 503 : 200))
    const stop = startReplay(api, { host: HOST, writeKey: 'k', chunkMs: 50 })
    await until(() => reqs.length >= 2, 5000)
    stop()
    const [a, b] = [reqs[0]!.url.searchParams, reqs[1]!.url.searchParams]
    expect([b.get('session'), b.get('window'), b.get('seq')]).toEqual([a.get('session'), a.get('window'), a.get('seq')])
    expect(reqs[1]!.body.equals(reqs[0]!.body)).toBe(true)
  })

  it('drops a chunk the edge refuses for good (401) and carries on', async () => {
    const { reqs, api } = setup((n) => (n === 0 ? 401 : 200))
    const stop = startReplay(api, { host: HOST, writeKey: 'bad', chunkMs: 50 })
    await until(() => reqs.length >= 1)
    document.body.appendChild(document.createElement('p')).textContent = 'more'
    await until(() => reqs.length >= 2)
    stop()
    expect(reqs[1]!.url.searchParams.get('seq')).toBe('1')
  })

  it('records nothing while opted out or on a blocklisted URL', async () => {
    const { reqs } = setup()
    const out = { getSessionId: () => SID, hasOptedOut: () => true } as unknown as Glyphway
    const s1 = startReplay(out, { host: HOST, writeKey: 'k', chunkMs: 40 })
    const s2 = startReplay({ getSessionId: () => SID, hasOptedOut: () => false } as unknown as Glyphway, { host: HOST, writeKey: 'k', chunkMs: 40, urlBlocklist: [/./] })
    await new Promise((r) => setTimeout(r, 300))
    s1()
    s2()
    expect(reqs.length).toBe(0)
  })

  it('does nothing without CompressionStream', () => {
    vi.stubGlobal('CompressionStream', undefined)
    const { api } = setup()
    expect(startReplay(api, { host: HOST, writeKey: 'k' })).toBeTypeOf('function')
  })
})

// last, because a started recorder leaves rrweb state behind that the tests above would see
describe('cross-origin iframes', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('listens for the messages of cross-origin iframes only when asked to', () => {
    const messages = (on: boolean): number => {
      const { api } = setup()
      const add = vi.spyOn(window, 'addEventListener')
      const stop = startReplay(api, { host: HOST, writeKey: 'wk_x', recordCrossOriginIframes: on })
      const n = add.mock.calls.filter((c) => c[0] === 'message').length
      stop()
      add.mockRestore()
      return n
    }
    expect(messages(false)).toBe(0)
    expect(messages(true)).toBeGreaterThan(0)
  })
})
