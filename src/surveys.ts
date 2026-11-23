// Surveys. A lazy module: `surveys(glyphway)` after init.
//
// Which survey to show is decided here, since URLs, selectors and wait periods
// are client facts. An audience goes through a generated flag, so pass the
// `flags` module for surveys that have one.
import type { Glyphway } from './core'
import type { FeatureFlags } from './flags'
import { closeButton, el, overlay, safeUrl, type Overlay, type Theme } from './overlay'
import { memKV, webKV, type KV } from './storage'
import { disabled, emitter } from './feature'
import type { Props } from './types'

const DAY = 86_400_000

export interface Question {
  id: string
  type: 'open' | 'link' | 'rating' | 'single_choice' | 'multiple_choice'
  question: string
  description?: string
  scale?: 2 | 3 | 5 | 7 | 10
  display?: 'number' | 'emoji' | 'nps' | 'csat' | 'ces'
  choices?: string[]
  link?: string
  button?: string
  /** `next` always, or `by` a response or a rating bucket. A target of `end` finishes. */
  branching?: { next?: string; by?: Record<string, string> }
  shuffle_choices?: boolean
  /** Set by `prepare`: what to show for each of `choices` (a response is always the choice itself). */
  labels?: string[]
}

export interface Translation {
  thanks?: string
  button?: string
  questions?: Record<string, { question?: string; description?: string; button?: string; choices?: string[] }>
}

export interface Survey {
  id: number | string
  name: string
  type: 'popover' | 'api' | 'feedback_button' | 'hosted'
  questions: Question[]
  appearance?: Theme & { thanks?: string; button?: string; position?: string; shuffle_questions?: boolean; translations?: Record<string, Translation> }
  conditions?: {
    url?: string
    url_match?: 'contains' | 'exact' | 'regex'
    device_types?: string[]
    selector?: string
    wait_days?: number
    events?: string[]
    flag_key?: string
  }
  /** `once` by default; `always`; or up to `times`, `every_days` apart. */
  schedule?: { repeat?: 'once' | 'always'; times?: number; every_days?: number }
  linked_flag_key?: string | null
  start_date?: number | null
  end_date?: number | null
}

/** Negative, neutral or positive, by scale (INV P8). */
export function bucket(scale: number, rating: number): 'negative' | 'neutral' | 'positive' {
  const [neg, pos] = ({ 2: [1, 2], 3: [1, 3], 5: [2, 4], 7: [3, 5], 10: [6, 9] } as Record<number, [number, number]>)[scale] ?? [0, 0]
  return rating <= neg ? 'negative' : rating >= pos ? 'positive' : 'neutral'
}

/** The question after `at`, or -1 to finish. */
export function nextQuestion(s: Survey, at: number, answer: unknown): number {
  const q = s.questions[at]!
  const b = q.branching
  const target = (q.type === 'rating' && typeof answer === 'number' && b?.by?.[bucket(q.scale ?? 5, answer)]) || (typeof answer === 'string' && b?.by?.[answer]) || b?.next
  if (target === 'end') return -1
  if (target) {
    const i = s.questions.findIndex((x) => x.id === target)
    if (i >= 0) return i
  }
  return at + 1 < s.questions.length ? at + 1 : -1
}

/** The translation for a language: "fr-CA" by its full code, then "fr" (E1). */
export function translationFor(s: Survey, language: string | undefined): Translation | undefined {
  const all = s.appearance?.translations
  if (!all || !language) return undefined
  const by: Record<string, Translation> = {}
  for (const k of Object.keys(all)) by[k.toLowerCase()] = all[k]!
  const code = language.toLowerCase().replace('_', '-')
  return by[code] ?? by[code.split('-')[0]!]
}

const shuffled = <T>(xs: T[], rnd: () => number): T[] => {
  const a = xs.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/** A copy of the survey as one viewer sees it: translated, then shuffled (E1). Responses keep the survey's own words. */
export function prepare(s: Survey, language: string | undefined, rnd: () => number = Math.random): Survey {
  const tr = translationFor(s, language)
  let questions = s.questions.map((q): Question => {
    const t = tr?.questions?.[q.id]
    const own = q.choices ?? []
    const labels = t?.choices && t.choices.length === own.length ? t.choices : undefined
    let order = own.map((_, i) => i)
    if (q.shuffle_choices) order = shuffled(order, rnd)
    const out: Question = { ...q, question: t?.question || q.question }
    const description = t?.description || q.description
    if (description) out.description = description
    const button = t?.button || q.button
    if (button) out.button = button
    if (own.length) {
      out.choices = order.map((i) => own[i]!)
      if (labels) out.labels = order.map((i) => labels[i]!)
    }
    return out
  })
  if (s.appearance?.shuffle_questions && !s.questions.some((q) => q.branching)) questions = shuffled(questions, rnd)
  const appearance = { ...s.appearance }
  if (tr?.thanks) appearance.thanks = tr.thanks
  if (tr?.button) appearance.button = tr.button
  return { ...s, questions, appearance }
}

export interface Seen {
  /** When this survey was last shown, and how often. */
  at?: number
  times?: number
}

export interface Facts {
  now: number
  url: string
  width: number
  /** When any survey was last shown here. */
  lastAny?: number
  seen: Seen
  flagOn: (key: string) => boolean | undefined
  hasSelector: (selector: string) => boolean
}

const deviceOf = (w: number): string => (w < 768 ? 'Mobile' : w < 1024 ? 'Tablet' : 'Desktop')

function urlMatches(c: NonNullable<Survey['conditions']>, url: string): boolean {
  if (!c.url) return true
  if (c.url_match === 'exact') return url === c.url
  if (c.url_match === 'regex') {
    try {
      return new RegExp(c.url).test(url)
    } catch {
      return false
    }
  }
  return url.includes(c.url)
}

/** Whether a survey may show now. An event trigger is checked by the caller. */
export function eligible(s: Survey, f: Facts): boolean {
  const c = s.conditions ?? {}
  if ((s.start_date && f.now < s.start_date) || (s.end_date && f.now >= s.end_date)) return false
  if (!urlMatches(c, f.url)) return false
  if (c.device_types?.length && !c.device_types.includes(deviceOf(f.width))) return false
  if (c.selector && !f.hasSelector(c.selector)) return false
  if (c.wait_days && f.lastAny !== undefined && f.now - f.lastAny < c.wait_days * DAY) return false
  for (const key of [c.flag_key, s.linked_flag_key]) {
    if (key && !f.flagOn(key)) return false
  }
  const r = s.schedule ?? {}
  const times = f.seen.times ?? 0
  if (r.repeat === 'always') return true
  if (r.times || r.every_days) {
    if (r.times && times >= r.times) return false
    return !f.seen.at || !r.every_days || f.now - f.seen.at >= r.every_days * DAY
  }
  return times === 0
}

export interface SurveyOptions {
  flags?: FeatureFlags
  storage?: KV
  fetch?: typeof fetch
  /** Don't show anything by itself: use `getActiveSurveys` and draw your own. */
  manual?: boolean
  /** The language of translated surveys. Default: the browser's. */
  language?: string
}

export interface Surveys {
  getActiveSurveys(): Survey[]
  /** Shows one now, past its conditions. */
  showSurvey(id: Survey['id']): void
  stop(): void
}

const newId = (): string => Math.random().toString(36).slice(2) + Date.now().toString(36)

export function surveys(a: Glyphway, o: SurveyOptions = {}): Surveys {
  const off = disabled<Surveys>(a, 'surveys', 'surveys', { getActiveSurveys: () => [] })
  if (off) return off
  const emit = emitter(a)
  const c = a.getClient()
  const kv = o.storage ?? (typeof localStorage === 'undefined' ? memKV() : webKV('localStorage'))
  const send = o.fetch ?? fetch.bind(globalThis)
  const key = `an_surveys_${c.writeKey}`
  let list: Survey[] = []
  let open: Overlay | undefined
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const memory = (): { any?: number; by: Record<string, Seen> } => {
    try {
      return { by: {}, ...(JSON.parse(kv.get(key) ?? '{}') as object) }
    } catch {
      return { by: {} }
    }
  }
  const facts = (s: Survey): Facts => {
    const m = memory()
    return {
      now: Date.now(),
      url: location.href,
      width: innerWidth,
      lastAny: m.any,
      seen: m.by[String(s.id)] ?? {},
      flagOn: (k) => o.flags?.isFeatureEnabled(k, { send_event: false }),
      hasSelector: (sel) => {
        try {
          return !!document.querySelector(sel)
        } catch {
          return false
        }
      },
    }
  }

  const render = (original: Survey): void => {
    if (open || !original.questions.length || a.hasOptedOut()) return
    const s = prepare(original, o.language ?? (typeof navigator === 'undefined' ? undefined : navigator.language))
    const sid = String(s.id)
    const m = memory()
    const seen = m.by[sid] ?? {}
    m.any = Date.now()
    m.by[sid] = { at: m.any, times: (seen.times ?? 0) + 1 }
    kv.set(key, JSON.stringify(m))
    emit('survey shown', { $survey_id: sid, $survey_name: s.name })

    const submission = newId()
    const answers: Props = {}
    let answered = false
    let finished = false
    const sent = (completed: boolean): void => {
      emit('survey sent', { $survey_id: sid, $survey_name: s.name, $survey_submission_id: submission, $survey_completed: completed, ...answers })
    }
    const leave = (): void => {
      if (!finished && answered) emit('survey abandoned', { $survey_id: sid, $survey_submission_id: submission })
    }
    addEventListener('pagehide', leave, { once: true })
    const ui = overlay('corner', s.appearance ?? {}, () => {
      open = undefined
      removeEventListener('pagehide', leave)
    })
    open = ui
    const dismiss = (): void => {
      finished = true
      emit('survey dismissed', { $survey_id: sid, $survey_submission_id: submission })
      ui.close()
    }
    const thanks = (): void => {
      finished = true
      sent(true)
      const text = s.appearance?.thanks
      if (!text) return ui.close()
      ui.box.replaceChildren(closeButton('Close', ui.close), el('p', { text }))
    }
    const go = (at: number, answer: unknown): void => {
      const q = s.questions[at]!
      if (answer !== undefined) {
        answers[`$survey_response_${q.id}`] = answer as Props[string]
        answered = true
      }
      const next = nextQuestion(s, at, answer)
      if (next < 0) return thanks()
      if (answer !== undefined) sent(false)
      draw(next)
    }
    const draw = (at: number): void => {
      const q = s.questions[at]!
      const parts: Node[] = [closeButton('Dismiss', dismiss), el('h2', { text: q.question })]
      if (q.description) parts.push(el('p', { text: q.description }))
      const submit = el('button', { class: 'go', text: q.button ?? s.appearance?.button ?? 'Submit' })
      const skip = (): void => go(at, undefined)
      if (q.type === 'rating') {
        const low = q.display === 'nps' || q.scale === 10 ? 0 : 1
        const scale = el('div', { class: 'scale' })
        for (let n = low; n <= (q.scale ?? 5); n++) {
          const b = el('button', { class: 'plain', text: String(n) })
          b.onclick = (): void => go(at, n)
          scale.append(b)
        }
        parts.push(scale)
      } else if (q.type === 'open') {
        const t = el('textarea')
        t.setAttribute('aria-label', q.question)
        parts.push(t)
        submit.onclick = (): void => (t.value.trim() ? go(at, t.value.trim()) : skip())
        parts.push(el('div', { class: 'row' }, submit))
      } else if (q.type === 'link') {
        submit.onclick = (): void => {
          const url = safeUrl(q.link)
          if (url) window.open(url, '_blank', 'noopener')
          go(at, 'link clicked')
        }
        parts.push(el('div', { class: 'row' }, submit))
      } else {
        const multi = q.type === 'multiple_choice'
        const boxes = (q.choices ?? []).map((text, n) => {
          const i = el('input')
          i.type = multi ? 'checkbox' : 'radio'
          i.name = 'c'
          i.value = text
          parts.push(el('label', {}, i, document.createTextNode(` ${q.labels?.[n] ?? text}`)))
          return i
        })
        submit.onclick = (): void => {
          const picked = boxes.filter((b) => b.checked).map((b) => b.value)
          if (!picked.length) return skip()
          go(at, multi ? picked : picked[0])
        }
        parts.push(el('div', { class: 'row' }, submit))
      }
      ui.box.replaceChildren(...parts)
    }
    draw(0)
  }

  const tryShow = (name?: string): void => {
    if (o.manual || open || stopped || a.hasOptedOut()) return
    for (const s of list) {
      if (s.type !== 'popover') continue
      const events = s.conditions?.events
      if (events?.length ? !name || !events.includes(name) : !!name) continue
      if (eligible(s, facts(s))) return render(s)
    }
  }

  const feedback = (): void => {
    for (const s of list.filter((x) => x.type === 'feedback_button')) {
      if (!eligible(s, { ...facts(s), seen: {} })) continue
      const ui = overlay('corner', s.appearance ?? {}, () => undefined)
      const b = el('button', { class: 'go', text: s.appearance?.button ?? 'Feedback' })
      b.onclick = (): void => {
        ui.close()
        render(s)
      }
      ui.box.replaceChildren(b)
      ui.box.style.width = 'auto'
      ui.box.style.padding = '0'
      return
    }
  }

  // an event can be what a survey waits for
  const capture = a.capture
  a.capture = (event: string, props?: Props): void => {
    capture.call(a, event, props)
    if (!event.startsWith('survey ') && !event.startsWith('$')) tryShow(event)
  }

  const load = async (): Promise<void> => {
    clearTimeout(timer)
    try {
      // the list is asked for by key alone, but an opted-out page asks nothing
      if (a.hasOptedOut() || stopped) return
      const r = await send(`${c.host}/surveys?api_key=${encodeURIComponent(c.writeKey)}`)
      if (!r.ok || stopped) return
      list = ((await r.json()) as { surveys?: Survey[] }).surveys ?? []
      tryShow()
      if (!o.manual) feedback()
    } catch {
      /* the next page load tries again */
    } finally {
      if (!stopped) timer = setTimeout(() => void load(), DAY)
    }
  }
  void load()
  // what was held back while opted out runs now
  const optIn = a.optIn
  a.optIn = function (this: Glyphway): void {
    optIn.call(this)
    void load()
  }

  return {
    getActiveSurveys: () => list.filter((s) => eligible(s, facts(s))),
    showSurvey: (id) => {
      const s = list.find((x) => String(x.id) === String(id))
      if (s) render(s)
    },
    stop: () => {
      stopped = true
      clearTimeout(timer)
      a.capture = capture
      a.optIn = optIn
      open?.close()
    },
  }
}
