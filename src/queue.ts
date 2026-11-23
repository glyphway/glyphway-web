import type { KV } from './storage'
import type { GlyphwayEvent, Config } from './types'
import { jsonSize, warn } from './util'

/** What the queue needs from its owner. */
export interface QueueHost {
  cfg_: Config
  key_: string
  /** Queue-owner id of this tab (stable for the page's lifetime). */
  tid_: string
  kv_: KV
  out_(): boolean
  log_(...a: unknown[]): void
}

interface Item {
  e: GlyphwayEvent
  n: number
  /** Storage key this item is written under (`an_<key>_q:<tab>:<uuid>`). */
  k: string
}
/** Pre-per-event form of the stored queue (`an_<key>_q`): owner tab id, owner's last write (ms), event. Read once, then removed. */
interface Stored {
  o: string
  t: number
  e: GlyphwayEvent
}
/** An event handed to the browser on unload and not yet known to have arrived. */
interface Sent {
  t: number
  e: GlyphwayEvent
}

const FLUSH_AT = 20 // flush at 20 events
const MAX_BYTES = 1_000_000 // queue bounded 1 MB
const BATCH_EVENTS = 100 // per request (edge cap is 1000)
const BATCH_BYTES = 512 * 1024 // per request (edge cap is 1 MiB)
const UNLOAD_BYTES = 60_000 // keepalive / sendBeacon bodies are capped at 64 KiB
/** Items another tab has not rewritten for this long are adopted (crashed / closed tab). */
export const LEASE = 120_000
/** An unload hand-off nobody confirmed is sent again once it is this old (the server dedupes by uuid)... */
export const RESEND = 30_000
/** ...and forgotten when it is this old. */
export const SENT_TTL = 24 * 3_600_000

const OK = 0
const RETRY = 1
const SPLIT = 2
const DROP = 3

/**
 * Bounded queue mirrored to storage. The in-memory list is authoritative for
 * this tab; storage lets nothing be lost on reload or crash. One small key per
 * event, `an_<key>_q:<tab>:<uuid>`, so a push or a removal costs one storage
 * call, never a rewrite of the queue; a lease key `an_<key>_q:<tab>` holds the
 * tab's last-alive time (refreshed at most every LEASE/4 and while sending). A
 * tab adopts events of its own id (reload) and of tabs whose lease ran out
 * (crashed / closed). Duplicates that can arise are absorbed by `uuid` dedupe
 * server-side. `an_<key>_qs` holds events handed to the browser on unload and
 * not yet confirmed (see `unload_`).
 */
export class Queue {
  q_: Item[] = []
  b_ = 0 // bytes in q_
  t_: ReturnType<typeof setTimeout> | undefined
  fails_ = 0
  busy_: Promise<void> | null = null
  fly_: Set<string> | null = null // uuids of the regular request in flight
  ka_ = 0 // keepalive bytes in flight
  gz_ = true // gzip still allowed (turned off if the edge rejects a gzip body)
  private kv_: KV | undefined // the store the items were last written to
  private lt_ = 0 // when the lease was last written

  constructor(private h_: QueueHost) {}

  private p_(): string {
    // stays "an_": device data, so existing installs keep their queues
    return 'an_' + this.h_.key_ + '_q'
  }

  private put_(x: Item): void {
    const h = this.h_
    x.k = this.p_() + ':' + h.tid_ + ':' + x.e.uuid
    h.kv_.set(x.k, JSON.stringify(x.e))
  }

  /** Write the lease (`force`: now, else if a quarter of it has passed). */
  private lease_(force?: boolean): void {
    const h = this.h_
    const now = Date.now()
    if (!force && now - this.lt_ < LEASE / 4) return
    this.lt_ = now
    h.kv_.set(this.p_() + ':' + h.tid_, String(now))
  }

  /** Mirror item `x` (already in q_) to storage; after the store or the tab id changed (cookieless switch) write them all. */
  private save_(x: Item): void {
    const h = this.h_
    if (h.out_()) return
    if (this.kv_ !== h.kv_) {
      this.kv_ = h.kv_
      for (const y of this.q_) this.put_(y)
      this.lease_(true)
    } else {
      this.put_(x)
      this.lease_()
    }
  }

  private sent_(): Sent[] {
    try {
      const r = JSON.parse(this.h_.kv_.get(this.p_() + 's') || '[]')
      return Array.isArray(r) ? r.filter((x) => x && x.e && x.e.uuid) : []
    } catch {
      return []
    }
  }

  private setSent_(l: Sent[]): void {
    const k = this.p_() + 's'
    if (l.length) this.h_.kv_.set(k, JSON.stringify(l))
    else this.h_.kv_.del(k)
  }

  /**
   * Take over stored items that are ours (reload) or whose owner tab went quiet,
   * and unload hand-offs that nothing confirmed for RESEND ms.
   */
  adopt_(): void {
    const h = this.h_
    if (h.out_()) return
    const kv = h.kv_
    const p = this.p_()
    const now = Date.now()
    const have = new Set(this.q_.map((x) => x.e.uuid))
    const mine = new Set(this.q_.map((x) => x.k))
    const lease: Record<string, number> = {}
    const found: GlyphwayEvent[] = []
    const stale = (tid: string): boolean => tid === h.tid_ || !(now - (lease[tid] ?? 0) <= LEASE)
    const evs: [string, string][] = []
    let legacy = false
    for (const k of kv.keys(p)) {
      if (k === p) legacy = true
      else if (k.startsWith(p + ':') && !mine.has(k)) {
        const r = k.slice(p.length + 1)
        const i = r.indexOf(':')
        if (i < 0) lease[r] = Number(kv.get(k))
        else evs.push([r.slice(0, i), k])
      }
    }
    for (const [tid, k] of evs) {
      if (!stale(tid)) continue
      try {
        const e = JSON.parse(kv.get(k) || '')
        if (e && e.uuid) found.push(e)
      } catch {
        /* unreadable: dropped */
      }
      kv.del(k) // adopted items are written again under this tab's id
    }
    if (legacy) {
      try {
        const r: Stored[] = JSON.parse(kv.get(p) || '[]')
        const keep = (Array.isArray(r) ? r : []).filter((x) => {
          if (!x || !x.e || !x.e.uuid) return false
          if (x.o !== h.tid_ && now - x.t <= LEASE) return true
          found.push(x.e)
          return false
        })
        // a tab still running the old SDK keeps its own rows; what is left is rewritten
        if (keep.length) kv.set(p, JSON.stringify(keep))
        else kv.del(p)
      } catch {
        kv.del(p)
      }
    }
    let n = 0
    found.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
    for (const e of found) {
      if (have.has(e.uuid)) continue
      have.add(e.uuid)
      this.add_(e, jsonSize(e))
      n++
    }
    const sent = this.sent_()
    if (sent.length) {
      const keep: Sent[] = []
      let wait = 0
      for (const x of sent) {
        const age = now - x.t
        if (age > SENT_TTL || have.has(x.e.uuid)) continue
        if (age > RESEND) {
          have.add(x.e.uuid)
          this.add_(x.e, jsonSize(x.e))
          n++
        } else {
          keep.push(x)
          wait = Math.max(wait, RESEND - age)
        }
      }
      if (keep.length !== sent.length) this.setSent_(keep)
      // nothing else will wake an idle page to send them
      if (wait && !this.t_) this.t_ = setTimeout(() => void this.flush(), wait + 1)
    }
    if (n) this.sched_()
  }

  private add_(e: GlyphwayEvent, n: number): void {
    const x: Item = { e, n, k: '' }
    this.q_.push(x)
    this.b_ += n
    this.save_(x)
    while (this.q_.length > this.h_.cfg_.maxQueue || this.b_ > MAX_BYTES) {
      const y = this.q_.shift()!
      this.b_ -= y.n
      this.h_.kv_.del(y.k)
      this.h_.log_('queue full, dropped oldest event', y.e.event)
    }
  }

  private remove_(evs: GlyphwayEvent[]): void {
    const s = new Set(evs.map((e) => e.uuid))
    const keep: Item[] = []
    for (const x of this.q_) {
      if (s.has(x.e.uuid)) this.h_.kv_.del(x.k)
      else keep.push(x)
    }
    this.q_ = keep
    this.b_ = keep.reduce((a, x) => a + x.n, 0)
  }

  push(e: GlyphwayEvent, n: number): void {
    this.add_(e, n)
    if (this.fails_) return // a backoff timer is pending
    if (this.q_.length >= FLUSH_AT) void this.flush()
    else this.sched_()
  }

  private sched_(): void {
    if (!this.t_ && this.q_.length) this.t_ = setTimeout(() => void this.flush(), this.h_.cfg_.flushIntervalMs)
  }

  clear_(): void {
    clearTimeout(this.t_)
    this.t_ = undefined
    this.q_ = []
    this.b_ = 0
    this.kv_ = undefined
    for (const k of this.h_.kv_.keys(this.p_())) this.h_.kv_.del(k)
  }

  flush(): Promise<void> {
    return this.busy_ || (this.busy_ = this.run_().finally(() => (this.busy_ = null)))
  }

  private async run_(): Promise<void> {
    clearTimeout(this.t_)
    this.t_ = undefined
    this.adopt_()
    while (this.q_.length && !this.h_.out_()) {
      const batch: GlyphwayEvent[] = []
      let bytes = 0
      for (const x of this.q_) {
        if (batch.length && (batch.length >= BATCH_EVENTS || bytes + x.n > BATCH_BYTES)) break
        batch.push(x.e)
        bytes += x.n
      }
      if (!this.h_.out_()) this.lease_() // still alive while we work
      const r = await this.post_(batch)
      if (r === RETRY) return this.retry_()
      if (r === SPLIT && batch.length > 1) {
        // one invalid event rejects the whole batch; resend one by one,
        // dropping only the event(s) the edge still refuses.
        for (const e of batch) {
          const r1 = await this.post_([e])
          if (r1 === RETRY) return this.retry_()
          if (r1 !== OK) warn('edge rejected event, dropped:', e.event, e.uuid)
          this.remove_([e])
        }
      } else {
        if (r !== OK) warn('edge rejected batch, dropped', batch.length, 'event(s)')
        this.remove_(batch)
      }
      this.fails_ = 0
    }
  }

  private retry_(): void {
    // backoff 1 s -> 60 s with jitter (equal jitter: [d/2, d)).
    const d = Math.min(60_000, 1000 * 2 ** this.fails_++)
    const ms = d / 2 + (Math.random() * d) / 2
    this.h_.log_('send failed, retry in', Math.round(ms), 'ms')
    this.t_ = setTimeout(() => void this.flush(), ms)
  }

  private async post_(batch: GlyphwayEvent[]): Promise<number> {
    const h = this.h_
    const c = h.cfg_
    const json = JSON.stringify({ batch, sent_at: new Date().toISOString() })
    const hd: Record<string, string> = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + h.key_ }
    let body: BodyInit = json
    this.fly_ = new Set(batch.map((e) => e.uuid))
    const gz = c.compression === 'gzip' && this.gz_ && typeof CompressionStream !== 'undefined'
    if (gz) {
      try {
        body = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
        hd['Content-Encoding'] = 'gzip'
      } catch {
        body = json
      }
    }
    let s = 0
    try {
      s = (await fetch(c.host + '/batch', { method: 'POST', headers: hd, body })).status
    } catch {
      /* network error / CORS: status 0 */
    }
    this.fly_ = null
    h.log_('POST /batch', batch.length, 'event(s) ->', s || 'network error')
    if (s >= 200 && s < 300) return OK
    if (gz && hd['Content-Encoding'] && (s === 400 || s === 415)) {
      // An edge without gzip support answers 400 "invalid JSON": never let
      // that trigger split-and-drop. Turn gzip off for this page and resend.
      this.gz_ = false
      warn('edge refused a gzip body; sending uncompressed')
      return this.post_(batch)
    }
    if (s === 400 || s === 413) return SPLIT
    if (!s || s === 408 || s === 429 || s >= 500) return RETRY
    return DROP // 401 and other 4xx
  }

  /**
   * Page hide / unload: hand everything not already in flight to the browser
   * with `fetch(keepalive)` (simple request: text/plain body + `api_key`, so no
   * preflight), or `sendBeacon` when keepalive is unsupported or its 64 KiB
   * budget is used up. Handed-off events leave the queue and move to the
   * "sent, unconfirmed" key (`an_<key>_qs`): a request that outlives the page
   * cannot report back, so the next page load sends them again once they are
   * RESEND ms old (the server dedupes by `uuid`), unless the response was seen
   * and ok (dropped) or they are SENT_TTL old (dropped). If the page survives
   * and the request fails, they are put back in the queue.
   */
  unload_(): void {
    const h = this.h_
    if (!this.q_.length || h.out_()) return
    const url = h.cfg_.host + '/batch'
    const ka = typeof Request !== 'undefined' && 'keepalive' in Request.prototype && typeof fetch === 'function'
    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    const items = this.q_.filter((x) => !(this.fly_ && this.fly_.has(x.e.uuid)))
    const handed: GlyphwayEvent[] = []
    let i = 0
    while (i < items.length) {
      const chunk: GlyphwayEvent[] = []
      let n = 0
      while (i < items.length && (!chunk.length || n + items[i]!.n < UNLOAD_BYTES)) {
        chunk.push(items[i]!.e)
        n += items[i++]!.n
      }
      const body = JSON.stringify({ api_key: h.key_, batch: chunk, sent_at: new Date().toISOString() })
      let ok = false
      if (ka && this.ka_ + n < UNLOAD_BYTES) {
        try {
          this.ka_ += n
          const back = (): void => {
            this.ka_ -= n
            this.back_(chunk)
          }
          fetch(url, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).then(
            (r) => {
              if (!r.ok) return back()
              this.ka_ -= n
              if (!h.out_()) this.confirm_(chunk)
            },
            back,
          )
          ok = true
        } catch {
          this.ka_ -= n
        }
      }
      if (!ok && nav && nav.sendBeacon) {
        try {
          ok = nav.sendBeacon(url, body)
        } catch {
          ok = false
        }
      }
      h.log_('unload send', chunk.length, 'event(s):', ok ? 'handed off' : 'kept for next flush')
      if (!ok) break
      this.remove_(chunk)
      handed.push(...chunk)
    }
    // Nobody can tell whether a request that outlives the page arrived: keep what was handed
    // over under "sent, unconfirmed"; the next page load sends it again after RESEND ms.
    if (handed.length) this.keepSent_(handed)
  }

  /** Add `evs` to the unconfirmed hand-offs (bounded like the queue). */
  private keepSent_(evs: GlyphwayEvent[]): void {
    const t = Date.now()
    const l = this.sent_()
    for (const e of evs) l.push({ t, e })
    let b = 0
    for (const x of l) b += jsonSize(x.e)
    while (l.length && b > MAX_BYTES) b -= jsonSize(l.shift()!.e)
    this.setSent_(l)
  }

  /** Those events arrived (or are back in the queue): no longer unconfirmed. */
  private confirm_(evs: GlyphwayEvent[]): void {
    const s = new Set(evs.map((e) => e.uuid))
    const l = this.sent_()
    const k = l.filter((x) => !s.has(x.e.uuid))
    if (k.length !== l.length) this.setSent_(k)
  }

  /** A keepalive send failed while the page is still alive: requeue. */
  private back_(evs: GlyphwayEvent[]): void {
    if (this.h_.out_()) return
    this.confirm_(evs)
    const have = new Set(this.q_.map((x) => x.e.uuid))
    for (const e of evs) if (!have.has(e.uuid)) this.add_(e, jsonSize(e))
    this.sched_()
  }
}
