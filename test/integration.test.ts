// @vitest-environment node
//
// Posts real batches to a running edge. Skipped unless EDGE_URL and WRITE_KEY
// are set. Runs in Node (real `fetch`, no browser CORS) with a happy-dom
// Window providing the DOM globals the SDK reads.
//
//   EDGE_URL=http://127.0.0.1:8081 WRITE_KEY=wk_... pnpm vitest run test/integration.test.ts
//
// Optional: EDGE_DATA_DIR=<edge data dir> also checks each accepted uuid was
// appended to a segment file (open or sealed, read before the puller acks it).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { autocapture } from '../src/autocapture'
import { Glyphway, setAutocapture } from '../src/core'
import type { GlyphwayEvent } from '../src/types'

const EDGE = process.env.EDGE_URL
const KEY = process.env.WRITE_KEY
const DATA = process.env.EDGE_DATA_DIR

interface Call {
  keepalive: boolean
  gzip: boolean
  auth: boolean
  status: number
  response: unknown
  batch: GlyphwayEvent[]
}

describe.skipIf(!EDGE || !KEY)('integration: real edge at EDGE_URL', () => {
  const realFetch = globalThis.fetch
  const calls: Call[] = []
  const pending: Promise<unknown>[] = []
  let win: Window

  beforeAll(() => {
    win = new Window({ url: 'https://shop.example.test/landing?utm_source=integration&gclid=it-1' })
    const w = win as unknown as Record<string, unknown>
    const g: Record<string, unknown> = {
      window: win,
      document: win.document,
      location: win.location,
      navigator: win.navigator,
      history: win.history,
      screen: win.screen,
      addEventListener: win.addEventListener.bind(win),
      removeEventListener: win.removeEventListener.bind(win),
      localStorage: w.localStorage,
      sessionStorage: w.sessionStorage,
    }
    for (const [k, v] of Object.entries(g)) vi.stubGlobal(k, v)
    win.document.title = 'Integration'
    setAutocapture(autocapture)
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      const p = (async () => {
        const res = await realFetch(url, init)
        const headers = (init.headers || {}) as Record<string, string>
        const gzip = headers['Content-Encoding'] === 'gzip'
        const raw = gzip ? '' : String(init.body)
        calls.push({
          keepalive: !!init.keepalive,
          gzip,
          auth: !!headers.Authorization,
          status: res.status,
          response: await res.clone().json().catch(() => null),
          batch: raw ? JSON.parse(raw).batch : [],
        })
        return res
      })()
      pending.push(p)
      return p
    })
  })

  afterAll(async () => {
    await Promise.allSettled(pending)
    vi.unstubAllGlobals()
    await win.happyDOM.close()
  })

  const fresh = (opts: Record<string, unknown> = {}, key = KEY!): Glyphway => {
    ;(win.localStorage as Storage).clear()
    ;(win.sessionStorage as Storage).clear()
    calls.length = 0
    const a = new Glyphway()
    a.init(key, { host: EDGE!, capturePageview: true, autocapture: true, ...opts })
    return a
  }

  const landed = (uuids: string[]): string[] => {
    if (!DATA) return uuids
    const text = readdirSync(DATA)
      .filter((f) => f.includes('.ndjson'))
      .map((f) => readFileSync(join(DATA, f), 'utf8'))
      .join('\n')
    return uuids.filter((u) => text.includes(u))
  }

  it('sends a real batch (pageview, custom, identify, group, alias, autocapture) and the edge accepts all of it', async () => {
    const a = fresh()
    a.capture('integration_test', { n: 1, nested: { ok: true } })
    a.register({ suite: 'web-sdk-integration' })
    a.identify('it-user-' + Date.now(), { plan: 'pro' }, { first: 'yes' })
    a.group('company', 'it-co', { name: 'Integration Co' })
    a.alias('it-alias-' + Date.now())
    const btn = win.document.createElement('button')
    btn.textContent = 'Buy'
    win.document.body.appendChild(btn)
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, clientX: 3, clientY: 4 }))
    const queued = a.q_.q_.map((x) => x.e)
    expect(queued.map((e) => e.event)).toEqual(['$pageview', 'integration_test', '$identify', '$groupidentify', '$create_alias', '$autocapture'])
    await a.flush()
    expect(calls.map((c) => [c.status, c.auth, c.keepalive])).toEqual([[200, true, false]])
    expect(calls[0]!.response).toEqual({ status: 1, accepted: 6 })
    expect(a.q_.q_).toHaveLength(0)
    expect(landed(queued.map((e) => e.uuid))).toHaveLength(6)
    a.teardown_()
  })

  it('gzip body (Content-Encoding: gzip) is accepted', async () => {
    const a = fresh({ compression: 'gzip', capturePageview: false })
    a.capture('integration_gzip', { pad: 'x'.repeat(20_000) })
    await a.flush()
    expect(calls.map((c) => [c.status, c.gzip])).toEqual([[200, true]])
    expect(a.q_.q_).toHaveLength(0)
    a.teardown_()
  })

  it('page-hide path: keepalive fetch, text/plain, api_key in the body, no Authorization header', async () => {
    const a = fresh({ capturePageview: false })
    a.capture('integration_unload_1')
    a.capture('integration_unload_2')
    const uuids = a.q_.q_.map((x) => x.e.uuid)
    Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    win.document.dispatchEvent(new win.Event('visibilitychange'))
    await Promise.allSettled(pending)
    expect(calls.map((c) => [c.status, c.keepalive, c.auth])).toEqual([[200, true, false]])
    expect(calls[0]!.response).toEqual({ status: 1, accepted: 2 })
    expect(a.q_.q_).toHaveLength(0)
    expect(landed(uuids)).toHaveLength(2)
    Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => 'visible' })
    a.teardown_()
  })

  it('400 split rule: an invalid event is dropped, the valid ones still land', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = fresh({ capturePageview: false })
    a.capture('integration_valid_1')
    // Bypass client-side validation to make the edge reject one event.
    const bad = { ...a.q_.q_[0]!.e, uuid: 'bad-' + Date.now(), event: '' }
    a.q_.push(bad, 200)
    a.capture('integration_valid_2')
    await a.flush()
    expect(calls.map((c) => c.status)).toEqual([400, 200, 400, 200])
    expect(calls.filter((c) => c.status === 200).map((c) => c.batch[0]!.event)).toEqual(['integration_valid_1', 'integration_valid_2'])
    expect(a.q_.q_).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    a.teardown_()
  })

  it('unknown write key: 401, dropped without retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = fresh({ capturePageview: false }, 'wk_integration_unknown_key')
    a.capture('integration_401')
    await a.flush()
    expect(calls.map((c) => c.status)).toEqual([401])
    expect(a.q_.q_).toHaveLength(0)
    expect(a.q_.fails_).toBe(0)
    warn.mockRestore()
    a.teardown_()
  })
})
