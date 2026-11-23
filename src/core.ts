import { Queue } from './queue'
import { memKV, webKV, type KV } from './storage'
import type { GlyphwayEvent, Config, Feature, Options, Props } from './types'
import { parseUA } from './ua'
import { jsonSize, uuidv7, warn } from './util'

declare const __VERSION__: string
export const VERSION: string = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0-dev'

const IDLE = 30 * 60_000 // 30 min without a captured event
const MAX_SESSION = 24 * 3_600_000 // 24 h cap
const MAX_EVENT = 1_000_000 // an event the edge could never accept (1 MiB body cap)
const CAMPAIGN = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'msclkid', 'ttclid']
// posthog-js refuses ids like these: they are almost always a bug in the caller.
const BAD_ID = /^(undefined|null|0|nan|none|true|false|anonymous|guest|id|distinct_?id|not_authenticated|email|\[object object\]|\[\]|\{\})$/i

// Where this script came from, so the toolbar script can be fetched from beside it.
const HERE = typeof document !== 'undefined' && document.currentScript ? (document.currentScript as HTMLScriptElement).src : ''

const okId = (id: unknown): id is string =>
  typeof id === 'string' && !!id.trim() && id.length <= 200 && !BAD_ID.test(id.trim())

/** Persisted under `an_<writeKey>` (short keys keep storage small). */
interface State {
  d: string // distinct id
  v: string // $device_id (stable install id, survives reset())
  i?: 1 // identified
  p: Props // super properties
  g: Record<string, string> // groups
  s?: string // $session_id
  ss?: number // session start ms
  sl?: number // last captured event ms
}

/** What the full build adds to page changes. */
export interface PageHook {
  /** Properties describing the page being left. */
  leave(): Props
  /** A new page began. */
  enter(): void
  /** Send what's buffered, before the queue is handed to the browser. */
  flush(): void
}

/** Optional module installed at init (autocapture); returns its teardown. */
export type Plugin = (a: Glyphway) => () => void
let plugin: Plugin | undefined
export const setAutocapture = (p: Plugin): void => {
  plugin = p
}

// SPA navigation: `history` is patched once per page; instances subscribe.
const navs = new Set<() => void>()
let patched = false
function patchHistory(): void {
  if (patched) return
  patched = true
  const fire = (): void => navs.forEach((f) => f())
  const h = history
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = h[m]
    h[m] = function (this: History, ...a: Parameters<History['pushState']>) {
      const r = orig.apply(this, a)
      fire()
      return r
    }
  }
  addEventListener('popstate', fire)
}

const setOps = (set?: Props, setOnce?: Props): Props => ({
  ...(set && { $set: set }),
  ...(setOnce && { $set_once: setOnce }),
})

export class Glyphway {
  /** @internal */
  cfg_!: Config
  /** @internal */
  key_ = ''
  /** Queue-owner id: the tab's window id when this page loaded. */
  /** @internal */
  tid_ = ''
  /** @internal */
  wid_ = ''
  /** @internal */
  kv_: KV = memKV()
  /** @internal */
  ss_: KV = memKV()
  /** @internal */
  q_!: Queue
  /** @internal */
  st_!: State
  /** @internal */
  on_ = false
  /** @internal */
  base_: Props = {}
  /** @internal */
  camp_: Props | null = null
  /** @internal */
  url_ = ''
  /** @internal */
  path_ = ''
  /** @internal */
  acc_ = 0 // engaged ms on the current page
  /** @internal */
  since_: number | null = null // engaged since (ms), null while not engaged
  /** @internal */
  foc_ = true
  /** @internal */
  left_ = false
  /** @internal */
  pv_ = false
  /** @internal */
  off_: (() => void)[] = []
  /** The features that run; undefined means all (the default). */
  /** @internal */
  feat_?: Feature[]
  /** Methods already warned about while their feature is off. */
  /** @internal */
  sk_ = new Set<string>()

  /** @internal */
  pg_?: PageHook
  /** Cookieless mode is in effect (nothing is stored). */
  /** @internal */
  cl_ = false
  /** The project's switches from the edge: undefined while loading, null when they could not be read. */
  /** @internal */
  ps_: Record<string, unknown> | null | undefined
  /** Cookieless events waiting for the project's answer. */
  /** @internal */
  hold_: { event: string; props?: Props | null }[] = []

  init(writeKey: string, options: Options): void {
    if (this.on_) return warn('init() called twice; ignored')
    if (!writeKey || !options || !options.host) return warn('init(writeKey, { host }) needs both')
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const c: Config = (this.cfg_ = {
      release: '',
      debug: false,
      autocapture: true,
      heatmaps: true,
      deadClicks: true,
      enhancedMeasurement: true,
      capturePageview: true,
      capturePageleave: true,
      persistence: 'localStorage',
      projectSettings: true,
      optOutByDefault: false,
      toolbarUrl: '',
      flushIntervalMs: 10_000,
      maxQueue: 1000,
      compression: 'gzip',
      ...options,
      host: options.host.replace(/\/+$/, ''),
    })
    if (options.capturePageleave === undefined) c.capturePageleave = c.capturePageview
    this.key_ = writeKey
    this.on_ = true
    this.feat_ = undefined
    if (Array.isArray(options.features)) {
      this.feat_ = options.features.slice()
      if (!this.feat_.length) warn('features is empty: nothing is sent except identity calls')
    }
    if (this.has_('analytics')) this.tb_()
    // 'on_reject': a rejection remembered by an earlier visit also starts this one cookieless
    this.cl_ = c.cookielessMode === 'always' || (c.cookielessMode === 'on_reject' && webKV('localStorage').get(this.k_() + '_c') === '0')
    const mem = c.persistence === 'memory' || this.cl_
    this.kv_ = mem ? memKV() : webKV('localStorage')
    this.ss_ = mem ? memKV() : webKV('sessionStorage')

    let st: State | null = null
    try {
      st = JSON.parse(this.kv_.get(this.k_()) || 'null')
    } catch {
      /* corrupt: start over */
    }
    if (!st || typeof st.d !== 'string') {
      const d = uuidv7()
      st = { d, v: d, p: {}, g: {} }
    }
    st.p = st.p || {}
    st.g = st.g || {}
    st.v = st.v || st.d
    this.st_ = st

    // $window_id per tab. A duplicated tab copies sessionStorage, including the
    // "primary" flag (removed on pagehide), so a set flag means "new tab".
    const wk = this.k_() + '_w'
    const w = this.ss_.get(wk)
    this.tid_ = this.wid_ = w && !this.ss_.get(wk + 'p') ? w : uuidv7()
    this.save_()
    this.saveW_()

    const n = navigator
    const d = document
    const l = location
    let tz: string | undefined
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      /* ignore */
    }
    let rd = '$direct'
    try {
      if (d.referrer) rd = new URL(d.referrer).host
    } catch {
      /* ignore */
    }
    this.base_ = {
      ...parseUA(n.userAgent, n.maxTouchPoints),
      $locale: n.language,
      $timezone: tz,
      $referrer: d.referrer || '$direct',
      $referring_domain: rd,
    }
    // UTMs and click ids of the landing page: attached until the first SPA route change.
    const q = new URLSearchParams(l.search)
    const camp: Props = {}
    for (const k of CAMPAIGN) {
      const v = q.get(k)
      if (v) camp[k] = v
    }
    this.camp_ = Object.keys(camp).length ? camp : null

    this.q_ = new Queue(this)
    this.q_.adopt_()

    const on = (t: EventTarget, type: string, fn: (e: Event) => void): void => {
      t.addEventListener(type, fn)
      this.off_.push(() => t.removeEventListener(type, fn))
    }
    this.url_ = l.href
    this.path_ = l.pathname
    this.foc_ = !d.hasFocus || d.hasFocus()
    this.eng_()
    on(d, 'visibilitychange', () => {
      this.eng_()
      if (d.visibilityState === 'hidden') {
        this.pg_?.flush()
        this.q_.unload_()
      } else this.sess_()
    })
    on(window, 'focus', () => {
      this.foc_ = true
      this.eng_()
    })
    on(window, 'blur', () => {
      this.foc_ = false
      this.eng_()
    })
    on(window, 'pagehide', () => {
      this.pg_?.flush()
      this.leave_()
      this.ss_.del(wk + 'p')
      this.q_.unload_()
    })
    on(window, 'pageshow', (e) => {
      if (!(e as PageTransitionEvent).persisted) return
      // Restored from the back/forward cache: a new page view begins.
      this.saveW_()
      this.left_ = false
      this.acc_ = 0
      this.eng_()
      this.url_ = location.href
      this.path_ = location.pathname
      this.sess_()
      if (c.capturePageview) this.pageview_()
    })
    on(window, 'online', () => {
      this.q_.fails_ = 0
      void this.q_.flush()
    })
    patchHistory()
    const nav = (): void => this.nav_()
    navs.add(nav)
    this.off_.push(() => navs.delete(nav))
    if (plugin && this.has_('analytics')) this.off_.push(plugin(this))
    this.settings_()
    this.sess_()
    if (c.capturePageview) this.pageview_()
  }

  /** @internal */
  has_(f: Feature): boolean {
    return !this.feat_ || this.feat_.includes(f)
  }

  /** The modules call this when they are started while their feature is off: one debug warning per method. */
  /** @internal */
  skip(f: Feature, m: string): void {
    if (this.cfg_.debug && !this.sk_.has(m)) {
      this.sk_.add(m)
      warn(`${m} ignored: the ${f} feature is off`)
    }
  }

  /**
   * Keeps the session going while `analytics` is off (no pageview or lifecycle event does it): a page load,
   * the page becoming visible. A new session sends `$session_start` (see `sid_`). With no features at all, nothing.
   * @internal
   */
  sess_(): void {
    if (this.feat_ && this.feat_.length && !this.has_('analytics') && !this.out_()) this.sid_(Date.now(), true)
  }

  /**
   * Where the SDK's own modules (errors, flags, surveys...) send their events. Unlike `capture()` it works while
   * the `analytics` feature is off.
   * @internal
   */
  emit(event: string, props?: Props): void {
    if (this.on_) this.capture_(event, props)
  }

  /** The project's switches. Events made before the answer are kept only when it needs no waiting. */
  /** @internal */
  settings_(): void {
    const c = this.cfg_
    if (c.projectSettings === false || typeof fetch !== 'function') return void (this.ps_ = null)
    const done = (v: Record<string, unknown> | null): void => {
      this.ps_ = v
      const held = this.hold_.splice(0)
      if (v?.cookieless_mode === true) held.forEach((h) => this.capture_(h.event, h.props))
    }
    try {
      void fetch(`${c.host}/array/${encodeURIComponent(this.key_)}/config`)
        .then((r) => r.json())
        .then((j: { webSdk?: Record<string, unknown> | null }) => done(j && j.webSdk && typeof j.webSdk === 'object' ? j.webSdk : {}))
        .catch(() => done(null))
    } catch {
      done(null)
    }
  }

  /** Switch between cookieless (memory only, fresh identity) and normal storage, for `cookielessMode: 'on_reject'`. */
  /** @internal */
  cookieless_(on: boolean): void {
    if (this.cl_ === on) return
    this.cl_ = on
    const mem = on || this.cfg_.persistence === 'memory'
    this.kv_ = mem ? memKV() : webKV('localStorage')
    this.ss_ = mem ? memKV() : webKV('sessionStorage')
    const d = uuidv7()
    this.st_ = on ? { d, v: d, p: {}, g: {} } : this.st_
    if (!on) {
      this.kv_.set(this.k_() + '_c', '1') // consent given again: the stored identity is read back
      this.load_()
    }
    this.wid_ = this.tid_ = uuidv7()
  }

  // ------------------------------------------------------------- public API

  capture(event: string, properties?: Props): void {
    if (!this.ready_()) return
    if (this.has_('analytics')) this.capture_(event, properties)
    else this.skip('analytics', 'capture()')
  }

  /**
   * Link this device's anonymous id to `id` (`$identify` with `$anon_distinct_id`).
   * Called again with the same id, only `$set` / `$set_once` are sent.
   */
  identify(id: string, set?: Props, setOnce?: Props): void {
    if (!this.ready_()) return
    if (!okId(id)) return warn('identify(): invalid distinct id', id)
    const s = this.load_()
    const prev = s.d
    if (id !== prev) {
      const anon = !s.i
      s.d = id
      s.i = 1
      this.save_()
      // posthog-js: only an anonymous -> identified change links ids. Switching
      // between two identified ids without reset() just changes the id.
      if (anon) return this.capture_('$identify', { $anon_distinct_id: prev, ...setOps(set, setOnce) })
    }
    if (set || setOnce) this.capture_('$set', setOps(set, setOnce))
  }

  /** Person properties without changing identity (`$set` event). */
  setPersonProperties(set?: Props, setOnce?: Props): void {
    if (this.ready_() && (set || setOnce)) this.capture_('$set', setOps(set, setOnce))
  }

  /** Merge `alias` into the current distinct id (`$create_alias`). */
  alias(alias: string): void {
    if (!this.ready_()) return
    if (!okId(alias)) return warn('alias(): invalid id', alias)
    if (alias === this.load_().d) return this.identify(alias)
    this.capture_('$create_alias', { alias })
  }

  /** Put later events in a group (`$groups`); sends `$groupidentify` when the group is new or props are given. */
  group(type: string, key: string | number, props?: Props): void {
    if (!this.ready_()) return
    if (!type || key == null || key === '') return warn('group(): type and key are required')
    const k = String(key)
    const s = this.load_()
    const changed = s.g[type] !== k
    s.g = { ...s.g, [type]: k }
    this.save_()
    if (changed || props) this.capture_('$groupidentify', { $group_type: type, $group_key: k, $group_set: props || {} })
  }

  /** New anonymous id, new session, super properties and groups cleared. `$device_id` is kept unless asked. */
  reset(resetDeviceId?: boolean): void {
    if (!this.ready_()) return
    const now = Date.now()
    const d = uuidv7()
    this.st_ = { d, v: resetDeviceId ? d : this.load_().v, p: {}, g: {}, s: uuidv7(), ss: now, sl: now }
    this.wid_ = uuidv7()
    this.save_()
    this.saveW_()
    this.started_()
  }

  /** Super properties: sent with every later event (event properties win). */
  register(props: Props): void {
    if (!this.ready_()) return
    const s = this.load_()
    s.p = { ...s.p, ...props }
    this.save_()
  }

  unregister(name: string): void {
    if (!this.ready_()) return
    const s = this.load_()
    delete s.p[name]
    this.save_()
  }

  optIn(): void {
    if (!this.ready_()) return
    if (this.cfg_.cookielessMode === 'on_reject' && this.cl_) {
      this.cookieless_(false)
    }
    this.kv_.set(this.k_() + '_c', '1')
    this.save_()
    this.saveW_()
    this.capture_('$opt_in')
    if (this.cfg_.capturePageview && !this.pv_) this.pageview_()
  }

  /** Stop capturing and clear the queue (memory and storage). Remembered. */
  optOut(): void {
    if (!this.ready_()) return
    // the rejection is remembered in real storage even when cookieless mode follows
    if (this.cfg_.cookielessMode === 'on_reject') webKV('localStorage').set(this.k_() + '_c', '0')
    this.kv_.set(this.k_() + '_c', '0')
    this.q_.clear_()
    if (this.cfg_.cookielessMode === 'on_reject') this.cookieless_(true)
  }

  hasOptedOut(): boolean {
    return this.on_ && this.out_()
  }

  /** Send everything queued now. */
  flush(): Promise<void> {
    return this.on_ ? this.q_.flush() : Promise.resolve()
  }

  getDistinctId(): string {
    return this.on_ ? this.load_().d : ''
  }

  getSessionId(): string {
    return this.on_ ? this.sid_(Date.now(), false) : ''
  }

  /** What lazy modules need to reach the edge as this client. */
  getClient(): { host: string; writeKey: string; deviceId: string; groups: Record<string, string>; identified: boolean; release?: string; device: Props; features?: Feature[]; debug?: boolean } {
    const s = this.load_()
    return { host: this.cfg_.host, writeKey: this.key_, deviceId: s.v, groups: s.g, identified: !!s.i, release: this.cfg_.release, device: this.base_, features: this.feat_, debug: this.cfg_.debug }
  }

  // ------------------------------------------------------------- internals

  /**
   * `#an_toolbar=<token>&an_api=<box>` opens the toolbar. Both are taken out of
   * the address before anything is sent, then the toolbar script loads and gets the token.
   * @internal
   */
  tb_(): void {
    const q = new URLSearchParams(location.hash.slice(1))
    const token = q.get('an_toolbar')
    if (token === null) return
    const api = q.get('an_api') || ''
    q.delete('an_toolbar')
    q.delete('an_api')
    const rest = q.toString()
    history.replaceState(history.state, '', location.pathname + location.search + (rest ? '#' + rest : ''))
    const events: GlyphwayEvent[] = []
    const prev = this.cfg_.beforeSend
    this.cfg_.beforeSend = (e) => {
      const r = prev ? prev(e) : e
      if (r && events.push(r) > 100) events.shift()
      return r
    }
    const s = document.createElement('script')
    s.src = this.cfg_.toolbarUrl || (HERE ? HERE.replace(/[^/]*$/, '') : this.cfg_.host + '/') + 'glyphway.toolbar.js'
    s.onload = () => (window as unknown as { glyphwayToolbar?: { toolbar(a: Glyphway, o: unknown): void } }).glyphwayToolbar?.toolbar(this, { token, api, events })
    document.head.append(s)
  }

  /** The page's flags module once started; the toolbar overrides flags through it. */
  flagsModule?: { overrideFeatureFlags(values: Record<string, boolean | string> | false): void }

  /** @internal */
  ready_(): boolean {
    if (!this.on_) warn('call init() first')
    return this.on_
  }

  /** @internal */
  log_(...a: unknown[]): void {
    if (this.cfg_ && this.cfg_.debug) console.log('[glyphway]', ...a)
  }

  /** @internal */
  k_(): string {
    // stays "an_": device data, so existing installs keep their ids
    return 'an_' + this.key_
  }

  /** @internal */
  out_(): boolean {
    if (this.cl_) return false
    const c = this.kv_.get(this.k_() + '_c')
    return c === '0' || (c !== '1' && this.cfg_.optOutByDefault)
  }

  /** Fresh read, so identity/session changes made by other tabs are seen. */
  /** @internal */
  load_(): State {
    if (!this.out_()) {
      try {
        const r = JSON.parse(this.kv_.get(this.k_()) || 'null')
        if (r && typeof r.d === 'string') {
          r.p = r.p || {}
          r.g = r.g || {}
          r.v = r.v || r.d
          this.st_ = r
        }
      } catch {
        /* keep memory copy */
      }
    }
    return this.st_
  }

  /** Nothing is written while opted out (consent excepted). */
  /** @internal */
  save_(): void {
    if (!this.out_()) this.kv_.set(this.k_(), JSON.stringify(this.st_))
  }

  /** @internal */
  saveW_(): void {
    if (this.out_()) return
    const k = this.k_() + '_w'
    this.ss_.set(k, this.wid_)
    this.ss_.set(k + 'p', '1')
  }

  /** Current `$session_id`, rotated after 30 min idle or 24 h. `touch` counts as activity. */
  /** @internal */
  sid_(now: number, touch: boolean): string {
    const s = this.load_()
    let dirty = touch
    let fresh = false
    if (!s.s || now - (s.sl || 0) > IDLE || now - (s.ss || 0) > MAX_SESSION) {
      s.s = uuidv7()
      s.ss = s.sl = now
      dirty = true
      fresh = true
    }
    if (touch) s.sl = now
    if (dirty) this.save_()
    if (fresh) this.started_()
    return s.s
  }

  /** A session began: while `analytics` is off nothing else tells the server, so say it, before the event that caused it. */
  /** @internal */
  started_(): void {
    if (this.feat_ && this.feat_.length && !this.has_('analytics')) this.capture_('$session_start')
  }

  /** @internal */
  capture_(event: string, props?: Props | null): void {
    if (this.out_()) return
    if (typeof event !== 'string' || !event || event.length > 200) return warn('invalid event name; dropped:', event)
    const ps = this.ps_
    if (ps) {
      // a project that switched a feature off keeps its events out even from an older page
      const off = event === '$autocapture' || event === '$rageclick' ? ps.autocapture : event === '$dead_click' ? ps.dead_clicks : event === '$$heatmap' ? ps.heatmaps : undefined
      if (off === false) return this.log_('switched off in project settings:', event)
    }
    if (this.cl_) {
      // the project has to allow cookieless events: wait for its answer, drop when it says no or cannot be read
      if (ps === undefined) {
        if (this.hold_.length < 100) this.hold_.push({ event, props })
        return
      }
      if (this.cfg_.projectSettings !== false && (!ps || ps.cookieless_mode !== true)) return this.log_('cookieless mode is off in project settings:', event)
      props = { ...props, $cookieless_mode: true }
    }
    const now = Date.now()
    const s = this.load_()
    const sid = this.sid_(now, true)
    const l = location
    const w = window
    const scr = w.screen
    const p: Props = {
      ...this.base_,
      $device_id: s.v,
      $current_url: l.href,
      $host: l.host,
      $pathname: l.pathname,
      $screen_width: scr && scr.width,
      $screen_height: scr && scr.height,
      $viewport_width: w.innerWidth,
      $viewport_height: w.innerHeight,
      ...this.camp_,
      ...s.p,
      ...(Object.keys(s.g).length && { $groups: s.g }),
      ...props,
      ...(this.cfg_.release && { $app_version: this.cfg_.release }),
      $lib: 'web',
      $lib_version: VERSION,
      $session_id: sid,
      $window_id: this.wid_,
    }
    if (this.cfg_.debug) p.$debug = true
    let e: GlyphwayEvent | null | undefined = {
      event,
      distinct_id: s.d,
      uuid: uuidv7(),
      timestamp: new Date(now).toISOString(),
      properties: p,
    }
    const bs = this.cfg_.beforeSend
    if (bs) {
      try {
        e = bs(e)
      } catch (err) {
        return warn('beforeSend threw; event dropped', err)
      }
      if (!e) return this.log_('dropped by beforeSend:', event)
      // validate client-side so one bad event never poisons a batch.
      if (
        typeof e.event !== 'string' ||
        !e.event ||
        e.event.length > 200 ||
        typeof e.distinct_id !== 'string' ||
        !e.distinct_id ||
        e.distinct_id.length > 200 ||
        !e.properties ||
        typeof e.properties !== 'object'
      )
        return warn('beforeSend returned an invalid event; dropped:', event)
    }
    let n: number
    try {
      n = jsonSize(e)
    } catch {
      return warn('event is not JSON-serialisable; dropped:', event)
    }
    if (n > MAX_EVENT) return warn('event larger than 1 MB; dropped:', event)
    this.log_('capture', e)
    this.q_.push(e, n)
  }

  /** @internal */
  pageview_(): void {
    if (this.out_() || !this.has_('analytics')) return
    this.pv_ = true
    this.capture_('$pageview', { title: document.title, ...this.pg_?.leave() })
    this.pg_?.enter()
  }

  /** History change: `$pageleave` for the old path, then `$pageview` (pathname changes only, as posthog-js). */
  /** @internal */
  nav_(): void {
    const l = location
    const c = this.cfg_
    if (l.pathname === this.path_) {
      this.url_ = l.href
      return
    }
    const ms = this.take_()
    if (c.capturePageleave && this.has_('analytics')) this.capture_('$pageleave', { $engagement_ms: ms, $current_url: this.url_, $pathname: this.path_, ...this.pg_?.leave() })
    this.camp_ = null
    this.url_ = l.href
    this.path_ = l.pathname
    if (c.capturePageview) this.pageview_()
  }

  /** @internal */
  leave_(): void {
    if (!this.cfg_.capturePageleave || this.left_ || !this.has_('analytics')) return
    this.left_ = true
    this.capture_('$pageleave', { $engagement_ms: this.take_(), ...this.pg_?.leave() })
  }

  /** Accumulate engaged time (page visible AND window focused). */
  /** @internal */
  eng_(): void {
    const now = Date.now()
    if (this.since_ != null) this.acc_ += now - this.since_
    this.since_ = document.visibilityState === 'visible' && this.foc_ ? now : null
  }

  /** @internal */
  take_(): number {
    this.eng_()
    const v = this.acc_
    this.acc_ = 0
    return v
  }

  /** Remove listeners and timers (tests, hot reload). The instance can be init()ed again. */
  /** @internal */
  teardown_(): void {
    this.off_.forEach((f) => f())
    this.off_ = []
    if (this.q_) clearTimeout(this.q_.t_)
    this.on_ = false
  }
}
