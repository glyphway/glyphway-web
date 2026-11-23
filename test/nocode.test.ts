import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeatureFlags } from '../src/flags'
import { apply, nocode, safeCss, safeHtml } from '../src/nocode'

const page = (html: string): void => {
  document.body.innerHTML = html
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('no-code changes', () => {
  it('sets text and undoes it', () => {
    page('<h1 id="t">Old</h1>')
    const undo = apply({ selector: '#t', text: '<b>New</b>' })!
    expect(document.querySelector('#t')!.textContent).toBe('<b>New</b>')
    expect(document.querySelector('#t b')).toBeNull()
    undo()
    expect(document.querySelector('#t')!.textContent).toBe('Old')
  })

  it('adds declarations to the style and puts the old one back', () => {
    page('<p class="x" style="margin:0">a</p><p class="x">b</p>')
    const undo = apply({ selector: '.x', css: 'color: red' })!
    const ps = document.querySelectorAll<HTMLElement>('.x')
    expect(ps[0]!.style.color).toBe('red')
    expect(ps[0]!.style.margin).toBe('0px')
    expect(ps[1]!.style.color).toBe('red')
    undo()
    expect(ps[0]!.getAttribute('style')).toBe('margin:0')
    expect(ps[1]!.hasAttribute('style')).toBe(false)
  })

  it('replaces markup with safe markup, and restores the children', () => {
    page('<div id="d"><span>old</span></div>')
    const undo = apply({ selector: '#d', html: '<b class="n">new</b>' })!
    expect(document.querySelector('#d')!.innerHTML).toBe('<b class="n">new</b>')
    undo()
    expect(document.querySelector('#d')!.innerHTML).toBe('<span>old</span>')
  })

  it('refuses script, iframe, object and embed, even nested, and any handler or javascript: value', () => {
    page('<div id="d">keep</div>')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = [
      '<script>window.x=1</script>', '<p><b><iframe src="/x"></iframe></b></p>', '<div><object data="x"></object></div>', '<embed src="x">',
      '<img src="x" onerror="window.x=1">', '<a href="javascript:window.x=1">x</a>', '<a href=" java\nscript:window.x=1">x</a>',
      '<template><div><script>1</script></div></template>', '<svg><script>1</script></svg>', '<SCRIPT>1</SCRIPT>',
    ]
    for (const html of bad) {
      expect(safeHtml(html), html).toBeNull()
      expect(apply({ selector: '#d', html }), html).toBeNull()
      expect(document.querySelector('#d')!.textContent).toBe('keep')
    }
    expect(warn).toHaveBeenCalledTimes(bad.length)
    expect(safeHtml('<p>on and <a href="/x">off</a></p>')).not.toBeNull()
  })

  it('refuses what moves the page or hides a javascript: value in a list', () => {
    for (const html of [
      '<base href="https://evil.example/">', '<meta http-equiv="refresh" content="0;url=https://evil.example/">', '<link rel="stylesheet" href="https://evil.example/a.css">',
      '<svg><a><animate attributeName="href" values="x;javascript:alert(1)"/><text>go</text></a></svg>',
    ]) {
      expect(safeHtml(html), html).toBeNull()
    }
  })

  it('refuses css that is not a list of declarations, an invalid selector, and several kinds at once', () => {
    page('<p id="p">a</p>')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(safeCss('color:red;font-weight:700')).toBe(true)
    for (const css of ['a{color:red}', '@import url(x)', 'width:expression(1)', 'background:url(javascript:1)', '</style><script>']) expect(safeCss(css), css).toBe(false)
    expect(apply({ selector: '#p', css: 'x}body{display:none' })).toBeNull()
    expect(apply({ selector: '#p[', text: 'x' })).toBeNull()
    expect(apply({ selector: '#p', text: 'x', css: 'color:red' })).toBeNull()
    expect(apply({ selector: '', text: 'x' })).toBeNull()
    expect(document.querySelector('#p')!.textContent).toBe('a')
  })

  it('touches at most 50 matches', () => {
    page(Array.from({ length: 60 }, () => '<i>a</i>').join(''))
    apply({ selector: 'i', text: 'b' })
    expect(Array.from(document.querySelectorAll('i')).filter((e) => e.textContent === 'b')).toHaveLength(50)
  })
})

type State = Record<string, { v: boolean | string; p?: unknown }>

const fakeFlags = (state: State) => {
  const called: string[] = []
  let cb: ((f: Record<string, boolean | string>) => void) | undefined
  const now = (): Record<string, boolean | string> => {
    const out: Record<string, boolean | string> = {}
    for (const [k, x] of Object.entries(state)) out[k] = x.v
    return out
  }
  const f = {
    onFeatureFlags: (c: typeof cb) => {
      cb = c
      c!(now())
      return () => {
        cb = undefined
      }
    },
    getFeatureFlagPayload: (k: string) => state[k]?.p,
    getFeatureFlag: (k: string) => {
      called.push(k)
      return state[k]?.v
    },
  } as unknown as FeatureFlags
  return { f, called, fire: () => cb?.(now()) }
}

describe('nocode(flags)', () => {
  it('applies after the flags load, reports exposure once per flag, and does not reapply the same answer', () => {
    page('<h1 id="t">Old</h1>')
    const { f, called, fire } = fakeFlags({
      exp: { v: 'test', p: { an_web: [{ selector: '#t', text: 'New' }] } },
      other: { v: true, p: { x: 1 } },
      off: { v: false, p: { an_web: [{ selector: '#t', text: 'Never' }] } },
    })
    const stop = nocode(f)
    expect(document.querySelector('#t')!.textContent).toBe('New')
    expect(called).toEqual(['exp'])
    fire()
    expect(called).toEqual(['exp'])
    stop()
    expect(document.querySelector('#t')!.textContent).toBe('Old')
  })

  it('undoes a variant when the flag answer changes to one without changes', () => {
    page('<h1 id="t">Old</h1>')
    const state: State = { exp: { v: 'test', p: { an_web: [{ selector: '#t', text: 'New' }] } } }
    const { f, fire } = fakeFlags(state)
    nocode(f)
    expect(document.querySelector('#t')!.textContent).toBe('New')
    state.exp = { v: 'control', p: { an_web: [] } }
    fire()
    expect(document.querySelector('#t')!.textContent).toBe('Old')
  })

  it('waits for the document while it is still loading', () => {
    page('<h1 id="t">Old</h1>')
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' })
    const { f } = fakeFlags({ exp: { v: 'test', p: { an_web: [{ selector: '#t', text: 'New' }] } } })
    nocode(f)
    expect(document.querySelector('#t')!.textContent).toBe('Old')
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'complete' })
    document.dispatchEvent(new Event('DOMContentLoaded'))
    expect(document.querySelector('#t')!.textContent).toBe('New')
  })
})
