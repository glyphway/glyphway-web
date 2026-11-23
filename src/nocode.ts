// No-code web experiments. A lazy module: `nocode(flags(glyphway))`.
//
// A flag whose payload is `{ an_web: [{ selector, text | css | html }, …] }` changes the page once
// the flags have loaded. What it refuses is `<script>`, `<iframe>`, `<object>`, `<embed>`, `<base>`,
// `<meta>` and `<link>` at any depth of `html`, any `on*` attribute and any value holding `javascript:`.
// Nothing is ever run: a refused change is skipped with a console warning and the others still apply.
import type { FeatureFlags } from './flags'

export interface Change {
  selector: string
  text?: string
  css?: string
  html?: string
}

// `base` and `meta` can move the page or its links, `link` can pull in a stylesheet.
const BAD_TAGS = ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'BASE', 'META', 'LINK']
const MAX_MATCHES = 50

/** The nodes of `html`, parsed inertly, or null when anything in it could run. */
export function safeHtml(html: string): DocumentFragment | null {
  const t = document.createElement('template')
  t.innerHTML = html
  const walk = (n: Node): boolean => {
    if (n.nodeType === 1) {
      const e = n as Element
      if (BAD_TAGS.includes(e.tagName.toUpperCase())) return false
      for (const a of Array.from(e.attributes)) {
        // anywhere in the value: an SVG `values` list can hide it behind a semicolon
        if (/^on/i.test(a.name) || /javascript:/i.test(a.value.replace(/[\s\u0000-\u001f]/g, ''))) return false
      }
      // a nested template keeps its children apart
      const inner = (e as HTMLTemplateElement).content
      if (inner && !walk(inner)) return false
    }
    return Array.from(n.childNodes).every(walk)
  }
  return walk(t.content) ? t.content : null
}

/** A list of declarations: no block, no `@import`, nothing that calls out to script. */
export function safeCss(css: string): boolean {
  const l = css.toLowerCase()
  return !/[{}<]/.test(css) && !l.includes('@import') && !l.includes('expression(') && !l.includes('javascript:')
}

/** Applies one change; returns how to undo it, or null if it was refused or matched nothing. */
export function apply(c: Change, root: ParentNode = document): (() => void) | null {
  const set = ['text', 'css', 'html'].filter((k) => typeof (c as unknown as Record<string, unknown>)[k] === 'string')
  if (typeof c.selector !== 'string' || !c.selector || set.length !== 1) return refuse(c, 'needs a selector and one of text, css or html')
  let found: Element[]
  try {
    found = Array.from(root.querySelectorAll(c.selector)).slice(0, MAX_MATCHES)
  } catch {
    return refuse(c, 'the selector is not valid')
  }
  const undo: (() => void)[] = []
  if (c.text !== undefined) {
    for (const e of found) {
      const old = e.textContent
      e.textContent = c.text
      undo.push(() => (e.textContent = old))
    }
  } else if (c.css !== undefined) {
    if (!safeCss(c.css)) return refuse(c, 'the css is not a plain list of declarations')
    for (const e of found) {
      const old = e.getAttribute('style')
      ;(e as HTMLElement).style.cssText += ';' + c.css
      undo.push(() => (old === null ? e.removeAttribute('style') : e.setAttribute('style', old)))
    }
  } else {
    if (!safeHtml(c.html!)) return refuse(c, 'the html has a tag that can run or load something, an event handler or a javascript: value')
    for (const e of found) {
      const old = Array.from(e.childNodes)
      e.replaceChildren(safeHtml(c.html!)!.cloneNode(true))
      undo.push(() => e.replaceChildren(...old))
    }
  }
  return () => undo.forEach((u) => u())
}

function refuse(c: Change, why: string): null {
  console.warn(`[glyphway] change for "${String(c.selector)}" skipped: ${why}`)
  return null
}

const changesOf = (payload: unknown): Change[] => {
  const list = payload && typeof payload === 'object' ? (payload as { an_web?: unknown }).an_web : undefined
  return Array.isArray(list) ? (list as Change[]) : []
}

/** Applies the page's no-code variants after the flags load, and again if they change. Returns how to stop. */
export function nocode(f: FeatureFlags, root: ParentNode = document): () => void {
  if (f.analyticsOff) return () => {}
  let undo: (() => void)[] = []
  let shown = ''
  let stopped = false
  const run = (now: Record<string, unknown>): void => {
    const todo: [string, Change[]][] = []
    for (const k of Object.keys(now)) {
      const changes = now[k] === false ? [] : changesOf(f.getFeatureFlagPayload(k))
      if (changes.length) todo.push([k, changes])
    }
    const sig = JSON.stringify(todo.map(([k, c]) => [k, now[k], c]))
    if (sig === shown) return
    shown = sig
    undo.forEach((u) => u())
    undo = []
    for (const [k, changes] of todo) {
      // reading the flag reports `$feature_flag_called`, which is the exposure
      f.getFeatureFlag(k)
      for (const c of changes) {
        const u = apply(c, root)
        if (u) undo.push(u)
      }
    }
  }
  const go = (): void => {
    if (stopped) return
    stopOn = f.onFeatureFlags(run)
  }
  let stopOn = (): void => {}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true })
  else go()
  return () => {
    stopped = true
    stopOn()
    undo.forEach((u) => u())
    undo = []
  }
}
