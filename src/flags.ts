// Feature flags. A lazy module: `flags(glyphway)` after init.
//
// Values come from the edge and the last ones stay in storage, so a page reads
// them at once and a failed request changes nothing. Reads report
// `$feature_flag_called`, once per flag and value in a session, which is what
// experiments count as exposure.
import type { Glyphway } from './core'
import { memKV, webKV, type KV } from './storage'
import { disabled, emitter } from './feature'
import type { Props } from './types'

export type FlagValue = boolean | string

export interface FlagResult {
  key: string
  enabled: boolean
  variant: string | null
  payload: unknown
}

export interface FlagOptions {
  /** Values to use before the first answer, usually from your server. */
  bootstrap?: { flags?: Record<string, FlagValue>; payloads?: Record<string, unknown> }
  /** Request timeout. Default 3000 ms. */
  timeoutMs?: number
  /** Only flags tagged with one of these, and untagged flags. */
  evaluationContexts?: string[]
  /** Ask for these flags only. */
  flagKeys?: string[]
  /** Skip the first request, for a page that calls `reloadFeatureFlags` itself. */
  manual?: boolean
  storage?: KV
  fetch?: typeof fetch
}

export interface FeatureFlags {
  isFeatureEnabled(key: string, o?: { send_event?: boolean }): boolean | undefined
  getFeatureFlag(key: string, o?: { send_event?: boolean }): FlagValue | undefined
  getFeatureFlagPayload(key: string): unknown
  getFeatureFlagResult(key: string, o?: { send_event?: boolean }): FlagResult | undefined
  /** Resolves true when the edge answered. */
  reloadFeatureFlags(): Promise<boolean>
  /** Called with the flags on every load, and at once if there are any. Returns how to stop. */
  onFeatureFlags(cb: (flags: Record<string, FlagValue>) => void): () => void
  /** Local values above everything else; `false` clears them. */
  overrideFeatureFlags(values: Record<string, FlagValue> | false): void
  setPersonPropertiesForFlags(props: Props, reload?: boolean): void
  setGroupPropertiesForFlags(props: Record<string, Props>, reload?: boolean): void
  stop(): void
  /** @internal Set while the `analytics` feature is off, so no-code actions stay off with it. */
  analyticsOff?: true
}

type Stored = Record<string, { e: boolean; v: string | null; p?: unknown }>

const parse = (s: string | null): Stored => {
  try {
    const v: unknown = s ? JSON.parse(s) : null
    return v && typeof v === 'object' ? (v as Stored) : {}
  } catch {
    return {}
  }
}

export function flags(a: Glyphway, o: FlagOptions = {}): FeatureFlags {
  const off = disabled<FeatureFlags>(a, 'flags', 'flags', { reloadFeatureFlags: async () => false, onFeatureFlags: () => () => {} })
  if (off) return off
  const emit = emitter(a)
  const c = a.getClient()
  const kv = o.storage ?? (typeof localStorage === 'undefined' ? memKV() : webKV('localStorage'))
  const send = o.fetch ?? fetch.bind(globalThis)
  const valuesKey = `an_flags_${c.writeKey}`
  const anonKey = `an_anon_${c.writeKey}`
  let values: Stored = parse(kv.get(valuesKey))
  for (const [k, v] of Object.entries(o.bootstrap?.flags ?? {})) {
    values[k] ??= { e: v !== false, v: typeof v === 'string' ? v : null, p: o.bootstrap?.payloads?.[k] }
  }
  let overrides: Record<string, FlagValue> = {}
  let person: Props = {}
  let groups: Record<string, Props> = {}
  let latest = 0
  const listeners = new Set<(f: Record<string, FlagValue>) => void>()
  const called = new Set<string>()
  const registered = new Set<string>()
  // the id this device first had, which `ensure_continuity` flags bucket by
  if (!kv.get(anonKey)) kv.set(anonKey, a.getDistinctId())

  const valueOf = (k: string): FlagValue | undefined => {
    if (k in overrides) return overrides[k]
    const f = values[k]
    return f ? (f.v ?? f.e) : undefined
  }
  const all = (): Record<string, FlagValue> => {
    const out: Record<string, FlagValue> = {}
    for (const k of Object.keys({ ...values, ...overrides })) out[k] = valueOf(k)!
    return out
  }

  /** `$feature/{key}` and `$active_feature_flags` ride on every event. */
  const publish = (): void => {
    const now = all()
    for (const k of registered) if (!(k in now)) a.unregister(`$feature/${k}`)
    registered.clear()
    const props: Props = { $active_feature_flags: Object.keys(now).filter((k) => now[k] !== false) }
    for (const k of Object.keys(now)) {
      props[`$feature/${k}`] = now[k]
      registered.add(k)
    }
    a.register(props)
    for (const cb of listeners) cb(now)
  }

  const reload = async (): Promise<boolean> => {
    const mine = ++latest
    // an opted-out person sends nothing: not the ids, not a request at all
    if (a.hasOptedOut()) return false
    const live = a.getClient()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 3000)
    try {
      const r = await send(`${live.host}/flags?v=2`, {
        method: 'POST',
        // text/plain keeps this a simple request, with no preflight
        headers: { 'Content-Type': 'text/plain' },
        signal: ctl.signal,
        body: JSON.stringify({
          token: live.writeKey,
          distinct_id: a.getDistinctId(),
          $device_id: live.deviceId,
          $anon_distinct_id: kv.get(anonKey) ?? undefined,
          groups: live.groups,
          person_properties: person,
          group_properties: groups,
          evaluation_contexts: o.evaluationContexts,
          flag_keys: o.flagKeys,
        }),
      })
      if (!r.ok) return false
      const body = (await r.json()) as { flags?: Record<string, { enabled: boolean; variant?: string | null; metadata?: { payload?: unknown } }>; errorsWhileComputingFlags?: boolean }
      // an older request answered late: the newer one decides
      if (mine !== latest || !body.flags) return false
      const next: Stored = body.errorsWhileComputingFlags ? { ...values } : {}
      for (const [k, f] of Object.entries(body.flags)) next[k] = { e: f.enabled, v: f.variant ?? null, p: f.metadata?.payload }
      values = next
      kv.set(valuesKey, JSON.stringify(values))
      publish()
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  const report = (k: string, v: FlagValue | undefined): void => {
    const seen = `${a.getSessionId()}|${k}|${String(v)}`
    if (called.has(seen)) return
    called.add(seen)
    emit('$feature_flag_called', { $feature_flag: k, $feature_flag_response: v ?? null })
  }

  const getFeatureFlag: FeatureFlags['getFeatureFlag'] = (k, opts) => {
    const v = valueOf(k)
    if (opts?.send_event !== false) report(k, v)
    return v
  }

  const stops: (() => void)[] = []
  // who is asking changed, so the answers may have too
  // what was held back while opted out is asked for now
  for (const name of ['identify', 'group', 'reset', 'optIn'] as const) {
    const original = a[name] as (...args: unknown[]) => void
    ;(a as unknown as Record<string, unknown>)[name] = (...args: unknown[]): void => {
      original.apply(a, args)
      if (name === 'reset') {
        person = {}
        groups = {}
        kv.set(anonKey, a.getDistinctId())
        // the new anonymous person must not wear the old person's variants
        values = {}
        called.clear()
        kv.del(valuesKey)
        publish()
      }
      void reload()
    }
    stops.push(() => {
      ;(a as unknown as Record<string, unknown>)[name] = original
    })
  }

  if (Object.keys(values).length) publish()
  if (!o.manual) void reload()

  const api: FeatureFlags = {
    isFeatureEnabled: (k, opts) => {
      const v = getFeatureFlag(k, opts)
      return v === undefined ? undefined : v !== false
    },
    getFeatureFlag,
    getFeatureFlagPayload: (k) => (k in overrides ? undefined : values[k]?.p),
    getFeatureFlagResult: (k, opts) => {
      const v = getFeatureFlag(k, opts)
      if (v === undefined) return undefined
      return { key: k, enabled: v !== false, variant: typeof v === 'string' ? v : null, payload: k in overrides ? undefined : values[k]?.p }
    },
    reloadFeatureFlags: reload,
    onFeatureFlags: (cb) => {
      listeners.add(cb)
      if (Object.keys(values).length) cb(all())
      return () => listeners.delete(cb)
    },
    overrideFeatureFlags: (next) => {
      overrides = next || {}
      publish()
    },
    setPersonPropertiesForFlags: (props, again = true) => {
      person = { ...person, ...props }
      if (again) void reload()
    },
    setGroupPropertiesForFlags: (props, again = true) => {
      for (const [t, p] of Object.entries(props)) groups[t] = { ...groups[t], ...p }
      if (again) void reload()
    },
    stop: () => {
      latest++
      stops.forEach((s) => s())
      listeners.clear()
    },
  }
  // the toolbar reaches the page's flags through this (not an underscore name: separate bundles must agree on it)
  a.flagsModule = api
  if (c.features && !c.features.includes('analytics')) api.analyticsOff = true
  return api
}
