// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bucket, eligible, nextQuestion, prepare, surveys, type Facts, type Survey } from '../src/surveys'
import { memKV } from '../src/storage'
import type { Glyphway } from '../src/core'

const DAY = 86_400_000
const NOW = 1_000 * DAY

const base: Survey = { id: 1, name: 's', type: 'popover', questions: [{ id: 'a', type: 'open', question: 'Why?' }] }
const facts = (o: Partial<Facts> = {}): Facts => ({ now: NOW, url: 'https://a.b/pricing', width: 1280, seen: {}, flagOn: () => true, hasSelector: () => true, ...o })

describe('survey rules', () => {
  it('branches by rating bucket', () => {
    const s: Survey = { ...base, questions: [
      { id: 'q1', type: 'rating', question: 'x', scale: 5, branching: { by: { negative: 'q3', positive: 'end' } } },
      { id: 'q2', type: 'open', question: 'y' },
      { id: 'q3', type: 'open', question: 'z' },
    ] }
    expect(bucket(5, 2)).toBe('negative')
    expect(nextQuestion(s, 0, 2)).toBe(2)
    expect(nextQuestion(s, 0, 5)).toBe(-1)
    expect(nextQuestion(s, 0, 3)).toBe(1)
    expect(nextQuestion(s, 2, 'x')).toBe(-1)
  })

  it('puts ratings in buckets on every scale', () => {
    expect([bucket(2, 1), bucket(2, 2)]).toEqual(['negative', 'positive'])
    expect([bucket(3, 1), bucket(3, 2), bucket(3, 3)]).toEqual(['negative', 'neutral', 'positive'])
    expect([bucket(7, 3), bucket(7, 4), bucket(7, 5)]).toEqual(['negative', 'neutral', 'positive'])
    expect([bucket(10, 6), bucket(10, 8), bucket(10, 9)]).toEqual(['negative', 'neutral', 'positive'])
  })

  it('branches by choice', () => {
    const s: Survey = { ...base, questions: [{ id: 'q1', type: 'single_choice', question: 'x', choices: ['a', 'b'], branching: { by: { b: 'q3' } } }, { id: 'q2', type: 'open', question: 'y' }, { id: 'q3', type: 'open', question: 'z' }] }
    expect([nextQuestion(s, 0, 'a'), nextQuestion(s, 0, 'b')]).toEqual([1, 2])
  })

  it('keeps the wait period', () => {
    const s: Survey = { ...base, conditions: { wait_days: 30 } }
    expect(eligible(s, facts({ lastAny: NOW - 29 * DAY }))).toBe(false)
    expect(eligible(s, facts({ lastAny: NOW - 31 * DAY }))).toBe(true)
    expect(eligible(s, facts())).toBe(true)
  })

  it('matches URLs, devices, selectors and flags', () => {
    const on = (conditions: Survey['conditions'], f?: Partial<Facts>): boolean => eligible({ ...base, conditions }, facts(f))
    expect(on({ url: 'pricing' })).toBe(true)
    expect(on({ url: 'blog' })).toBe(false)
    expect(on({ url: 'https://a.b/pricing', url_match: 'exact' })).toBe(true)
    expect(on({ url: 'pricing', url_match: 'exact' })).toBe(false)
    expect(on({ url: '/pri.*$', url_match: 'regex' })).toBe(true)
    expect(on({ url: '(', url_match: 'regex' })).toBe(false)
    expect(on({ device_types: ['Mobile'] })).toBe(false)
    expect(on({ device_types: ['Mobile'] }, { width: 400 })).toBe(true)
    expect(on({ selector: '#x' }, { hasSelector: () => false })).toBe(false)
    expect(on({ flag_key: 'f' }, { flagOn: () => false })).toBe(false)
    expect(on({ flag_key: 'f' }, { flagOn: () => undefined })).toBe(false)
  })

  it('repeats as set', () => {
    const shown = { seen: { at: NOW - 5 * DAY, times: 1 } }
    expect(eligible(base, facts(shown))).toBe(false)
    expect(eligible({ ...base, schedule: { repeat: 'always' } }, facts(shown))).toBe(true)
    const up = { ...base, schedule: { times: 2, every_days: 3 } }
    expect(eligible(up, facts(shown))).toBe(true)
    expect(eligible(up, facts({ seen: { at: NOW - 2 * DAY, times: 1 } }))).toBe(false)
    expect(eligible(up, facts({ seen: { at: NOW - 5 * DAY, times: 2 } }))).toBe(false)
  })

  it('stays inside its dates', () => {
    expect(eligible({ ...base, start_date: NOW + 1 }, facts())).toBe(false)
    expect(eligible({ ...base, end_date: NOW }, facts())).toBe(false)
  })
})

const client = () => {
  const events: { name: string; props: Record<string, unknown> }[] = []
  let out = false
  const a = {
    hasOptedOut: () => out,
    optIn() { out = false },
    optOut() { out = true },
    getClient: () => ({ host: 'https://e.x', writeKey: 'k' }),
    capture(name: string, props: Record<string, unknown>) { events.push({ name, props }) },
  } as unknown as Glyphway
  return { a, events }
}
const settled = () => new Promise((r) => setTimeout(r, 0))
const shadow = () => document.querySelector('[data-glyphway-overlay]')?.shadowRoot
const answer = (list: Survey[]) => vi.fn(async () => new Response(JSON.stringify({ surveys: list })))

describe('survey on the page', () => {
  afterEach(() => { document.body.replaceChildren() })

  it('walks through the questions and sends a partial then a full response', async () => {
    const { a, events } = client()
    const s: Survey = { ...base, questions: [{ id: 'q1', type: 'rating', question: 'How?', scale: 5 }, { id: 'q2', type: 'open', question: 'Why?' }] }
    surveys(a, { fetch: answer([s]) as never, storage: memKV() })
    await settled()
    expect(events.map((e) => e.name)).toEqual(['survey shown'])
    const buttons = [...shadow()!.querySelectorAll('.scale button')] as HTMLButtonElement[]
    expect(buttons.map((b) => b.textContent)).toEqual(['1', '2', '3', '4', '5'])
    buttons[3]!.click()
    const area = shadow()!.querySelector('textarea')!
    area.value = ' too slow '
    ;(shadow()!.querySelector('.go') as HTMLButtonElement).click()
    const sent = events.filter((e) => e.name === 'survey sent')
    expect(sent.map((e) => [e.props.$survey_completed, e.props.$survey_response_q1, e.props.$survey_response_q2])).toEqual([[false, 4, undefined], [true, 4, 'too slow']])
    expect(sent[0]!.props.$survey_submission_id).toBe(sent[1]!.props.$survey_submission_id)
    expect(sent[0]!.props.$survey_id).toBe('1')
    expect(shadow()).toBeUndefined()
  })

  it('asks for nothing and records nothing while opted out; opt-in runs it', async () => {
    const { a, events } = client()
    a.optOut()
    const storage = memKV()
    const fetch = answer([base])
    surveys(a, { fetch: fetch as never, storage })
    await settled()
    expect(fetch).not.toHaveBeenCalled()
    expect(storage.get('an_surveys_k')).toBeNull()
    a.optIn()
    await settled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(events.map((e) => e.name)).toEqual(['survey shown'])
  })

  it('writes server text as text, never as markup', async () => {
    const { a } = client()
    surveys(a, { fetch: answer([{ ...base, questions: [{ id: 'a', type: 'open', question: '<img src=x onerror=alert(1)>' }] }]) as never, storage: memKV() })
    await settled()
    expect(shadow()!.querySelector('img')).toBeNull()
    expect(shadow()!.querySelector('h2')!.textContent).toContain('<img')
  })

  it('reports a dismissal, and shows it once', async () => {
    const { a, events } = client()
    const storage = memKV()
    surveys(a, { fetch: answer([base]) as never, storage })
    await settled()
    ;(shadow()!.querySelector('.x') as HTMLButtonElement).click()
    expect(events.map((e) => e.name)).toEqual(['survey shown', 'survey dismissed'])
    const again = client()
    surveys(again.a, { fetch: answer([base]) as never, storage })
    await settled()
    expect(again.events).toEqual([])
  })

  it('waits for its event, and leaves api surveys to the app', async () => {
    const { a, events } = client()
    const on: Survey = { ...base, conditions: { events: ['bought'] } }
    const api: Survey = { ...base, id: 2, type: 'api' }
    const s = surveys(a, { fetch: answer([on, api]) as never, storage: memKV() })
    await settled()
    expect(events).toEqual([])
    a.capture('other')
    expect(shadow()).toBeUndefined()
    a.capture('bought')
    expect(shadow()).toBeTruthy()
    expect(s.getActiveSurveys().map((x) => x.id)).toEqual([2])
  })
})

describe('translations and shuffling (E1)', () => {
  const s: Survey = {
    id: 3, name: 's', type: 'popover',
    appearance: { thanks: 'Thanks', button: 'Send', shuffle_questions: true, translations: { fr: { thanks: 'Merci', questions: { q1: { question: 'Pourquoi ?', choices: ['un', 'deux', 'trois'] } } } } },
    questions: [
      { id: 'q1', type: 'single_choice', question: 'Why?', choices: ['one', 'two', 'three'], shuffle_choices: true },
      { id: 'q2', type: 'open', question: 'More?' },
    ],
  }
  it('takes the full code, then the first part, then the survey as written', () => {
    const none = (): number => 0
    expect(prepare(s, 'fr-CA', none).appearance?.thanks).toBe('Merci')
    expect(prepare(s, 'FR', none).appearance?.thanks).toBe('Merci')
    expect(prepare(s, 'de', none).appearance?.thanks).toBe('Thanks')
    expect(prepare(s, undefined, none).questions.map((q) => q.question)).toEqual(['More?', 'Why?'])
  })
  it('shuffles choices and labels together and keeps the response words', () => {
    // a generator that always answers 0 turns [a, b, c] into [b, c, a]
    const q = prepare(s, 'fr', () => 0).questions.find((x) => x.id === 'q1')!
    expect(q.choices).toEqual(['two', 'three', 'one'])
    expect(q.labels).toEqual(['deux', 'trois', 'un'])
    expect(q.question).toBe('Pourquoi ?')
  })
  it('does not shuffle questions that branch, and ignores a translation of the wrong size', () => {
    const b: Survey = { ...s, questions: [{ ...s.questions[0]!, branching: { next: 'q2' } }, s.questions[1]!], appearance: { ...s.appearance, translations: { fr: { questions: { q1: { choices: ['un'] } } } } } }
    const out = prepare(b, 'fr', () => 0)
    expect(out.questions.map((q) => q.id)).toEqual(['q1', 'q2'])
    expect(out.questions[0]!.labels).toBeUndefined()
  })
})
