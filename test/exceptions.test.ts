import { describe, expect, it, vi } from 'vitest'
import { exceptionList, exceptions, parseStack, rateLimiter } from '../src/exceptions'
import type { Glyphway } from '../src/core'

const V8 = `TypeError: x is undefined
    at render (https://a.b/app.js:10:5)
    at https://a.b/vendor/lib.js:3:1
    at Object.go [as run] (https://a.b/app.js:20:9)
    at new Thing (https://cdn.x/y.js:1:1)
    at <anonymous>`
const GECKO = `render@https://a.b/app.js:10:5
@https://a.b/lib.js:3:1`

const inApp = (f: string): boolean => f.startsWith('https://a.b/')

const fake = () => {
  const events: { name: string; props: Record<string, unknown> }[] = []
  const a = { capture: (name: string, props: Record<string, unknown>) => events.push({ name, props }) } as unknown as Glyphway
  return { a, events }
}

describe('stack parsing', () => {
  it('reads V8 frames, the throwing call first', () => {
    const f = parseStack(V8, inApp)
    expect(f.map((x) => [x.function, x.filename, x.lineno, x.colno, x.in_app])).toEqual([
      ['render', 'https://a.b/app.js', 10, 5, true],
      ['?', 'https://a.b/vendor/lib.js', 3, 1, true],
      ['Object.go [as run]', 'https://a.b/app.js', 20, 9, true],
      ['new Thing', 'https://cdn.x/y.js', 1, 1, false],
    ])
    expect(f[0]!.platform).toBe('web:javascript')
  })

  it('reads Gecko and WebKit frames', () => {
    expect(parseStack(GECKO, inApp).map((x) => [x.function, x.lineno])).toEqual([['render', 10], ['?', 3]])
  })

  it('keeps 50 frames', () => {
    const long = Array.from({ length: 80 }, (_, i) => `    at f${i} (https://a.b/a.js:${i + 1}:1)`).join('\n')
    expect(parseStack(long, inApp)).toHaveLength(50)
  })
})

describe('the exception list', () => {
  const m = { handled: false, type: 'onerror', synthetic: false }

  it('links causes to their parents', () => {
    const list = exceptionList(new Error('outer', { cause: new TypeError('inner') }), m)
    expect(list.map((e) => e.type)).toEqual(['Error', 'TypeError'])
    expect(list[0]!.mechanism).toMatchObject({ exception_id: 0, type: 'onerror' })
    expect((list[0]!.mechanism as Record<string, unknown>).parent_id).toBeUndefined()
    expect(list[1]!.mechanism).toMatchObject({ exception_id: 1, parent_id: 0, type: 'chained' })
  })

  it('stops at 10 causes and on a loop', () => {
    let e = new Error('0')
    for (let i = 1; i < 15; i++) e = new Error(String(i), { cause: e })
    expect(exceptionList(e, m)).toHaveLength(10)
    const loop = new Error('a') as Error & { cause?: unknown }
    loop.cause = loop
    expect(exceptionList(loop, m)).toHaveLength(1)
  })

  it('takes anything that was thrown, and cuts long messages', () => {
    expect(exceptionList('boom', m)[0]!).toMatchObject({ type: 'Error', value: 'boom', mechanism: { synthetic: true } })
    expect(exceptionList({ code: 7 }, m)[0]!.value).toBe('{"code":7}')
    expect((exceptionList('x'.repeat(9000), m)[0]!.value as string).length).toBe(8192)
  })
})

describe('the rate limit', () => {
  it('allows 10 per type, then one per 10 s', () => {
    let t = 0
    const ok = rateLimiter(() => t)
    expect(Array.from({ length: 11 }, () => ok('A')).filter(Boolean)).toHaveLength(10)
    expect(ok('B')).toBe(true)
    t = 9_999
    expect(ok('A')).toBe(false)
    t = 10_000
    expect(ok('A')).toBe(true)
    expect(ok('A')).toBe(false)
  })
})

describe('the tracker', () => {
  it('sends handled errors with keys, logs and steps', () => {
    const { a, events } = fake()
    const t = exceptions(a, { errors: false, rejections: false })
    t.setCustomKey('plan', 'pro')
    t.log('first')
    t.addExceptionStep('clicked buy', { sku: 1 })
    t.captureException(new Error('x'), { $exception_fingerprint: 'abc' })
    const p = events[0]!.props
    expect(events[0]!.name).toBe('$exception')
    expect(p.$exception_level).toBe('error')
    expect(p.$exception_fingerprint).toBe('abc')
    expect(p.$exception_keys).toEqual({ plan: 'pro' })
    expect(p.$exception_logs).toEqual(['first'])
    expect((p.$exception_steps as Record<string, unknown>[])[0]!).toMatchObject({ $message: 'clicked buy', sku: 1 })
    expect((p.$exception_list as Record<string, unknown>[])[0]!!.mechanism).toMatchObject({ handled: true, type: 'generic' })
  })

  it('holds 64 keys and the newest logs', () => {
    const { a, events } = fake()
    const t = exceptions(a, { errors: false, rejections: false })
    for (let i = 0; i < 70; i++) t.setCustomKey(`k${i}`, 'v'.repeat(2000))
    for (let i = 0; i < 100; i++) t.log(`${i}`.padEnd(1000, '.'))
    t.captureException(new Error('x'))
    const keys = events[0]!.props.$exception_keys as Record<string, string>
    expect(Object.keys(keys)).toHaveLength(64)
    expect(keys.k0).toHaveLength(1024)
    const logs = events[0]!.props.$exception_logs as string[]
    expect(logs.length).toBeLessThan(100)
    expect(logs.at(-1)?.startsWith('99')).toBe(true)
  })

  it('hears window errors and rejections until stopped', () => {
    const { a, events } = fake()
    const t = exceptions(a)
    dispatchEvent(new ErrorEvent('error', { error: new TypeError('t'), message: 't' }))
    const r = new Event('unhandledrejection') as Event & { reason?: unknown }
    r.reason = new RangeError('r')
    dispatchEvent(r)
    expect(events.map((e) => (e.props.$exception_list as Record<string, unknown>[])[0]!!.type)).toEqual(['TypeError', 'RangeError'])
    expect((events[0]!.props.$exception_list as Record<string, unknown>[])[0]!!.mechanism).toMatchObject({ handled: false, type: 'onerror' })
    t.stop()
    dispatchEvent(new ErrorEvent('error', { error: new TypeError('t') }))
    expect(events).toHaveLength(2)
  })

  it('leaves the console alone unless asked', () => {
    const { a, events } = fake()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = exceptions(a, { errors: false, rejections: false, console: true })
    console.error('bad', 3)
    expect(events[0]!.props.$exception_list).toMatchObject([{ value: 'bad 3', mechanism: { type: 'console', handled: true } }])
    expect(spy).toHaveBeenCalledOnce()
    t.stop()
    expect(console.error).toBe(spy)
    spy.mockRestore()
  })
})
