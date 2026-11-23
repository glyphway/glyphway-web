import { describe, expect, it, vi } from 'vitest'
import { flags } from '../src/flags'
import { memKV } from '../src/storage'
import type { Glyphway } from '../src/core'

type Body = Record<string, unknown>

const answer = (f: Record<string, { enabled: boolean; variant?: string | null; payload?: unknown }>, extra: Body = {}): Response =>
  new Response(JSON.stringify({ flags: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { key: k, enabled: v.enabled, variant: v.variant ?? null, metadata: v.payload === undefined ? {} : { payload: v.payload } }])), ...extra }))

const client = () => {
  const events: { name: string; props: Body }[] = []
  const props: Body = {}
  let id = 'anon-1'
  let session = 's1'
  let out = false
  const a = {
    getClient: () => ({ host: 'https://e.x', writeKey: 'k', deviceId: 'dev', groups: { company: 'c1' }, identified: false }),
    getDistinctId: () => id,
    hasOptedOut: () => out,
    optIn() { out = false },
    optOut() { out = true },
    getSessionId: () => session,
    capture: (name: string, p: Body) => events.push({ name, props: p }),
    register: (p: Body) => Object.assign(props, p),
    unregister: (k: string) => delete props[k],
    identify: (x: string) => { id = x },
    group: () => undefined,
    reset: () => { id = 'anon-2' },
  } as unknown as Glyphway
  return { a, events, props, session: (s: string) => { session = s } }
}

const settled = () => new Promise((r) => setTimeout(r, 0))

describe('flags', () => {
  it('asks the edge in the shape posthog-js does, and reads the answer', async () => {
    const { a, props } = client()
    const bodies: Body[] = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://e.x/flags?v=2')
      bodies.push(JSON.parse(String(init.body)))
      return answer({ on: { enabled: true, payload: { x: 1 } }, off: { enabled: false }, ab: { enabled: true, variant: 'test' } })
    })
    const f = flags(a, { fetch: fetch as never, storage: memKV(), evaluationContexts: ['web'] })
    await settled()
    expect(bodies[0]).toMatchObject({ token: 'k', distinct_id: 'anon-1', $device_id: 'dev', $anon_distinct_id: 'anon-1', groups: { company: 'c1' }, evaluation_contexts: ['web'] })
    expect(f.getFeatureFlag('ab')).toBe('test')
    expect(f.isFeatureEnabled('on')).toBe(true)
    expect(f.isFeatureEnabled('off')).toBe(false)
    expect(f.isFeatureEnabled('none')).toBeUndefined()
    expect(f.getFeatureFlagPayload('on')).toEqual({ x: 1 })
    expect(f.getFeatureFlagResult('ab')).toEqual({ key: 'ab', enabled: true, variant: 'test', payload: undefined })
    expect(props['$feature/ab']).toBe('test')
    expect(props.$active_feature_flags).toEqual(['on', 'ab'])
  })

  it('reports a read once per flag and value in a session', async () => {
    const { a, events, session } = client()
    const f = flags(a, { fetch: (async () => answer({ ab: { enabled: true, variant: 'test' } })) as never, storage: memKV() })
    await settled()
    f.getFeatureFlag('ab')
    f.getFeatureFlag('ab')
    f.isFeatureEnabled('ab')
    f.getFeatureFlag('ab', { send_event: false })
    expect(events.map((e) => [e.name, e.props.$feature_flag, e.props.$feature_flag_response])).toEqual([['$feature_flag_called', 'ab', 'test']])
    session('s2')
    f.getFeatureFlag('ab')
    expect(events).toHaveLength(2)
  })

  it('keeps the last values when a request fails, and serves them at the next start', async () => {
    const { a } = client()
    const storage = memKV()
    flags(a, { fetch: (async () => answer({ a: { enabled: true } })) as never, storage })
    await settled()
    const f = flags(client().a, { fetch: (async () => { throw new Error('offline') }) as never, storage })
    expect(f.getFeatureFlag('a')).toBe(true)
    await settled()
    expect(f.getFeatureFlag('a')).toBe(true)
  })

  it('lets a newer request decide when an older one answers late', async () => {
    const { a } = client()
    const late: ((r: Response) => void)[] = []
    const fetch = (() => new Promise((resolve) => late.push(resolve))) as never
    const f = flags(a, { fetch, storage: memKV(), manual: true })
    const first = f.reloadFeatureFlags()
    const second = f.reloadFeatureFlags()
    late[1]!(answer({ a: { enabled: true, variant: 'new' } }))
    await second
    late[0]!(answer({ a: { enabled: true, variant: 'old' } }))
    await first
    expect(f.getFeatureFlag('a')).toBe('new')
  })

  it('merges rather than replaces when the edge says it had errors', async () => {
    const { a } = client()
    const storage = memKV()
    let n = 0
    const fetch = (async () => (n++ ? answer({ b: { enabled: true } }, { errorsWhileComputingFlags: true }) : answer({ a: { enabled: true } }))) as never
    const f = flags(a, { fetch, storage, manual: true })
    await f.reloadFeatureFlags()
    await f.reloadFeatureFlags()
    expect([f.getFeatureFlag('a'), f.getFeatureFlag('b')]).toEqual([true, true])
  })

  it('reloads after identify, group and reset, and reset starts a new anonymous id', async () => {
    const { a } = client()
    const bodies: Body[] = []
    const fetch = (async (_: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer({}) }) as never
    flags(a, { fetch, storage: memKV() })
    await settled()
    a.identify('user-1')
    await settled()
    expect(bodies[1]).toMatchObject({ distinct_id: 'user-1', $anon_distinct_id: 'anon-1' })
    a.group('company', 'c2')
    await settled()
    expect(bodies).toHaveLength(3)
    a.reset()
    await settled()
    expect(bodies[3]).toMatchObject({ distinct_id: 'anon-2', $anon_distinct_id: 'anon-2' })
  })

  it('overrides win, bootstrap fills in, and stored values beat bootstrap', async () => {
    const { a, props } = client()
    const storage = memKV()
    const f = flags(a, { fetch: (async () => answer({})) as never, storage, manual: true, bootstrap: { flags: { b: 'v1', off: false }, payloads: { b: 7 } } })
    expect([f.getFeatureFlag('b'), f.getFeatureFlagPayload('b'), f.isFeatureEnabled('off')]).toEqual(['v1', 7, false])
    f.overrideFeatureFlags({ b: 'forced', extra: true })
    expect([f.getFeatureFlag('b'), f.getFeatureFlag('extra'), props['$feature/extra']]).toEqual(['forced', true, true])
    f.overrideFeatureFlags(false)
    expect(f.getFeatureFlag('b')).toBe('v1')
    expect(props['$feature/extra']).toBeUndefined()
  })

  it('tells listeners, and sends the properties it was given', async () => {
    const { a } = client()
    const bodies: Body[] = []
    const fetch = (async (_: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer({ a: { enabled: true } }) }) as never
    const f = flags(a, { fetch, storage: memKV(), manual: true })
    const seen: unknown[] = []
    const off = f.onFeatureFlags((x) => seen.push(x))
    f.setPersonPropertiesForFlags({ plan: 'pro' })
    f.setGroupPropertiesForFlags({ company: { size: 5 } })
    await settled()
    expect(bodies[1]).toMatchObject({ person_properties: { plan: 'pro' }, group_properties: { company: { size: 5 } } })
    expect(seen.length).toBeGreaterThan(0)
    off()
  })

  it('sends nothing while opted out, and asks again on opt-in', async () => {
    const { a } = client()
    a.optOut()
    const fetch = vi.fn(async () => answer({ on: { enabled: true } }))
    const f = flags(a, { fetch: fetch as never, storage: memKV() })
    await settled()
    expect(await f.reloadFeatureFlags()).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    a.optIn()
    await settled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(f.getFeatureFlag('on', { send_event: false })).toBe(true)
  })

  it('reset drops the old person\'s values and stored copy at once', async () => {
    const { a, props } = client()
    const storage = memKV()
    let n = 0
    const fetch = (async () => (++n === 1 ? answer({ ab: { enabled: true, variant: 'test' } }) : Promise.reject(new Error('offline')))) as never
    const f = flags(a, { fetch, storage })
    await settled()
    expect(f.getFeatureFlag('ab', { send_event: false })).toBe('test')
    a.reset()
    expect(f.getFeatureFlag('ab', { send_event: false })).toBeUndefined()
    expect(props['$feature/ab']).toBeUndefined()
    expect(storage.get('an_flags_k')).toBeNull()
    await settled()
  })

  it('stops the timer when the edge is slow', async () => {
    vi.useFakeTimers()
    const { a } = client()
    const fetch = ((_: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as never
    const f = flags(a, { fetch, storage: memKV(), manual: true })
    const done = f.reloadFeatureFlags()
    await vi.advanceTimersByTimeAsync(3000)
    await expect(done).resolves.toBe(false)
    vi.useRealTimers()
  })
})
