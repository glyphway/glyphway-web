import { describe, expect, it, vi } from 'vitest'
import { elementsChain } from '../src/autocapture'
import { make, queued, useEnv } from './helpers'

const click = (el: Element, x = 10, y = 20): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: x, clientY: y }))
}
const html = (s: string): void => {
  document.body.innerHTML = s
}
const $ = (sel: string): Element => document.querySelector(sel)!
const auto = (a: ReturnType<typeof make>) => queued(a).filter((e) => e.event === '$autocapture')

describe('autocapture', () => {
  useEnv()

  it('captures a click on a button with $event_type, $el_text, $elements_chain, $x/$y and viewport', () => {
    const a = make({ autocapture: true })
    html('<div id="root" class="page"><button id="buy" class="btn primary" data-sku="42">Buy <span>now</span></button></div>')
    click($('#buy'), 111, 222)
    const [e] = auto(a)
    expect(e!.properties).toMatchObject({
      $event_type: 'click',
      $el_text: 'Buy now',
      $x: 111,
      $y: 222,
      $viewport_width: innerWidth,
      $viewport_height: innerHeight,
    })
    expect(e!.properties.$elements_chain).toBe(
      'button.btn.primary:attr__class="btn primary"attr__data-sku="42"attr__id="buy"attr_id="buy"nth-child="1"nth-of-type="1"text="Buy now";' +
        'div.page:attr__class="page"attr__id="root"attr_id="root"nth-child="1"nth-of-type="1";' +
        'body:nth-child="2"nth-of-type="1"',
    )
  })

  it('captures clicks on descendants of interactive elements, with the anchor href on the target', () => {
    const a = make({ autocapture: true })
    html('<p>x</p><a href="/pricing" class="nav">  <span class="label">Pricing</span></a>')
    click($('.label'))
    const [e] = auto(a)
    expect(e!.properties.$el_text).toBe('Pricing')
    const chain = e!.properties.$elements_chain as string
    expect(chain.startsWith('span.label:attr__class="label"attr__href="/pricing"href="/pricing"nth-child="1"nth-of-type="1"text="Pricing";')).toBe(true)
    expect(chain).toContain(';a.nav:attr__class="nav"attr__href="/pricing"href="/pricing"nth-child="2"nth-of-type="1"text="Pricing";')
  })

  it('ignores clicks on non-interactive elements', () => {
    const a = make({ autocapture: true })
    html('<div><p id="t">hello</p></div>')
    click($('#t'))
    expect(auto(a)).toHaveLength(0)
  })

  it('captures submit on forms and change on input/select/textarea', () => {
    const a = make({ autocapture: true })
    html('<form id="f"><input id="i" name="q"><select id="s"><option>a</option></select><textarea id="ta"></textarea></form>')
    $('#f').dispatchEvent(new Event('submit', { bubbles: true }))
    for (const id of ['#i', '#s', '#ta']) $(id).dispatchEvent(new Event('change', { bubbles: true }))
    expect(auto(a).map((e) => [e.properties.$event_type, (e.properties.$elements_chain as string).split(':')[0]])).toEqual([
      ['submit', 'form'],
      ['change', 'input'],
      ['change', 'select'],
      ['change', 'textarea'],
    ])
    expect(auto(a)[0]!.properties.$x).toBeUndefined()
  })

  it('never captures input values or password fields', () => {
    const a = make({ autocapture: true })
    const SECRET = 'hunter2-SECRET'
    html(
      `<form><label for="p">Password</label>` +
        `<input id="p" type="password" name="password" value="${SECRET}" placeholder="${SECRET}" data-x="${SECRET}">` +
        `<input id="t" type="text" name="nickname" value="${SECRET}" aria-label="Nick" title="${SECRET}">` +
        `<input id="sub" type="submit" value="${SECRET}">` +
        `<textarea id="ta" name="bio">${SECRET}</textarea>` +
        `<select id="s" name="pick"><option selected>${SECRET}</option></select>` +
        `<div contenteditable="true" id="ce"><button id="b">${SECRET}</button></div>` +
        `<button id="ok">Save</button></form>`,
    )
    $('form').addEventListener('submit', (e) => e.preventDefault())
    ;($('#p') as HTMLInputElement).value = SECRET + '-typed'
    ;($('#t') as HTMLInputElement).value = SECRET + '-typed'
    for (const id of ['#p', '#t', '#ta', '#s']) {
      click($(id))
      $(id).dispatchEvent(new Event('change', { bubbles: true }))
    }
    click($('#sub'))
    click($('#b'))
    click($('#ok'))
    $('form').dispatchEvent(new Event('submit', { bubbles: true }))
    const evs = auto(a)
    expect(evs.length).toBeGreaterThanOrEqual(10)
    const json = JSON.stringify(evs)
    expect(json).not.toContain('hunter2')
    // fields keep only name / id / class / aria-label
    const pw = evs.find((e) => (e.properties.$elements_chain as string).startsWith('input:attr__id="p"'))!
    expect(pw.properties.$el_text).toBeUndefined()
    expect(pw.properties.$elements_chain).toMatch(/^input:attr__id="p"attr__name="password"attr_id="p"nth-child="2"nth-of-type="1";/)
    const t = evs.find((e) => (e.properties.$elements_chain as string).startsWith('input:attr__aria-label'))!
    expect(t.properties.$elements_chain).toMatch(/^input:attr__aria-label="Nick"attr__id="t"attr__name="nickname"attr_id="t"/)
  })

  it('drops card- and SSN-like text and attribute values', () => {
    const a = make({ autocapture: true })
    html('<button data-card="4111 1111 1111 1111" id="b">Pay 4111-1111-1111-1111 now 123-45-6789</button>')
    click($('#b'))
    const e = auto(a)[0]!
    expect(JSON.stringify(e)).not.toMatch(/4111|6789/)
    expect(e.properties.$el_text).toBe('Pay now')
  })

  it.each([
    ['.an-no-capture', '<div class="an-no-capture"><button id="b">x</button></div>'],
    ['[data-an-no-capture]', '<div data-an-no-capture><button id="b">x</button></div>'],
    ['.ph-no-capture', '<button id="b" class="ph-no-capture">x</button>'],
  ])('skips elements (and descendants) marked %s', (_, markup) => {
    const a = make({ autocapture: true })
    html(markup)
    for (let i = 0; i < 3; i++) click($('#b'))
    expect(queued(a)).toHaveLength(0) // no $autocapture and no $rageclick
  })

  it('autocapture: false installs nothing', () => {
    const a = make({ autocapture: false })
    html('<button id="b">x</button>')
    click($('#b'))
    expect(queued(a)).toHaveLength(0)
  })

  it('keeps $elements_chain within 2 KB by dropping outer ancestors', () => {
    let markup = '<button id="b" class="c">deep</button>'
    for (let i = 0; i < 40; i++) markup = `<div class="wrapper-${i} some-long-class-name another-long-class-name">${markup}</div>`
    const a = make({ autocapture: true })
    html(markup)
    click($('#b'))
    const chain = auto(a)[0]!.properties.$elements_chain as string
    expect(new TextEncoder().encode(chain).length).toBeLessThanOrEqual(2048)
    expect(chain.startsWith('button.c:')).toBe(true)
    // whole elements only: every segment parses as tag[.class]*:key="value"...
    for (const seg of chain.split(';')) expect(seg).toMatch(/^[a-z]+(\.[^.:]+)*:([a-z_-]+="[^"]*")+$/)
  })

  it('falls back to a minimal element when the target alone exceeds 2 KB', () => {
    html(`<button id="b" data-a="${'a'.repeat(1000)}" data-b="${'b'.repeat(1000)}" data-c="${'c'.repeat(1000)}">x</button>`)
    const chain = elementsChain([$('#b'), document.body])
    expect(chain.length).toBeLessThanOrEqual(2048)
    expect(chain.startsWith('button:nth-child="1"nth-of-type="1"text="x"')).toBe(true)
  })

  it('escapes quotes the PostHog way and sorts classes', () => {
    html('<a id="q" class="z a" title=\'say "hi"\' href="/x">Q</a>')
    expect(elementsChain([$('#q')])).toBe(
      'a.a.z:attr__class="z a"attr__href="/x"attr__id="q"attr__title="say \\"hi\\""attr_id="q"href="/x"nth-child="1"nth-of-type="1"text="Q"',
    )
  })
})

describe('$rageclick (3 clicks within 30 px and 1 s)', () => {
  useEnv()
  const rage = (a: ReturnType<typeof make>) => queued(a).filter((e) => e.event === '$rageclick')

  it('fires once on the third close, quick click (on any element)', () => {
    const a = make({ autocapture: true })
    html('<div id="d">not a button</div>')
    click($('#d'), 100, 100)
    vi.advanceTimersByTime(300)
    click($('#d'), 110, 105)
    vi.advanceTimersByTime(300)
    expect(rage(a)).toHaveLength(0)
    click($('#d'), 115, 110)
    expect(rage(a)).toHaveLength(1)
    expect(rage(a)[0]!.properties).toMatchObject({ $event_type: 'click', $x: 115, $y: 110 })
    expect(rage(a)[0]!.properties.$elements_chain).toMatch(/^div:attr__id="d"/)
    vi.advanceTimersByTime(100)
    click($('#d'), 115, 110) // 4th: no second event
    expect(rage(a)).toHaveLength(1)
  })

  it('does not fire when clicks are 30 px apart (Manhattan) or 1 s apart', () => {
    const a = make({ autocapture: true })
    html('<div id="d">x</div>')
    click($('#d'), 0, 0)
    click($('#d'), 15, 15) // distance 30: not < 30 -> restarts
    click($('#d'), 15, 16)
    expect(rage(a)).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    click($('#d'), 15, 16) // 1000 ms after the last: restarts
    vi.advanceTimersByTime(999)
    click($('#d'), 15, 16)
    expect(rage(a)).toHaveLength(0)
    vi.advanceTimersByTime(999)
    click($('#d'), 15, 16)
    expect(rage(a)).toHaveLength(1)
  })

  it('a rage click on a button also yields the three $autocapture events', () => {
    const a = make({ autocapture: true })
    html('<button id="b">Go</button>')
    for (let i = 0; i < 3; i++) click($('#b'))
    expect(queued(a).map((e) => e.event)).toEqual(['$autocapture', '$autocapture', '$rageclick', '$autocapture'])
  })
})
