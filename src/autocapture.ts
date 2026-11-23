import type { Glyphway } from './core'
import type { AutocaptureOptions, Props } from './types'
import { utf8 } from './util'

// Autocapture, after posthog-js. Element serialisation follows posthog-js
// (`getPropertiesFromElement` + `getElementsChainString`) so `$elements_chain`
// parses with PostHog's chain format.

const TAGS = ['a', 'button', 'form', 'input', 'select', 'textarea', 'label']
const FIELD = /^(input|select|textarea)$/
const SENSITIVE_NAME = /^cc|cardnum|ccnum|creditcard|csc|cvc|cvv|exp|pass|pwd|routing|seccode|securitycode|securitynum|socialsec|socsec|ssn/i
const CHAIN_MAX = 2048 // chain ≤ 2 KB
const RAGE_PX = 30
const RAGE_MS = 1000
const RAGE_N = 3

export const tag = (el: Element): string => el.tagName.toLowerCase()

export const noCapture = (el: Element): boolean =>
  el.classList.contains('an-no-capture') || el.classList.contains('ph-no-capture') || el.hasAttribute('data-an-no-capture')

/** Form fields and anything inside a contenteditable region: only name / id / class / aria-label are read, never text. */
export const isField = (el: Element): boolean =>
  FIELD.test(tag(el)) || !!el.closest('[contenteditable]:not([contenteditable="false"])')

/** posthog-js `shouldCaptureValue`: drop card-number- and SSN-looking values. */
const safeVal = (v: string): boolean => {
  v = v.trim()
  return !/^\d{13,19}$/.test(v.replace(/[- ]/g, '')) && !/^\d{3}-?\d{2}-?\d{4}$/.test(v)
}

/** posthog-js `shouldCaptureElement`: no text/href from hidden, password or sensitive-named fields. */
export const capEl = (el: Element): boolean => {
  if (/^(hidden|password)$/i.test(el.getAttribute('type') || '')) return false
  const n = el.getAttribute('name') || el.getAttribute('id') || ''
  return !SENSITIVE_NAME.test(n.replace(/[^a-zA-Z0-9]/g, ''))
}

/** Direct text nodes only, never from fields (so never an input value). */
const safeText = (el: Element): string => {
  let s = ''
  if (!isField(el) && capEl(el))
    el.childNodes.forEach((c) => {
      if (c.nodeType === 3 && c.textContent) s += c.textContent.split(/(\s+)/).filter(safeVal).join('')
    })
  return s.replace(/\s+/g, ' ').trim().slice(0, 255)
}

const spanText = (el: Element): string => {
  let s = ''
  for (const c of Array.from(el.children))
    if (tag(c) === 'span') s = `${s} ${safeText(c)} ${spanText(c)}`.replace(/\s+/g, ' ').trim()
  return s
}

/** `$el_text`: a/button also read nested span text (posthog-js `getDirectAndNestedSpanText`). */
export const elText = (el: Element): string => {
  const t = tag(el)
  const s = (t === 'a' || t === 'button' ? `${safeText(el)} ${spanText(el)}` : safeText(el)).trim().slice(0, 255)
  return safeVal(s) ? s : ''
}

const esc = (s: string): string => s.replace(/"|\\"/g, '\\"')

/** One element of the chain: `tag.cls1.cls2:attr__x="…"nth-child="1"…` with keys sorted. */
function elString(el: Element, href: string | undefined, text: string, min: boolean, ignore: string[]): string {
  const t = tag(el)
  const field = isField(el)
  const a: Record<string, string> = {}
  if (!min)
    for (const at of Array.from(el.attributes)) {
      const n = at.name
      if ((field && !/^(name|id|class|aria-label)$/.test(n)) || !safeVal(at.value) || /^_ng/.test(n) || ignore.includes(n)) continue
      a['attr__' + n] = (n === 'class' ? at.value.split(/\s+/).filter(Boolean).join(' ') : at.value).slice(0, 1024)
    }
  if (href) a.attr__href = href
  let nc = 1
  let nt = 1
  for (let p = el.previousElementSibling; p; p = p.previousElementSibling) {
    nc++
    if (p.tagName === el.tagName) nt++
  }
  let s = t
  const cls = a.attr__class
  if (cls)
    s += cls
      .split(' ')
      .sort()
      .map((c) => '.' + c.replace(/"/g, ''))
      .join('')
  const o: Record<string, string> = { ...a, 'nth-child': '' + nc, 'nth-of-type': '' + nt }
  if (text) o.text = text.slice(0, 400)
  if (a.attr__href) o.href = a.attr__href.slice(0, 2048)
  if (a.attr__id) o.attr_id = a.attr__id
  return (
    s +
    ':' +
    Object.keys(o)
      .sort((x, y) => x.localeCompare(y))
      .map((k) => `${esc(k)}="${esc(o[k]!)}"`)
      .join('')
  )
}

/** Target first, then ancestors up to and including body (crossing shadow roots). */
export function path(el: Element): Element[] {
  const r = [el]
  let c: Element = el
  while (c.parentNode && tag(c) !== 'body') {
    let p: Node | null = c.parentNode
    if (p.nodeType === 11) p = (p as ShadowRoot).host || null
    if (!p || p.nodeType !== 1) break
    r.push((c = p as Element))
  }
  return r
}

/** posthog-js chain string, truncated from the outermost ancestor to stay ≤ 2 KB. */
export function elementsChain(els: Element[], ignore: string[] = []): string {
  let href: string | undefined
  for (const e of els)
    if (tag(e) === 'a') {
      const h = e.getAttribute('href')
      href = h && capEl(e) && safeVal(h) ? h : undefined
      break
    }
  let out = ''
  for (let i = 0; i < els.length; i++) {
    const e = els[i]!
    const text = i === 0 || TAGS.includes(tag(e)) ? elText(e) : ''
    let s = elString(e, i ? undefined : href, text, false, ignore)
    if (!i && utf8(s) > CHAIN_MAX) s = elString(e, undefined, text.slice(0, 64), true, ignore)
    const next = out ? out + ';' + s : s
    if (utf8(next) > CHAIN_MAX) break
    out = next
  }
  return out
}

/** The element an event happened on, through shadow roots. */
export function eventEl(e: Event): Element | undefined {
  let t = (e.composedPath ? e.composedPath()[0] : e.target) as Node | null | undefined
  if (t && t.nodeType === 3) t = t.parentNode
  return t && t.nodeType === 1 && tag(t as Element) !== 'html' ? (t as Element) : undefined
}

/** posthog-js RageClick: true on the third click, each within 30 px (Manhattan) and 1 s of the one before. */
export function rageCounter(): (x: number, y: number) => boolean {
  let clicks: { x: number; y: number; t: number }[] = []
  return (x, y) => {
    const now = Date.now()
    const last = clicks[clicks.length - 1]
    if (last && Math.abs(x - last.x) + Math.abs(y - last.y) < RAGE_PX && now - last.t < RAGE_MS) {
      clicks.push({ x, y, t: now })
      return clicks.length === RAGE_N
    }
    clicks = [{ x, y, t: now }]
    return false
  }
}

const listed = (list: (string | RegExp)[], url: string): boolean => list.some((p) => new RegExp(p).test(url))

/** `data-an-capture-attribute-x` and PostHog's spelling; the closest element wins. */
function captureAttributes(els: Element[]): Props {
  const out: Props = {}
  for (const el of els)
    for (const at of Array.from(el.attributes)) {
      const m = /^data-(?:an|ph)-capture-attribute-(.+)$/.exec(at.name)
      if (m && !(m[1]! in out) && safeVal(at.value)) out[m[1]!] = at.value
    }
  return out
}

/** Installs click / submit / change listeners. Returns the teardown. */
export function autocapture(a: Glyphway): () => void {
  const cfg = a.cfg_.autocapture
  if (!cfg) return () => {}
  const o: AutocaptureOptions = typeof cfg === 'object' ? cfg : {}
  const rage = rageCounter()
  const wanted = (e: Event, els: Element[]): boolean => {
    const url = location.href
    const tags = o.elementAllowlist
    const css = o.cssSelectorAllowlist
    return (
      (!o.urlAllowlist || listed(o.urlAllowlist, url)) &&
      !(o.urlIgnorelist && listed(o.urlIgnorelist, url)) &&
      (!o.domEventAllowlist || o.domEventAllowlist.includes(e.type)) &&
      (!tags || els.some((x) => tags.includes(tag(x)))) &&
      (!css || els.some((x) => css.some((s) => x.matches(s))))
    )
  }
  const handler = (e: Event): void => {
    const el = eventEl(e)
    if (!el) return
    const els = path(el)
    if (els.some(noCapture) || !wanted(e, els)) return
    const type = e.type
    const me = e as MouseEvent
    const props = (): Props => {
      const text = elText(el)
      return {
        ...captureAttributes(els),
        $event_type: type,
        $elements_chain: elementsChain(els, o.elementAttributeIgnorelist),
        ...(text && { $el_text: text }),
        ...(type === 'click' && { $x: me.clientX, $y: me.clientY }),
      }
    }
    if (type === 'click' && rage(me.clientX, me.clientY)) a.capture_('$rageclick', props())
    const tg = tag(el)
    if (type === 'click' ? els.some((x) => TAGS.includes(tag(x))) : type === 'submit' ? tg === 'form' : FIELD.test(tg))
      a.capture_('$autocapture', props())
  }
  const d = document
  const types = ['click', 'submit', 'change']
  types.forEach((ty) => d.addEventListener(ty, handler, true))
  return () => types.forEach((ty) => d.removeEventListener(ty, handler, true))
}
