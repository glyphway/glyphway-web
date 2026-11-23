// Session replay recorder. A lazy module, not
// part of the core bundle: it carries rrweb's `record` and has its own size
// budget in scripts/size.mjs.
//
// rrweb events are buffered, cut into chunks every 10 s or 512 KB (and on page
// hide), gzipped as ONE member, and POSTed to `{host}/replay`. The chunk metadata
// travels in the query string, so the POST is a simple CORS request and
// `sendBeacon`-style delivery works. A failed chunk keeps its (session, window,
// seq) and is retried from an IndexedDB-backed queue; the edge dedupes by that id.
import { record } from 'rrweb'
import type { Glyphway } from './core'
import { isOff } from './feature'
import { uuidv7 } from './util'

export interface ReplayOptions {
  /** Edge base URL. */
  host: string
  writeKey: string
  /** Mask the text of every element. Inputs are always masked. Default `false`. */
  maskAllText?: boolean
  /** Mask the text of elements matching this selector. */
  maskTextSelector?: string
  /** Replace elements matching these selectors with a same-size block (like `.an-no-capture`). */
  blockSelectors?: string[]
  /** No recording on pages whose URL matches one of these. */
  urlBlocklist?: (string | RegExp)[]
  recordCanvas?: boolean
  /**
   * Record iframes from other origins too. rrweb passes their events to this page with `postMessage`,
   * so the iframe's own page must start replay with this option as well. Default `false`.
   */
  recordCrossOriginIframes?: boolean
  /** Canvas frames per second, 0 to 12. Default 4. */
  canvasFps?: number
  /** Request/response headers in network records (denylisted headers are dropped). Default `false`. */
  recordHeaders?: boolean
  /** Request/response bodies, cut at 1 MB. Default `false`. */
  recordBody?: boolean
  /** Chunk interval. Default 10000 ms. */
  chunkMs?: number
  /** Chunk size (uncompressed). Default 512 KB. */
  chunkBytes?: number
  /** Full snapshot interval. Default 5 min. */
  snapshotMs?: number
  /** Bound of the offline queue. Default 50 MB. */
  maxQueueBytes?: number
}

export interface RrEvent {
  type: number
  timestamp: number
  data?: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface Chunk {
  text: string
  events: number
  rawBytes: number
  first: number
  last: number
  flags: number
  stats: string
  url: string
}

const FULL = 2
const META = 4
const CUSTOM = 5
const INCR = 3
const ACTIVE_SOURCES = [1, 2, 3, 5, 6, 7, 12, 14]
const ACTIVE_GAP = 5000
export const F_SNAPSHOT = 1
export const F_PAGE_END = 2
const KEEPALIVE_MAX = 60_000
const DENY_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i
const SECRET_PARAM = /(token|key|secret|passw|auth|session|sig)/i
const LINE_MAX = 2048
const BODY_MAX = 1024 * 1024

const utf8 = (s: string): number => new TextEncoder().encode(s).length

/** Collects events and keeps the numbers the edge wants in a chunk's headers. */
export class Chunker {
  private lines: string[] = []
  private bytes = 0
  private first = 0
  private last = 0
  private flags = 0
  private url = ''
  private metaHref = ''
  private clicks = 0
  private keys = 0
  private errors = 0
  private active = 0
  private prevActive = 0

  get size(): number {
    return this.bytes
  }
  get count(): number {
    return this.lines.length
  }

  add(e: RrEvent): void {
    const line = JSON.stringify(e)
    this.lines.push(line)
    this.bytes += line.length + 1
    if (!this.first || e.timestamp < this.first) this.first = e.timestamp
    if (e.timestamp > this.last) this.last = e.timestamp
    const d = e.data
    if (e.type === META && d && typeof d.href === 'string') this.metaHref = d.href
    if (e.type === FULL) {
      if (!(this.flags & F_SNAPSHOT)) this.url = this.metaHref
      this.flags |= F_SNAPSHOT
    }
    if (e.type === CUSTOM && d && d.tag === 'console' && d.payload && d.payload.level === 'error') this.errors++
    if (e.type === INCR && d) {
      if (d.source === 2 && d.type === 2) this.clicks++
      if (d.source === 5) this.keys++
      if (ACTIVE_SOURCES.includes(d.source)) {
        if (this.prevActive && e.timestamp - this.prevActive <= ACTIVE_GAP) this.active += e.timestamp - this.prevActive
        this.prevActive = e.timestamp
      }
    }
  }

  /** The chunk so far, and an empty buffer. `pageEnd` sets the "ends the page" bit. */
  take(pageEnd = false, fallbackUrl = ''): Chunk | undefined {
    if (!this.lines.length) return undefined
    const text = this.lines.join('\n') + '\n'
    const c: Chunk = {
      text,
      events: this.lines.length,
      rawBytes: utf8(text),
      first: this.first,
      last: this.last,
      flags: this.flags | (pageEnd ? F_PAGE_END : 0),
      stats: `c=${this.clicks};k=${this.keys};e=${this.errors};a=${this.active}`,
      url: this.flags & F_SNAPSHOT ? this.url || fallbackUrl : '',
    }
    this.lines = []
    this.bytes = this.first = this.last = this.flags = this.clicks = this.keys = this.errors = this.active = 0
    this.url = this.metaHref = ''
    return c
  }
}

/** Headers without the denylisted ones (cookies, tokens). */
export function cleanHeaders(h: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = {}
  for (const k in h) if (!DENY_HEADERS.test(k)) o[k] = h[k]!
  return o
}

/** A URL with secret-looking query values replaced. */
export function redactUrl(u: string): string {
  const i = u.indexOf('?')
  if (i < 0) return u
  return (
    u.slice(0, i + 1) +
    u
      .slice(i + 1)
      .split('&')
      .map((p) => {
        const j = p.indexOf('=')
        return j > 0 && SECRET_PARAM.test(p.slice(0, j)) ? p.slice(0, j + 1) + '[redacted]' : p
      })
      .join('&')
  )
}

const show = (v: unknown): string => {
  let s: string
  try {
    s = typeof v === 'string' ? v : v instanceof Error ? v.stack || v.message : JSON.stringify(v)
  } catch {
    s = String(v)
  }
  return (s === undefined ? String(v) : s).slice(0, LINE_MAX)
}

const gzip = async (s: string): Promise<Blob> => {
  const out = new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip')))
  return new Blob([await out.arrayBuffer()], { type: 'text/plain' })
}

interface Pending {
  id?: number
  session: string
  window: string
  seq: number
  first: number
  last: number
  events: number
  raw: number
  flags: number
  stats: string
  url: string
  body: Blob
}

// ---- offline queue: IndexedDB when there is one, memory otherwise
class Store {
  private db?: Promise<IDBDatabase | undefined>
  private mem: Pending[] = []
  private n = 0
  private open(): Promise<IDBDatabase | undefined> {
    return (this.db =
      this.db ||
      new Promise((res) => {
        try {
          const r = indexedDB.open('an-replay', 1)
          r.onupgradeneeded = () => r.result.createObjectStore('q', { keyPath: 'id' })
          r.onsuccess = () => res(r.result)
          r.onerror = () => res(undefined)
        } catch {
          res(undefined)
        }
      }))
  }
  private async tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    const db = await this.open()
    if (!db) return undefined
    return new Promise((res) => {
      try {
        const q = f(db.transaction('q', mode).objectStore('q'))
        q.onsuccess = () => res(q.result)
        q.onerror = () => res(undefined)
      } catch {
        res(undefined)
      }
    })
  }
  async put(p: Pending): Promise<void> {
    if (p.id === undefined) p.id = Date.now() * 1000 + (this.n++ % 1000)
    if ((await this.open()) === undefined) {
      if (!this.mem.includes(p)) this.mem.push(p)
      return
    }
    await this.tx('readwrite', (s) => s.put(p))
  }
  async del(p: Pending): Promise<void> {
    this.mem = this.mem.filter((x) => x !== p)
    if (p.id !== undefined) await this.tx('readwrite', (s) => s.delete(p.id!))
  }
  async all(): Promise<Pending[]> {
    const a = (await this.tx('readonly', (s) => s.getAll())) as Pending[] | undefined
    return [...this.mem, ...(a || [])].sort((x, y) => (x.id || 0) - (y.id || 0))
  }
}

/**
 * Starts recording. Returns the stop function. `a` supplies the session id and
 * the opt-out state, so consent applies to replay as it does to events.
 */
export function startReplay(a: Glyphway, o: ReplayOptions): () => void {
  if (isOff(a, 'replay', 'startReplay()')) return () => {}
  if (typeof CompressionStream === 'undefined' || typeof document === 'undefined' || !o.host || !o.writeKey) return () => {}
  const host = o.host.replace(/\/+$/, '')
  const chunkMs = o.chunkMs || 10_000
  const chunkBytes = o.chunkBytes || 512 * 1024
  const win = uuidv7()
  const ch = new Chunker()
  const store = new Store()
  const maxQueue = o.maxQueueBytes || 50 * 1024 * 1024
  let pending: Pending[] = []
  let sid = ''
  let seq = 0
  let stopRec: (() => void) | undefined
  let stopped = false
  let busy = false
  let retryAt = 0
  let backoff = 1000
  const timers: ReturnType<typeof setInterval>[] = []
  const undo: (() => void)[] = []

  const blocked = (): boolean => (o.urlBlocklist || []).some((p) => (typeof p === 'string' ? location.href.includes(p) : p.test(location.href)))

  // consent withdrawn: what is buffered or queued is dropped, not sent
  const discard = (): void => {
    ch.take()
    const gone = pending.splice(0)
    for (const p of gone) void store.del(p)
  }

  const pump = async (): Promise<void> => {
    if (a.hasOptedOut()) return discard()
    if (busy || !pending.length || Date.now() < retryAt) return
    busy = true
    try {
      while (pending.length) {
        const p = pending[0]!
        const q = new URLSearchParams({
          k: o.writeKey,
          session: p.session,
          window: p.window,
          seq: String(p.seq),
          first_ts: String(p.first),
          last_ts: String(p.last),
          events: String(p.events),
          raw_bytes: String(p.raw),
          flags: String(p.flags),
          stats: p.stats,
          sent_at: String(Date.now()),
        })
        if (p.url) q.set('url', p.url)
        let status = 0
        try {
          status = (
            await fetch(`${host}/replay?${q}`, {
              method: 'POST',
              body: p.body,
              keepalive: p.body.size <= KEEPALIVE_MAX,
              headers: { 'Content-Type': 'text/plain' },
            })
          ).status
        } catch {
          status = 0
        }
        if (status === 200 || (status >= 400 && status < 500 && status !== 408 && status !== 429)) {
          pending.shift()
          await store.del(p)
          backoff = 1000
        } else {
          // Network, 5xx, 429, 503 (edge busy), 507 (disk full): keep it and try later.
          await Promise.all(pending.map((x) => store.put(x)))
          retryAt = Date.now() + backoff
          backoff = Math.min(backoff * 2, 60_000)
          setTimeout(pump, retryAt - Date.now() + 5)
          break
        }
      }
    } finally {
      busy = false
    }
  }

  const trim = (): void => {
    let total = pending.reduce((n, p) => n + p.body.size, 0)
    while (total > maxQueue && pending.length > 1) total -= pending.shift()!.body.size
  }

  let building = Promise.resolve()
  const flush = (pageEnd = false): void => {
    const c = ch.take(pageEnd, location.href)
    if (!c) return
    const session = sid || a.getSessionId()
    const n = seq++
    // Chunks are compressed one after the other so their order is kept.
    building = building.then(async () => {
      const body = await gzip(c.text)
      const p: Pending = { session, window: win, seq: n, first: c.first, last: c.last, events: c.events, raw: c.rawBytes, flags: c.flags, stats: c.stats, url: c.url, body }
      pending.push(p)
      trim()
      if (pageEnd && body.size > KEEPALIVE_MAX) await store.put(p) // too big to send while leaving: next page load sends it
      void pump()
    })
  }

  const emit = (e: RrEvent): void => {
    if (!sid) sid = a.getSessionId()
    ch.add(e)
    if (ch.size >= chunkBytes) flush()
  }

  const ensure = (): void => {
    const want = !stopped && !a.hasOptedOut() && !blocked()
    if (want && !stopRec) {
      sid = a.getSessionId()
      seq = 0
      stopRec = record({
        emit: emit as never,
        checkoutEveryNms: o.snapshotMs || 5 * 60_000,
        blockClass: /^(an|ph)-no-capture$/,
        blockSelector: o.blockSelectors && o.blockSelectors.length ? o.blockSelectors.join(',') : undefined,
        maskTextSelector: o.maskAllText ? '*' : o.maskTextSelector,
        maskAllInputs: true,
        // a fixed run, so the length of a password or a field is not given away
        maskInputFn: (text) => (text ? '********' : ''),
        inlineStylesheet: true,
        slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true, headMetaDescKeywords: true, headMetaSocial: true, headMetaRobots: true, headMetaHttpEquiv: true, headMetaAuthorship: true, headMetaVerification: true },
        recordCanvas: !!o.recordCanvas,
        recordCrossOriginIframes: !!o.recordCrossOriginIframes,
        sampling: o.recordCanvas ? { canvas: Math.max(0, Math.min(12, o.canvasFps === undefined ? 4 : o.canvasFps)) } : undefined,
        errorHandler: () => true,
      })
    } else if (!want && stopRec) {
      if (a.hasOptedOut()) discard()
      else flush()
      stopRec()
      stopRec = undefined
    }
    // A new session starts with its own sequence and its own full snapshot.
    const now = a.getSessionId()
    if (stopRec && sid && now && now !== sid) {
      flush()
      sid = now
      seq = 0
      record.takeFullSnapshot()
    }
  }

  // ---- console
  let inConsole = false
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[level]
    console[level] = function (this: Console, ...args: unknown[]) {
      orig.apply(this, args)
      if (inConsole || !stopRec) return
      inConsole = true
      try {
        record.addCustomEvent('console', { level, payload: args.slice(0, 10).map(show) })
      } finally {
        inConsole = false
      }
    }
    undo.push(() => {
      console[level] = orig
    })
  }

  // ---- network: resource timings, or a fetch/XHR wrapper when headers or bodies are wanted
  const wrap = !!(o.recordHeaders || o.recordBody)
  const net = (r: Record<string, unknown>): void => {
    if (!stopRec || typeof r.url !== 'string' || r.url.startsWith(host)) return
    r.url = redactUrl(r.url)
    record.addCustomEvent('network', r)
  }
  if (typeof PerformanceObserver !== 'undefined' && !wrap) {
    try {
      const obs = new PerformanceObserver((l) => {
        for (const e of l.getEntries() as PerformanceResourceTiming[]) {
          if (e.initiatorType !== 'fetch' && e.initiatorType !== 'xmlhttprequest') continue
          net({ url: e.name, method: '', status: (e as { responseStatus?: number }).responseStatus || 0, start: Math.round(performance.timeOrigin + e.startTime), duration: Math.round(e.duration), type: e.initiatorType, size: e.transferSize || 0 })
        }
      })
      obs.observe({ type: 'resource', buffered: false })
      undo.push(() => obs.disconnect())
    } catch {
      /* resource timing unavailable */
    }
  }
  if (wrap && typeof fetch === 'function') {
    const orig = window.fetch
    window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const start = Date.now()
      const t0 = performance.now()
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = ((init && init.method) || (typeof input === 'object' && 'method' in input ? input.method : '') || 'GET').toUpperCase()
      try {
        const res = await orig.call(window, input, init)
        const r: Record<string, unknown> = { url, method, status: res.status, start, duration: Math.round(performance.now() - t0), type: 'fetch', size: Number(res.headers.get('content-length')) || 0 }
        if (o.recordHeaders) {
          const h: Record<string, string> = {}
          res.headers.forEach((v, k) => (h[k] = v))
          r.responseHeaders = cleanHeaders(h)
          r.requestHeaders = cleanHeaders((init && (init.headers as Record<string, string>)) || {})
        }
        if (o.recordBody) {
          res
            .clone()
            .text()
            .then((t) => net({ ...r, responseBody: t.slice(0, BODY_MAX), requestBody: typeof (init && init.body) === 'string' ? (init!.body as string).slice(0, BODY_MAX) : undefined }), () => net(r))
        } else net(r)
        return res
      } catch (e) {
        net({ url, method, status: 0, start, duration: Math.round(performance.now() - t0), type: 'fetch', size: 0 })
        throw e
      }
    }
    undo.push(() => {
      window.fetch = orig
    })
  }

  // ---- navigation: a full snapshot for every page, as heatmap backdrops need one per URL
  const snap = (): void => {
    setTimeout(() => {
      ensure()
      if (stopRec) record.takeFullSnapshot()
    }, 0)
  }
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m]
    history[m] = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = orig.apply(this, args)
      snap()
      return r
    }
    undo.push(() => {
      history[m] = orig
    })
  }
  const on = (t: EventTarget, type: string, f: () => void): void => {
    t.addEventListener(type, f)
    undo.push(() => t.removeEventListener(type, f))
  }
  on(window, 'popstate', snap)
  on(window, 'pagehide', () => flush(true))
  on(document, 'visibilitychange', () => document.hidden && flush(true))
  on(window, 'online', () => {
    retryAt = 0
    void pump()
  })

  timers.push(setInterval(() => (ensure(), flush()), chunkMs))
  timers.push(setInterval(ensure, 1000))
  ensure()
  // Chunks left by a page that could not send them.
  void store.all().then((all) => {
    pending = [...all.filter((p) => !pending.includes(p)), ...pending]
    void pump()
  })

  return () => {
    if (stopped) return
    flush(true)
    stopped = true
    if (stopRec) stopRec()
    stopRec = undefined
    timers.forEach(clearInterval)
    undo.forEach((f) => f())
  }
}
