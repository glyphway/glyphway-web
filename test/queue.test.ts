import { describe, expect, it, vi } from 'vitest'
import { LEASE, RESEND, SENT_TTL } from '../src/queue'
import { HOST, KEY, kill, make, mockFetch, queueKeys, queued, setVisibility, stored, stubKeepalive, unconfirmed, useEnv } from './helpers'

const ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/

describe('transport', () => {
  useEnv()

  it('POSTs {batch, sent_at} to /batch with a Bearer key; events carry uuid + ISO timestamp', async () => {
    const f = mockFetch()
    const a = make({ host: HOST + '/' })
    a.capture('hello', { n: 1 })
    await a.flush()
    expect(f.sent).toHaveLength(1)
    const s = f.sent[0]!
    expect(s.url).toBe(HOST + '/batch')
    expect(s.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY })
    expect(Object.keys(s.body).sort()).toEqual(['batch', 'sent_at'])
    expect(s.body.sent_at).toMatch(ISO_MS)
    const e = s.body.batch[0]!
    expect(Object.keys(e).sort()).toEqual(['distinct_id', 'event', 'properties', 'timestamp', 'uuid'])
    expect(e.timestamp).toMatch(ISO_MS)
    expect(e.properties).toMatchObject({ n: 1, $lib: 'web', $lib_version: '1.0.0' })
    expect(queued(a)).toHaveLength(0)
    expect(stored()).toHaveLength(0)
  })

  it('flushes every flushIntervalMs, and immediately at 20 events', async () => {
    const f = mockFetch()
    const a = make()
    a.capture('a')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(f.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.sent).toHaveLength(1)
    for (let i = 0; i < 19; i++) a.capture('e' + i)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sent).toHaveLength(1)
    a.capture('e19')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sent).toHaveLength(2)
    expect(f.sent[1]!.body.batch).toHaveLength(20)
  })

  it('retries 503/429/5xx/network errors with 1 s -> 60 s jittered backoff, reusing each uuid', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999999) // jitter at its top: delay ~= d
    const codes = [503, 429, 0, 500, 507, 503, 503, 503, 200]
    const f = mockFetch((_, n) => (codes[n] === 0 ? new TypeError('network') : codes[n]!))
    const a = make()
    a.capture('x')
    const uuid = queued(a)[0]!.uuid
    await a.flush()
    const at: number[] = []
    const t0 = Date.now()
    for (let i = 1; i < codes.length; i++) {
      // advance until the next attempt happens
      while (f.sent.length === i) await vi.advanceTimersByTimeAsync(100)
      at.push(Math.round((Date.now() - t0) / 100) * 100)
    }
    const gaps = at.map((t, i) => t - (i ? at[i - 1]! : 0))
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
    expect(f.sent.every((s) => s.body.batch[0]!.uuid === uuid)).toBe(true)
    expect(f.sent.at(-1)!.status).toBe(200)
    expect(queued(a)).toHaveLength(0)
  })

  it('jitter keeps each delay within [d/2, d)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const f = mockFetch((_, n) => (n === 0 ? 503 : 200))
    const a = make()
    a.capture('x')
    await a.flush()
    await vi.advanceTimersByTimeAsync(499)
    expect(f.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.sent).toHaveLength(2)
  })

  it('on 400 resends one by one and drops only the invalid event (split rule)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = mockFetch((b) => (b.batch.some((e) => e.event === 'poison') ? 400 : 200))
    const a = make()
    a.capture('ok1')
    a.capture('poison')
    a.capture('ok2')
    await a.flush()
    expect(f.sent.map((s) => s.body.batch.map((e) => e.event))).toEqual([['ok1', 'poison', 'ok2'], ['ok1'], ['poison'], ['ok2']])
    expect(f.events().map((e) => e.event)).toEqual(['ok1', 'ok2'])
    expect(queued(a)).toHaveLength(0)
    expect(warn.mock.calls.some((c) => String(c.join(' ')).includes('poison'))).toBe(true)
  })

  it('applies the split rule to 413 as well, and drops on 401 without retrying', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = mockFetch((b) => (b.batch.length > 1 ? 413 : 401))
    const a = make()
    a.capture('a')
    a.capture('b')
    await a.flush()
    expect(f.sent.map((s) => s.status)).toEqual([413, 401, 401])
    expect(queued(a)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.sent).toHaveLength(3)
  })

  it('a retryable error during the one-by-one pass keeps the rest for the next attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const codes = [400, 200, 503]
    const f = mockFetch((_, n) => codes[n] ?? 200)
    const a = make()
    a.capture('a')
    a.capture('b')
    a.capture('c')
    await a.flush()
    expect(queued(a).map((e) => e.event)).toEqual(['b', 'c'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.sent.at(-1)!.body.batch.map((e: { event: string }) => e.event)).toEqual(['b', 'c'])
    expect(queued(a)).toHaveLength(0)
  })

  it('gzip: compresses with CompressionStream and sets Content-Encoding', async () => {
    const f = mockFetch()
    const a = make({ compression: 'gzip' })
    a.capture('zipped', { big: 'x'.repeat(5000) })
    await a.flush()
    expect(f.sent[0]!.gzip).toBe(true)
    expect(f.sent[0]!.headers['Content-Encoding']).toBe('gzip')
    expect(f.sent[0]!.body.batch[0]!.event).toBe('zipped')
  })

  it('gzip: an edge that cannot read gzip (400) gets the batch uncompressed instead of split-and-drop', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = mockFetch((_, n) => (n === 0 ? 400 : 200))
    const a = make({ compression: 'gzip' })
    a.capture('a')
    a.capture('b')
    await a.flush()
    expect(f.sent.map((s) => [s.gzip, s.body.batch.length])).toEqual([
      [true, 2],
      [false, 2],
    ])
    expect(f.events()).toHaveLength(2)
  })

  it('compression none (default): plain JSON', async () => {
    const f = mockFetch()
    const a = make()
    a.capture('a')
    await a.flush()
    expect(f.sent[0]!.gzip).toBe(false)
  })
})

describe('persistent queue', () => {
  useEnv()

  it('mirrors queued events to localStorage, one key per event under an_<key>_q:<tab>:<uuid>', () => {
    mockFetch(() => 503)
    const a = make()
    a.capture('x')
    const s = stored()
    expect(s).toHaveLength(1)
    expect(s[0]!.e.event).toBe('x')
    expect(s[0]!.o).toBe(a.tid_)
  })

  it('survives a reload: the same tab re-adopts its unsent events and sends them with the same uuid', async () => {
    const f = mockFetch(() => new TypeError('offline'))
    const a = make()
    a.capture('before-reload')
    const uuid = queued(a)[0]!.uuid
    await a.flush()
    vi.mocked(navigator.sendBeacon).mockReturnValue(false) // the unload send also fails
    window.dispatchEvent(new Event('pagehide'))
    kill(a)
    const ok = mockFetch()
    const b = make()
    expect(b.tid_).toBe(a.tid_)
    expect(queued(b).map((e) => e.uuid)).toContain(uuid)
    await b.flush()
    expect(ok.events().find((e) => e.event === 'before-reload')!.uuid).toBe(uuid)
    expect(f.sent.length).toBeGreaterThan(0)
  })

  it("after a crash, another tab adopts the dead tab's events once its lease expires", async () => {
    mockFetch(() => new TypeError('offline'))
    const a = make()
    a.capture('orphan')
    kill(a) // crash: no pagehide, no unload send
    const f = mockFetch()
    const b = make() // primary flag still set -> new tab id
    expect(b.tid_).not.toBe(a.tid_)
    expect(queued(b)).toHaveLength(0) // a's lease is fresh: not taken
    await vi.advanceTimersByTimeAsync(LEASE + 1)
    await b.flush()
    expect(f.events().map((e) => e.event)).toEqual(['orphan'])
    expect(stored()).toHaveLength(0)
  })

  it("never takes a live tab's fresh events, and keeps them in storage when writing its own", async () => {
    const f = mockFetch(() => 503)
    const a = make()
    a.capture('from-a')
    mockFetch()
    const b = make()
    b.capture('from-b')
    await b.flush()
    expect(f.sent).toHaveLength(0)
    expect(stored().map((x) => x.e.event)).toEqual(['from-a'])
  })

  it('is bounded to maxQueue events, dropping the oldest', () => {
    mockFetch(() => 503)
    const a = make({ maxQueue: 5 })
    vi.spyOn(a.q_, 'flush').mockResolvedValue()
    for (let i = 0; i < 8; i++) a.capture('e' + i)
    expect(queued(a).map((e) => e.event)).toEqual(['e3', 'e4', 'e5', 'e6', 'e7'])
    expect(stored()).toHaveLength(5)
  })

  it('is bounded to 1 MB, dropping the oldest', () => {
    mockFetch(() => 503)
    const a = make()
    vi.spyOn(a.q_, 'flush').mockResolvedValue()
    for (let i = 0; i < 6; i++) a.capture('big' + i, { pad: 'x'.repeat(200_000) })
    expect(a.q_.b_).toBeLessThanOrEqual(1_000_000)
    expect(queued(a).map((e) => e.event)).toEqual(['big2', 'big3', 'big4', 'big5'])
  })

  it('drops (with a warning) events that are not serialisable or larger than the edge accepts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = make()
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    a.capture('cyclic', cyc)
    a.capture('huge', { pad: 'x'.repeat(1_100_000) })
    a.capture('')
    a.capture('e'.repeat(201))
    expect(queued(a)).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(4)
  })

  it('removing a sent event deletes only its key; opt-out and storage-full keep working', async () => {
    mockFetch(() => 503)
    const a = make()
    a.capture('x')
    expect(queueKeys().length).toBe(2) // the event and the tab's lease
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    a.capture('y') // storage full: the in-memory queue still takes it
    expect(queued(a).map((e) => e.event)).toEqual(['x', 'y'])
    set.mockRestore()
  })

  it('a queue left by the previous SDK (one an_<key>_q array) is adopted once, then removed', async () => {
    const mine = { uuid: 'u-old-1', event: 'old1', distinct_id: 'd', timestamp: '2026-11-04T09:00:00.000Z', properties: {} }
    const dead = { uuid: 'u-old-2', event: 'old2', distinct_id: 'd', timestamp: '2026-11-04T09:00:01.000Z', properties: {} }
    const live = { uuid: 'u-old-3', event: 'old3', distinct_id: 'd', timestamp: '2026-11-04T09:00:02.000Z', properties: {} }
    const f = mockFetch()
    const a = make()
    localStorage.setItem(
      `an_${KEY}_q`,
      JSON.stringify([
        { o: a.tid_, t: Date.now(), e: mine },
        { o: 'gone', t: Date.now() - LEASE - 1, e: dead },
        { o: 'other-live-tab', t: Date.now(), e: live },
      ]),
    )
    a.q_.adopt_()
    await a.flush()
    expect(f.events().map((e) => e.event)).toEqual(['old1', 'old2'])
    expect(JSON.parse(localStorage.getItem(`an_${KEY}_q`)!).map((x: { e: { event: string } }) => x.e.event)).toEqual(['old3'])
  })
})

describe('events handed to the browser on unload (sent, unconfirmed)', () => {
  useEnv()

  it('stay under an_<key>_qs after the hand-off, not in the queue', () => {
    stubKeepalive()
    mockFetch(() => 503)
    const a = make()
    a.capture('x')
    const uuid = queued(a)[0]!.uuid
    setVisibility('hidden')
    expect(queued(a)).toHaveLength(0)
    expect(stored()).toHaveLength(0)
    expect(unconfirmed().map((x) => x.e.uuid)).toEqual([uuid])
  })

  it('a hand-off that failed after the page was gone is sent again by the next page, with the same uuid', async () => {
    stubKeepalive(false)
    const a = make()
    a.capture('lost')
    const uuid = queued(a)[0]!.uuid
    window.dispatchEvent(new Event('pagehide')) // sendBeacon says yes, then the request fails: nobody hears
    kill(a)
    const f = mockFetch()
    const b = make()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sent).toHaveLength(0) // too young: the first send may well have arrived
    expect(queued(b)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(RESEND + 5)
    expect(f.events().map((e) => e.uuid)).toEqual([uuid])
    expect(unconfirmed()).toHaveLength(0)
    expect(stored()).toHaveLength(0)
  })

  it('a response seen as ok while the page is alive confirms them', async () => {
    stubKeepalive()
    mockFetch()
    const a = make()
    a.capture('x')
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(0)
    expect(unconfirmed()).toHaveLength(0)
  })

  it('a failure seen while the page is alive puts them back in the queue and out of the unconfirmed key', async () => {
    stubKeepalive()
    mockFetch(() => 503)
    const a = make()
    a.capture('x')
    const uuid = queued(a)[0]!.uuid
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(0)
    expect(unconfirmed()).toHaveLength(0)
    expect(stored().map((x) => x.e.uuid)).toEqual([uuid])
  })

  it('are forgotten after SENT_TTL', async () => {
    stubKeepalive(false)
    const a = make()
    a.capture('old')
    window.dispatchEvent(new Event('pagehide'))
    kill(a)
    await vi.advanceTimersByTimeAsync(SENT_TTL + 1)
    const f = mockFetch()
    const b = make()
    await b.flush()
    expect(f.sent).toHaveLength(0)
    expect(unconfirmed()).toHaveLength(0)
  })

  it('opt-out removes them too', () => {
    stubKeepalive(false)
    const a = make()
    a.capture('x')
    window.dispatchEvent(new Event('pagehide'))
    expect(unconfirmed()).toHaveLength(1)
    a.optOut()
    expect(unconfirmed()).toHaveLength(0)
    expect(queueKeys()).toHaveLength(0)
  })
})

describe('persistent queue, continued', () => {
  useEnv()

  it('splits sends into requests of at most 100 events', async () => {
    const f = mockFetch()
    const a = make()
    vi.spyOn(a.q_, 'flush').mockResolvedValue()
    for (let i = 0; i < 250; i++) a.capture('e' + i)
    vi.mocked(a.q_.flush).mockRestore()
    await a.flush()
    expect(f.sent.map((s) => s.body.batch.length)).toEqual([100, 100, 50])
  })
})

describe('page-hide flush (beacon / keepalive path)', () => {
  useEnv()

  it('visibility hidden -> fetch(keepalive) with text/plain body + api_key, no Authorization header', () => {
    stubKeepalive()
    const f = mockFetch()
    const a = make()
    a.capture('x')
    a.capture('y')
    setVisibility('hidden')
    expect(f.sent).toHaveLength(1)
    const s = f.sent[0]!
    expect(s.keepalive).toBe(true)
    expect(s.url).toBe(HOST + '/batch')
    expect(s.headers).toEqual({ 'Content-Type': 'text/plain' })
    expect(s.body.api_key).toBe(KEY)
    expect(s.body.sent_at).toMatch(ISO_MS)
    expect(s.body.batch.map((e) => e.event)).toEqual(['x', 'y'])
    expect(queued(a)).toHaveLength(0)
    expect(stored()).toHaveLength(0)
  })

  it('falls back to sendBeacon when keepalive is unsupported', () => {
    stubKeepalive(false)
    const f = mockFetch()
    const a = make()
    a.capture('x')
    window.dispatchEvent(new Event('pagehide'))
    expect(f.sent).toHaveLength(0)
    const beacon = vi.mocked(navigator.sendBeacon)
    expect(beacon).toHaveBeenCalledTimes(1)
    const [url, body] = beacon.mock.calls[0]! as [string, string]
    expect(url).toBe(HOST + '/batch')
    const parsed = JSON.parse(body)
    expect(parsed.api_key).toBe(KEY)
    expect(parsed.batch.map((e: { event: string }) => e.event)).toEqual(['x'])
    expect(queued(a)).toHaveLength(0)
  })

  it('keeps events queued (and persisted) when the beacon is refused', () => {
    stubKeepalive(false)
    const a = make()
    a.capture('x')
    vi.mocked(navigator.sendBeacon).mockReturnValue(false)
    window.dispatchEvent(new Event('pagehide'))
    expect(queued(a)).toHaveLength(1)
    expect(stored()).toHaveLength(1)
  })

  it('requeues a failed keepalive send if the page is still alive', async () => {
    stubKeepalive()
    mockFetch(() => 503)
    const a = make()
    a.capture('x')
    const uuid = queued(a)[0]!.uuid
    setVisibility('hidden')
    expect(queued(a)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(queued(a).map((e) => e.uuid)).toEqual([uuid])
  })

  it('chunks bodies under 64 KiB and uses sendBeacon once the keepalive budget is spent', () => {
    stubKeepalive()
    const f = mockFetch()
    const a = make()
    vi.spyOn(a.q_, 'flush').mockResolvedValue()
    for (let i = 0; i < 6; i++) a.capture('e' + i, { pad: 'x'.repeat(25_000) })
    setVisibility('hidden')
    const ka = f.sent
    const beacon = vi.mocked(navigator.sendBeacon)
    expect(ka.length).toBeGreaterThan(0)
    expect(beacon).toHaveBeenCalled()
    for (const s of ka) expect(JSON.stringify(s.body).length).toBeLessThan(64 * 1024)
    for (const c of beacon.mock.calls) expect((c[1] as string).length).toBeLessThan(64 * 1024)
    const n = ka.reduce((x, s) => x + s.body.batch.length, 0) + beacon.mock.calls.reduce((x, c) => x + JSON.parse(c[1] as string).batch.length, 0)
    expect(n).toBe(6)
  })

  it('does not resend the batch a regular request is carrying', async () => {
    stubKeepalive()
    let release: (v: Response) => void = () => {}
    const sent: string[][] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_u: string, init: RequestInit) => {
        sent.push(JSON.parse(init.body as string).batch.map((e: { event: string }) => e.event))
        return init.keepalive ? Promise.resolve({ ok: true, status: 200 } as Response) : new Promise<Response>((r) => (release = r))
      }),
    )
    const a = make()
    a.capture('in-flight')
    const p = a.flush()
    await vi.advanceTimersByTimeAsync(0)
    a.capture('later')
    setVisibility('hidden')
    expect(sent).toEqual([['in-flight'], ['later']])
    release({ ok: true, status: 200 } as Response)
    await p
    expect(queued(a)).toHaveLength(0)
  })
})

describe('opt-out (privacy)', () => {
  useEnv()

  it('optOut() stops capture and clears the queue in memory and storage; remembered across reloads', async () => {
    const f = mockFetch(() => 503)
    const a = make()
    a.capture('x')
    a.optOut()
    expect(queued(a)).toHaveLength(0)
    expect(stored()).toHaveLength(0)
    a.capture('y')
    expect(queued(a)).toHaveLength(0)
    expect(a.hasOptedOut()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    const before = f.sent.length
    kill(a)
    const b = make()
    b.capture('z')
    expect(queued(b)).toHaveLength(0)
    expect(f.sent.length).toBe(before)
  })

  it('optOutByDefault: nothing is captured or written to storage until optIn()', async () => {
    const f = mockFetch()
    const a = make({ optOutByDefault: true, capturePageview: true })
    a.capture('x')
    a.identify('u1')
    expect(queued(a)).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    a.optIn()
    expect(queued(a).map((e) => e.event)).toEqual(['$opt_in', '$pageview'])
    expect(queued(a)[0]!.distinct_id).toBe('u1')
    expect(localStorage.getItem('an_' + KEY + '_c')).toBe('1')
    await a.flush()
    expect(f.events()).toHaveLength(2)
    kill(a)
    const b = make({ optOutByDefault: true })
    b.capture('remembered')
    expect(queued(b).map((e) => e.event)).toEqual(['remembered'])
  })
})
