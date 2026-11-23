import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, vi } from 'vitest'
import { autocapture } from '../src/autocapture'
import { Glyphway, setAutocapture } from '../src/core'
import type { GlyphwayEvent, Options } from '../src/types'

setAutocapture(autocapture)

export const KEY = 'wk_test'
export const HOST = 'https://edge.test'
export const T0 = new Date('2026-11-04T10:00:00.000Z').getTime()

export interface Sent {
  url: string
  headers: Record<string, string>
  body: { batch: GlyphwayEvent[]; sent_at: string; api_key?: string }
  keepalive: boolean
  gzip: boolean
  status: number
}

/** Fetch mock: `respond` decides the status per request (default 200). */
export function mockFetch(respond: (body: Sent['body'], n: number) => number | Error = () => 200) {
  const sent: Sent[] = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers || {}) as Record<string, string>
    const gzip = headers['Content-Encoding'] === 'gzip'
    const raw = gzip ? gunzipSync(Buffer.from(init.body as ArrayBuffer)).toString('utf8') : (init.body as string)
    const body = JSON.parse(raw)
    const r = respond(body, sent.length)
    const status = r instanceof Error ? 0 : r
    sent.push({ url, headers, body, keepalive: !!init.keepalive, gzip, status })
    if (r instanceof Error) throw r
    return { status, ok: status >= 200 && status < 300 } as Response
  })
  vi.stubGlobal('fetch', fn)
  return { fn, sent, events: () => sent.filter((s) => s.status === 200).flatMap((s) => s.body.batch) }
}

/** Make `'keepalive' in Request.prototype` true (happy-dom lacks it). */
export function stubKeepalive(on = true): void {
  class R {}
  if (on) Object.defineProperty(R.prototype, 'keepalive', { get: () => true })
  vi.stubGlobal('Request', R)
}

const live: Glyphway[] = []
export function make(opts: Partial<Options> = {}, key = KEY): Glyphway {
  const a = new Glyphway()
  a.init(key, { host: HOST, autocapture: false, capturePageview: false, compression: 'none', projectSettings: false, ...opts })
  live.push(a)
  return a
}

/** Simulate a page reload: tear the instance down (its memory is gone), keep storage. */
export function kill(a: Glyphway): void {
  a.teardown_()
  const i = live.indexOf(a)
  if (i >= 0) live.splice(i, 1)
}

export function queued(a: Glyphway): GlyphwayEvent[] {
  return a.q_.q_.map((x) => x.e)
}

/** The events in storage (one key per event, `an_<key>_q:<tab>:<uuid>`), with the owner tab and its lease time. */
export function stored(key = KEY): { o: string; t: number; e: GlyphwayEvent }[] {
  const p = `an_${key}_q:`
  const r: { o: string; t: number; e: GlyphwayEvent }[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!
    if (!k.startsWith(p) || !k.slice(p.length).includes(':')) continue
    const o = k.slice(p.length, k.indexOf(':', p.length))
    r.push({ o, t: Number(localStorage.getItem(p + o)), e: JSON.parse(localStorage.getItem(k)!) })
  }
  return r.sort((a, b) => (a.e.timestamp < b.e.timestamp ? -1 : 1))
}

/** Every storage key the queue uses for this project (events, leases, the unconfirmed hand-offs, the old single key). */
export function queueKeys(key = KEY): string[] {
  const r: string[] = []
  for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)!.startsWith(`an_${key}_q`)) r.push(localStorage.key(i)!)
  return r
}

/** Events handed to the browser on unload and not confirmed. */
export function unconfirmed(key = KEY): { t: number; e: GlyphwayEvent }[] {
  return JSON.parse(localStorage.getItem(`an_${key}_qs`) || '[]')
}

export function setVisibility(v: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
  document.dispatchEvent(new Event('visibilitychange'))
}

export function useEnv(): void {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
    localStorage.clear()
    sessionStorage.clear()
    history.replaceState(null, '', '/')
    document.body.innerHTML = ''
    document.title = 'Test page'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    Object.defineProperty(document, 'referrer', { configurable: true, get: () => '' })
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, writable: true, value: vi.fn(() => true) })
    mockFetch()
  })
  afterEach(() => {
    while (live.length) live.pop()!.teardown_()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
}
