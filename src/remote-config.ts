// Remote Config. A lazy module: `remoteConfig(glyphway)` after init.
//
// The Firebase shape: `fetch` brings values down, `activate` makes them the ones
// `get*` returns, so a screen never changes under the user by itself.
import type { Glyphway } from './core'
import { memKV, webKV, type KV } from './storage'
import { emitter, isOff } from './feature'
import type { Props } from './types'

interface Fetched {
  version: number
  values: Record<string, { value: unknown; type: string }>
  rollouts: { id: number; group: string }[]
  experiments?: { key: string; variant: string }[]
}

export interface RemoteConfigOptions {
  /** Default 12 hours (INV F4). Lower it while developing. */
  minimumFetchIntervalMs?: number
  defaults?: Record<string, unknown>
  /** Request timeout. Default 10000 ms. */
  timeoutMs?: number
  /** Facts for conditions that the SDK can't see. */
  appId?: string
  appBuild?: string
  userProperties?: Props
  storage?: KV
  fetch?: typeof fetch
  eventSource?: typeof EventSource
}

export interface RemoteConfig {
  setDefaults(values: Record<string, unknown>): void
  /** Resolves true when new values came down. Inside the minimum interval it does nothing. */
  fetch(): Promise<boolean>
  /** Resolves true when the active values changed. */
  activate(): Promise<boolean>
  fetchAndActivate(): Promise<boolean>
  getString(key: string): string
  getBool(key: string): boolean
  getNumber(key: string): number
  getJSON<T = unknown>(key: string): T | undefined
  getAll(): Record<string, unknown>
  setCustomSignals(signals: Props): void
  /** Realtime: called after a publish has been fetched, while the page is visible. Returns how to stop. */
  onConfigUpdate(cb: (version: number) => void): () => void
  stop(): void
}

const read = <T>(s: string | null): T | undefined => {
  try {
    return s ? (JSON.parse(s) as T) : undefined
  } catch {
    return undefined
  }
}

export function remoteConfig(a: Glyphway, o: RemoteConfigOptions = {}): RemoteConfig {
  // Off: the same object with no storage, request or stream, so the defaults (and setDefaults) still answer.
  const off = isOff(a, 'remoteConfig', 'remoteConfig()')
  const emit = emitter(a)
  const c = a.getClient()
  const kv = off ? memKV() : o.storage ?? (typeof localStorage === 'undefined' ? memKV() : webKV('localStorage'))
  const send = o.fetch ?? fetch.bind(globalThis)
  const min = o.minimumFetchIntervalMs ?? 12 * 3_600_000
  const base = `an_rc_${c.writeKey}`
  let fetched = read<Fetched>(kv.get(`${base}_f`))
  let active = read<Fetched>(kv.get(`${base}_a`))
  let last = Number(kv.get(`${base}_t`)) || 0
  let defaults: Record<string, unknown> = { ...o.defaults }
  let signals: Props = {}
  const firstOpen = Number(kv.get(`${base}_o`)) || Date.now()
  kv.set(`${base}_o`, String(firstOpen))
  const listeners = new Set<(v: number) => void>()
  let stream: EventSource | undefined
  let poll: ReturnType<typeof setTimeout> | undefined

  const doFetch = async (): Promise<boolean> => {
    // an opted-out person sends nothing, and a request would carry the ids
    if (off || a.hasOptedOut()) return false
    if (Date.now() - last < min) return false
    const live = a.getClient()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 10_000)
    try {
      const d = live.device
      const r = await send(`${live.host}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        signal: ctl.signal,
        body: JSON.stringify({
          api_key: live.writeKey,
          version: fetched?.version ?? 0,
          distinct_id: a.getDistinctId(),
          identified: live.identified,
          installation_id: live.deviceId,
          app_id: o.appId,
          app_build: o.appBuild,
          app_version: live.release,
          os: d.$os,
          os_version: d.$os_version === undefined ? undefined : String(d.$os_version),
          browser: d.$browser,
          browser_version: d.$browser_version === undefined ? undefined : String(d.$browser_version),
          device_type: d.$device_type,
          language: d.$locale,
          first_open_ms: firstOpen,
          user_properties: o.userProperties,
          custom_signals: signals,
        }),
      })
      if (!r.ok) return false
      const body = (await r.json()) as { version: number; state: string; values?: Fetched['values']; rollouts?: Fetched['rollouts']; experiments?: Fetched['experiments'] }
      last = Date.now()
      kv.set(`${base}_t`, String(last))
      if (body.state !== 'UPDATE') return false
      fetched = { version: body.version, values: body.values ?? {}, rollouts: body.rollouts ?? [], experiments: body.experiments }
      kv.set(`${base}_f`, JSON.stringify(fetched))
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  const activate = async (): Promise<boolean> => {
    if (!fetched || fetched.version === active?.version) return false
    active = fetched
    kv.set(`${base}_a`, JSON.stringify(active))
    for (const r of active.rollouts ?? []) emit('$rc_rollout', { $rollout_id: r.id, $rollout_group: r.group })
    for (const e of active.experiments ?? []) emit('$feature_flag_called', { $feature_flag: e.key, $feature_flag_response: e.variant })
    return true
  }

  const value = (k: string): unknown => {
    const v = active?.values?.[k]
    return v && typeof v === 'object' ? v.value : defaults[k]
  }

  const update = async (version: number): Promise<void> => {
    if (version <= (fetched?.version ?? 0)) return
    if (await doFetch()) for (const cb of listeners) cb(fetched!.version)
  }

  const close = (): void => {
    stream?.close()
    stream = undefined
    clearTimeout(poll)
  }
  const open = (): void => {
    const ES = o.eventSource ?? (typeof EventSource === 'undefined' ? undefined : EventSource)
    if (off || !ES || stream || !listeners.size || a.hasOptedOut()) return
    const live = a.getClient()
    const s = new ES(`${live.host}/config/stream?api_key=${encodeURIComponent(live.writeKey)}`)
    stream = s
    s.onmessage = (e): void => {
      const v = read<{ version: number }>(String(e.data))
      if (v) void update(v.version)
    }
    s.onerror = (): void => {
      // the edge's limit is 503, which ends the stream: fall back to polling
      if (s.readyState !== 2) return
      stream = undefined
      poll = setTimeout(() => {
        void update(Number.MAX_SAFE_INTEGER)
        open()
      }, min)
    }
  }
  // foreground only (INV F4)
  const visible = (): void => (document.visibilityState === 'visible' ? open() : close())
  const hasDoc = typeof document !== 'undefined'
  // consent changed: no stream while opted out, and one again after opt-in
  const originals = { optIn: a.optIn, optOut: a.optOut }
  a.optIn = function (this: Glyphway): void {
    originals.optIn.call(this)
    if (!hasDoc || document.visibilityState === 'visible') open()
  }
  a.optOut = function (this: Glyphway): void {
    originals.optOut.call(this)
    close()
  }
  const unwrap = (): void => {
    a.optIn = originals.optIn
    a.optOut = originals.optOut
  }

  return {
    setDefaults: (v) => {
      defaults = { ...v }
    },
    fetch: doFetch,
    activate,
    fetchAndActivate: async () => {
      await doFetch()
      return activate()
    },
    getString: (k) => {
      const v = value(k)
      return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    },
    getBool: (k) => {
      const v = value(k)
      return v === true || v === 1 || (typeof v === 'string' && ['1', 'true', 't', 'yes', 'y', 'on'].includes(v.toLowerCase()))
    },
    getNumber: (k) => {
      const n = Number(value(k))
      return Number.isFinite(n) ? n : 0
    },
    getJSON: <T,>(k: string): T | undefined => {
      const v = value(k)
      return (typeof v === 'string' ? read<T>(v) : (v as T)) ?? undefined
    },
    getAll: () => {
      const out: Record<string, unknown> = { ...defaults }
      for (const [k, v] of Object.entries(active?.values ?? {})) if (v && typeof v === 'object') out[k] = v.value
      return out
    },
    setCustomSignals: (s) => {
      signals = { ...signals, ...s }
    },
    onConfigUpdate: (cb) => {
      if (off) return () => {}
      listeners.add(cb)
      if (hasDoc && listeners.size === 1) addEventListener('visibilitychange', visible)
      if (!hasDoc || document.visibilityState === 'visible') open()
      return () => {
        listeners.delete(cb)
        if (!listeners.size) {
          close()
          if (hasDoc) removeEventListener('visibilitychange', visible)
        }
      }
    },
    stop: () => {
      listeners.clear()
      close()
      unwrap()
      if (hasDoc) removeEventListener('visibilitychange', visible)
    },
  }
}
