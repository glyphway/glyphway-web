// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentFor, due, messages, triggered, type ActiveMessage, type Message } from '../src/messages'
import { memKV } from '../src/storage'
import type { Glyphway } from '../src/core'

const DAY = 86_400_000
const m: Message = { id: 1, name: 'm', layout: 'modal', content: { default: { title: 'Hello', body: 'World', primary: { label: 'Open', action: 'https://a.b/x' }, secondary: { label: 'Later', action: 'dismiss' } }, bn: { title: 'হ্যালো' } } }

describe('message rules', () => {
  it('keeps its frequency', () => {
    expect(due(m, undefined, 0)).toBe(true)
    expect(due(m, 0, 100 * DAY)).toBe(false)
    const every = { ...m, frequency: { every_days: 3 } }
    expect(due(every, 0, 2 * DAY)).toBe(false)
    expect(due(every, 0, 3 * DAY)).toBe(true)
  })

  it('goes by its own trigger', () => {
    const t = { ...m, trigger: { event: 'purchase' } }
    expect([triggered(t, 'purchase'), triggered(t, 'app_open')]).toEqual([true, false])
    expect(triggered(m, 'app_open')).toBe(true)
  })

  it('falls back to the default locale', () => {
    expect(contentFor(m, 'bn')?.title).toBe('হ্যালো')
    expect(contentFor(m, 'bn-BD')?.title).toBe('হ্যালো')
    expect(contentFor(m, 'fr')?.title).toBe('Hello')
  })
})

const client = () => {
  const events: { name: string; props: Record<string, unknown> }[] = []
  let out = false
  const a = {
    hasOptedOut: () => out,
    optIn() { out = false },
    optOut() { out = true },
    getClient: () => ({ host: 'https://e.x', writeKey: 'k', deviceId: 'dev-1' }),
    capture(name: string, props: Record<string, unknown>) { events.push({ name, props }) },
  } as unknown as Glyphway
  return { a, events }
}
const settled = () => new Promise((r) => setTimeout(r, 0))
const shadow = () => document.querySelector('[data-glyphway-overlay]')?.shadowRoot
const answer = (list: Message[]) => vi.fn(async () => new Response(JSON.stringify({ messages: list })))

describe('message on the page', () => {
  afterEach(() => { document.body.replaceChildren() })

  it('shows on app open once, and reports what happened', async () => {
    const { a, events } = client()
    const storage = memKV()
    const actions: string[] = []
    messages(a, { fetch: answer([m]) as never, storage, locale: 'en', onAction: (x) => actions.push(x) })
    await settled()
    expect(shadow()!.querySelector('h2')!.textContent).toBe('Hello')
    ;(shadow()!.querySelector('.go') as HTMLButtonElement).click()
    expect(events.map((e) => [e.name, e.props.$message_id, e.props.$message_action])).toEqual([['$message_impression', '1', undefined], ['$message_click', '1', 'https://a.b/x']])
    expect(actions).toEqual(['https://a.b/x'])
    const again = client()
    messages(again.a, { fetch: answer([m]) as never, storage, locale: 'en' })
    await settled()
    expect(again.events).toEqual([])
  })

  it('shows a test message at app open past its trigger, flag and frequency, and leaves no trace (E2)', async () => {
    const { a, events } = client()
    const storage = memKV()
    const test: Message = { ...m, id: 9, trigger: { event: 'purchase' }, targeting: { flag_key: 'off' }, test: true }
    const fetch = answer([test])
    messages(a, { fetch: fetch as never, storage, locale: 'en', flags: { isFeatureEnabled: () => false } as never })
    await settled()
    expect((fetch.mock.calls as unknown[][])[0]![0]).toBe('https://e.x/messages?api_key=k&device_id=dev-1')
    expect(shadow()!.querySelector('h2')!.textContent).toBe('Hello')
    ;(shadow()!.querySelector('.plain') as HTMLButtonElement).click()
    expect(events).toEqual([])
    expect(storage.get('an_messages_k')).toBeNull()
  })

  it('hands the message to a custom display and counts it only when the app says it is on screen (E4)', async () => {
    const { a, events } = client()
    const storage = memKV()
    const got: ActiveMessage[] = []
    const x = messages(a, { fetch: answer([m]) as never, storage, locale: 'bn', display: (v) => got.push(v) })
    await settled()
    expect(shadow()).toBeUndefined()
    expect(got.length).toBe(1)
    expect(got[0]!.content.title).toBe('হ্যালো')
    expect(events).toEqual([])
    got[0]!.impression()
    got[0]!.impression()
    got[0]!.click('https://a.b/x')
    got[0]!.dismiss() // already closed: nothing more
    expect(events.map((e) => [e.name, e.props.$message_action])).toEqual([['$message_impression', undefined], ['$message_click', 'https://a.b/x']])
    expect(x.isSuppressed()).toBe(false)
    x.suppressMessages(true)
    expect(x.isSuppressed()).toBe(true)
  })

  it('an error from a custom display is reported and leaves no frequency record, so the message comes again (E4)', async () => {
    const { a, events } = client()
    const storage = memKV()
    const first: ActiveMessage[] = []
    messages(a, { fetch: answer([m]) as never, storage, locale: 'en', display: (v) => first.push(v) })
    await settled()
    first[0]!.error('x'.repeat(300))
    expect(events.map((e) => e.name)).toEqual(['$message_display_error'])
    expect((events[0]!.props.$message_reason as string).length).toBe(200)
    const again: ActiveMessage[] = []
    messages(client().a, { fetch: answer([m]) as never, storage, locale: 'en', display: (v) => again.push(v) })
    await settled()
    expect(again.length).toBe(1)
  })

  it('counts a dismiss button as a dismissal, not a click', async () => {
    const { a, events } = client()
    messages(a, { fetch: answer([m]) as never, storage: memKV(), locale: 'en' })
    await settled()
    ;(shadow()!.querySelector('.plain') as HTMLButtonElement).click()
    expect(events.map((e) => e.name)).toEqual(['$message_impression', '$message_dismiss'])
  })

  it('answers to its event, to triggerMessage, and stays quiet when suppressed', async () => {
    const { a, events } = client()
    const on: Message = { ...m, trigger: { event: 'purchase' } }
    const manual: Message = { ...m, id: 2, trigger: { event: 'manual' } }
    const x = messages(a, { fetch: answer([on, manual]) as never, storage: memKV(), locale: 'en' })
    await settled()
    expect(events).toEqual([])
    x.suppressMessages(true)
    a.capture('purchase')
    expect(shadow()).toBeUndefined()
    x.suppressMessages(false)
    a.capture('purchase')
    expect(shadow()).toBeTruthy()
    ;(shadow()!.querySelector('.x') as HTMLButtonElement).click()
    x.triggerMessage(2)
    expect(events.filter((e) => e.name === '$message_impression').map((e) => e.props.$message_id)).toEqual(['1', '2'])
  })

  it('never opens a script URL', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { a } = client()
    const bad: Message = { ...m, content: { default: { title: 'x', primary: { label: 'Go', action: 'javascript:alert(1)' } } } }
    messages(a, { fetch: answer([bad]) as never, storage: memKV(), locale: 'en' })
    await settled()
    ;(shadow()!.querySelector('.go') as HTMLButtonElement).click()
    expect(open).not.toHaveBeenCalled()
  })

  it('shows only your variant of an experiment, and counts you either way', async () => {
    const asked: string[] = []
    const flags = { getFeatureFlag: (k: string) => { asked.push(k); return 'control' } } as never
    const variant = (id: number, v: string): Message => ({ ...m, id, targeting: { experiment_flag: 'experiment-1', experiment_variant: v } })
    const mine = client()
    messages(mine.a, { fetch: answer([variant(1, 'test'), variant(2, 'control')]) as never, storage: memKV(), locale: 'en', flags })
    await settled()
    expect(mine.events.map((e) => e.props.$message_id)).toEqual(['2'])
    asked.length = 0
    const none = client()
    messages(none.a, { fetch: answer([variant(1, 'test')]) as never, storage: memKV(), locale: 'en', flags })
    await settled()
    expect(none.events).toEqual([])
    expect(asked).toEqual(['experiment-1'])
  })

  it('needs its flag', async () => {
    const { a, events } = client()
    const flagged: Message = { ...m, targeting: { flag_key: 'f' } }
    messages(a, { fetch: answer([flagged]) as never, storage: memKV(), locale: 'en', flags: { isFeatureEnabled: () => false } as never })
    await settled()
    expect(events).toEqual([])
  })

  it('asks for nothing while opted out, and again after opt-in', async () => {
    const { a, events } = client()
    a.optOut()
    const fetch = answer([m])
    messages(a, { fetch: fetch as never, storage: memKV(), locale: 'en' })
    await settled()
    expect(fetch).not.toHaveBeenCalled()
    expect(shadow()).toBeUndefined()
    a.optIn()
    await settled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(shadow()!.querySelector('h2')!.textContent).toBe('Hello')
    expect(events.map((e) => e.name)).toEqual(['$message_impression'])
  })

  it('one that cannot be drawn does not hold back the next', async () => {
    const { a } = client()
    const empty: Message = { ...m, id: 1, content: {} }
    messages(a, { fetch: answer([empty, { ...m, id: 2 }]) as never, storage: memKV(), locale: 'en' })
    await settled()
    expect(shadow()!.querySelector('h2')!.textContent).toBe('Hello')
  })
})
