import { describe, expect, it, vi } from 'vitest'
import { KEY, kill, make, queued, useEnv } from './helpers'

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const state = () => JSON.parse(localStorage.getItem('an_' + KEY)!)

describe('identity', () => {
  useEnv()

  it('creates an anonymous UUIDv7 distinct id, persisted under an_ keys, stable across reloads', () => {
    const a = make()
    const anon = a.getDistinctId()
    expect(anon).toMatch(UUID7)
    expect(state().d).toBe(anon)
    expect(state().v).toBe(anon) // $device_id = first anon id (posthog-js)
    expect(Object.keys(localStorage).every((k) => k.startsWith('an_'))).toBe(true)
    expect(Object.keys(sessionStorage).every((k) => k.startsWith('an_'))).toBe(true)
    kill(a)
    expect(make().getDistinctId()).toBe(anon)
  })

  it('identify() sends $identify with $anon_distinct_id, $set and $set_once, then uses the new id', () => {
    const a = make()
    const anon = a.getDistinctId()
    a.capture('before')
    a.identify('user-42', { plan: 'pro' }, { first_seen: 'x' })
    a.capture('after')
    const [before, ident, after] = queued(a)
    expect(before!.distinct_id).toBe(anon)
    expect(ident!.event).toBe('$identify')
    expect(ident!.distinct_id).toBe('user-42')
    expect(ident!.properties).toMatchObject({ $anon_distinct_id: anon, $set: { plan: 'pro' }, $set_once: { first_seen: 'x' } })
    expect(after!.distinct_id).toBe('user-42')
    expect(after!.properties.$device_id).toBe(anon)
    expect(a.getDistinctId()).toBe('user-42')
    expect(state().i).toBe(1)
  })

  it('identify() with the same id only sends $set; no second $identify', () => {
    const a = make()
    a.identify('u1')
    a.identify('u1')
    a.identify('u1', { name: 'Ada' })
    expect(queued(a).map((e) => e.event)).toEqual(['$identify', '$set'])
    expect(queued(a)[1]!.properties.$set).toEqual({ name: 'Ada' })
  })

  it('switching between identified ids does not link them (posthog-js); reset() first is the intended flow', () => {
    const a = make()
    a.identify('u1')
    a.identify('u2')
    expect(queued(a).map((e) => e.event)).toEqual(['$identify'])
    expect(a.getDistinctId()).toBe('u2')
    a.reset()
    const anon2 = a.getDistinctId()
    a.identify('u3')
    expect(queued(a).at(-1)!.properties.$anon_distinct_id).toBe(anon2)
  })

  it('rejects junk ids', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = make()
    const anon = a.getDistinctId()
    for (const bad of ['', '  ', 'undefined', 'null', 'anonymous', '[object Object]', 'x'.repeat(201)]) a.identify(bad)
    a.identify(42 as unknown as string)
    expect(queued(a)).toHaveLength(0)
    expect(a.getDistinctId()).toBe(anon)
    expect(warn).toHaveBeenCalled()
  })

  it('reset() gives a new anon id and session, clears super props and groups, keeps $device_id', () => {
    const a = make()
    const anon = a.getDistinctId()
    a.register({ app: 'shop' })
    a.group('company', 'acme')
    a.identify('u1')
    const sid = a.getSessionId()
    a.reset()
    a.capture('after')
    const e = queued(a).at(-1)!
    expect(e.distinct_id).toMatch(UUID7)
    expect(e.distinct_id).not.toBe(anon)
    expect(e.distinct_id).not.toBe('u1')
    expect(e.properties.$session_id).not.toBe(sid)
    expect(e.properties.app).toBeUndefined()
    expect(e.properties.$groups).toBeUndefined()
    expect(e.properties.$device_id).toBe(anon)
    a.reset(true)
    a.capture('after2')
    expect(queued(a).at(-1)!.properties.$device_id).toBe(a.getDistinctId())
  })

  it('alias() sends $create_alias with properties.alias from the current id', () => {
    const a = make()
    a.identify('u1')
    a.alias('u1-old-crm-id')
    const e = queued(a).at(-1)!
    expect(e.event).toBe('$create_alias')
    expect(e.distinct_id).toBe('u1')
    expect(e.properties.alias).toBe('u1-old-crm-id')
  })

  it('group() sends $groupidentify and later events carry $groups', () => {
    const a = make()
    a.group('company', 'acme', { name: 'Acme Inc' })
    a.group('company', 'acme') // unchanged, no props: no event
    a.group('team', 7)
    a.capture('x')
    const evs = queued(a)
    expect(evs.map((e) => e.event)).toEqual(['$groupidentify', '$groupidentify', 'x'])
    expect(evs[0]!.properties).toMatchObject({ $group_type: 'company', $group_key: 'acme', $group_set: { name: 'Acme Inc' } })
    expect(evs[1]!.properties).toMatchObject({ $group_type: 'team', $group_key: '7', $group_set: {} })
    expect(evs[2]!.properties.$groups).toEqual({ company: 'acme', team: '7' })
  })

  it('register()/unregister(): super properties are persisted, event props win, reserved ids cannot be overridden', () => {
    const a = make()
    a.register({ app: 'shop', tier: 'free' })
    a.capture('one', { tier: 'gold', $session_id: 'nope' })
    a.unregister('app')
    kill(a)
    const b = make()
    b.capture('two')
    const [one] = queued(a)
    const [two] = queued(b).filter((e) => e.event === 'two')
    expect(one!.properties).toMatchObject({ app: 'shop', tier: 'gold' })
    expect(one!.properties.$session_id).not.toBe('nope')
    expect(two!.properties.app).toBeUndefined()
    expect(two!.properties.tier).toBe('free')
  })

  it('sees identity changes made by another tab', () => {
    const a = make()
    const b = make()
    a.identify('u9')
    b.capture('x')
    expect(queued(b).at(-1)!.distinct_id).toBe('u9')
  })

  it('setPersonProperties() sends $set without changing identity', () => {
    const a = make()
    const id = a.getDistinctId()
    a.setPersonProperties({ a: 1 }, { b: 2 })
    expect(queued(a)[0]).toMatchObject({ event: '$set', distinct_id: id, properties: { $set: { a: 1 }, $set_once: { b: 2 } } })
  })
})
