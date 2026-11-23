import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAutocapture } from '../src/core'
import { autocapture } from '../src/autocapture'
import { full } from '../src/enhanced'
import { make, queued, useEnv } from './helpers'

const html = (s: string): void => {
  document.body.innerHTML = s
}
const $ = (sel: string): Element => document.querySelector(sel)!
const click = (el: Element, x = 10, y = 20): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: x, clientY: y }))
}
const named = (a: ReturnType<typeof make>, n: string) => queued(a).filter((e) => e.event === n)

function page(scrollHeight: number, clientHeight: number, scrollTop: number): void {
  const d = document.documentElement
  Object.defineProperty(d, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(d, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(d, 'scrollTop', { configurable: true, value: scrollTop })
  window.dispatchEvent(new Event('scroll'))
}

describe('full build capture', () => {
  useEnv()
  beforeEach(() => {
    setAutocapture(full)
  })
  afterEach(() => {
    setAutocapture(autocapture)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
  })

  describe('heatmaps', () => {
    it('adds page scroll to a click, but not on a fixed element', () => {
      const a = make({ deadClicks: false })
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 300 })
      html('<div id="n">x</div><div id="f" style="position: fixed">y</div>')
      click($('#n'))
      click($('#f'), 50, 60)
      vi.advanceTimersByTime(5000)
      const [e] = named(a, '$$heatmap')
      const points = Object.values(e!.properties.$heatmap_data as Record<string, unknown[]>)[0]
      expect(points).toEqual([
        { x: 10, y: 320, target_fixed: false, type: 'click' },
        { x: 50, y: 60, target_fixed: true, type: 'click' },
      ])
    })

    it('records a mouse move 500 ms after it stops, once', () => {
      const a = make({ deadClicks: false })
      html('<p id="p">x</p>')
      for (const x of [1, 2, 3]) {
        $('#p').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: 5 }))
        vi.advanceTimersByTime(100)
      }
      vi.advanceTimersByTime(5000)
      const points = Object.values(named(a, '$$heatmap')[0]!.properties.$heatmap_data as Record<string, { x: number; type: string }[]>)[0]
      expect(points).toMatchObject([{ x: 3, type: 'mousemove' }])
    })

    it('marks rage clicks and sends what is left when the page hides', () => {
      const a = make({ deadClicks: false })
      html('<p id="p">x</p>')
      for (let i = 0; i < 3; i++) click($('#p'))
      vi.advanceTimersByTime(5000)
      const types = Object.values(named(a, '$$heatmap')[0]!.properties.$heatmap_data as Record<string, { type: string }[]>)[0]!.map((p) => p.type)
      expect(types).toEqual(['click', 'click', 'click', 'rageclick'])
      click($('#p'))
      const hook = vi.spyOn(a, 'capture_')
      window.dispatchEvent(new Event('pagehide'))
      expect(hook.mock.calls.map((c) => c[0])).toContain('$$heatmap')
    })

    it('can be switched off', () => {
      const off = make({ heatmaps: false })
      html('<p id="p">x</p>')
      click($('#p'))
      vi.advanceTimersByTime(5000)
      expect(named(off, '$$heatmap')).toEqual([])
    })

    it('leaves out an-no-capture elements', () => {
      const a = make({ deadClicks: false })
      html('<p id="p" class="an-no-capture">x</p>')
      click($('#p'))
      vi.advanceTimersByTime(5000)
      expect(named(a, '$$heatmap')).toEqual([])
    })
  })

  describe('dead clicks', () => {
    it('fires at 2,750 ms when nothing happens', () => {
      const a = make({ heatmaps: false })
      html('<div id="d">Nothing</div>')
      click($('#d'), 7, 8)
      vi.advanceTimersByTime(2749)
      expect(named(a, '$dead_click')).toEqual([])
      vi.advanceTimersByTime(1)
      expect(named(a, '$dead_click')[0]!.properties).toMatchObject({ $x: 7, $y: 8, $el_text: 'Nothing' })
    })

    it('a mutation at 2,000 ms makes it live, one at 2,600 ms does not', async () => {
      const a = make({ heatmaps: false })
      html('<div id="d">x</div><div id="e">y</div>')
      click($('#d'))
      vi.advanceTimersByTime(2000)
      $('#d').setAttribute('data-x', '1')
      await vi.advanceTimersByTimeAsync(1000)
      expect(named(a, '$dead_click')).toEqual([])
      click($('#e'))
      vi.advanceTimersByTime(2600)
      $('#e').setAttribute('data-x', '1')
      await vi.advanceTimersByTimeAsync(1000)
      expect(named(a, '$dead_click')).toHaveLength(1)
    })

    it('a scroll within 100 ms makes it live; fields are skipped; a repeat counts once', () => {
      const a = make({ heatmaps: false })
      html('<div id="d">x</div><input id="i">')
      click($('#d'))
      vi.advanceTimersByTime(50)
      window.dispatchEvent(new Event('scroll'))
      vi.advanceTimersByTime(3000)
      expect(named(a, '$dead_click')).toEqual([])
      click($('#i'))
      vi.advanceTimersByTime(3000)
      expect(named(a, '$dead_click')).toEqual([])
      click($('#d'))
      vi.advanceTimersByTime(500)
      click($('#d'))
      vi.advanceTimersByTime(3000)
      expect(named(a, '$dead_click')).toHaveLength(1)
    })

    it('a dead click also lands on the heatmap', () => {
      const a = make({})
      html('<div id="d">x</div>')
      click($('#d'))
      vi.advanceTimersByTime(5000)
      const types = Object.values(named(a, '$$heatmap')[0]!.properties.$heatmap_data as Record<string, { type: string }[]>)[0]!.map((p) => p.type)
      expect(types).toEqual(['click', 'deadclick'])
    })
  })

  describe('scroll depth', () => {
    it('reports the page left on $pageleave and the next $pageview', () => {
      const a = make({ capturePageview: true })
      page(2000, 500, 750)
      page(2000, 500, 300)
      vi.advanceTimersByTime(2000)
      history.pushState({}, '', '/next')
      const left = named(a, '$pageleave')[0]!.properties
      expect(left).toMatchObject({
        $prev_pageview_duration: 2,
        $prev_pageview_max_scroll: 750,
        $prev_pageview_max_scroll_percentage: 0.5,
        $prev_pageview_last_scroll: 300,
        $prev_pageview_last_scroll_percentage: 0.2,
        $prev_pageview_max_content: 1250,
        $prev_pageview_max_content_percentage: 0.625,
        $prev_pageview_last_content: 800,
        $prev_pageview_last_content_percentage: 0.4,
      })
      const views = named(a, '$pageview')
      expect(views[0]!.properties.$prev_pageview_max_scroll).toBeUndefined()
      expect(views[1]!.properties.$prev_pageview_max_scroll).toBe(750)
    })

    it('a page that cannot scroll counts as 100%', () => {
      page(500, 500, 0)
      const a = make({ capturePageview: true })
      history.pushState({}, '', '/flat')
      expect(named(a, '$pageleave')[0]!.properties.$prev_pageview_max_scroll_percentage).toBe(1)
    })
  })

  describe('enhanced measurement', () => {
    it('$scroll fires once, at 90% of the page visible', () => {
      const a = make({})
      page(2000, 500, 1250)
      expect(named(a, '$scroll')).toEqual([])
      page(2000, 500, 1300)
      page(2000, 500, 1400)
      expect(named(a, '$scroll').map((e) => e.properties.$percent_scrolled)).toEqual([90])
    })

    it('tells outbound links and downloads from ordinary links', () => {
      const a = make({})
      html(
        '<a id="o" class="x" href="https://other.org/a">Out</a><a id="f" href="/files/report.PDF">Get</a>' +
          '<a id="i" href="/about">In</a><a id="m" href="mailto:a@b.c">Mail</a>',
      )
      for (const id of ['#o', '#f', '#i', '#m']) {
        $(id).addEventListener('click', (e) => e.preventDefault())
        click($(id))
      }
      expect(named(a, '$outbound_click').map((e) => e.properties)).toMatchObject([
        { $link_url: 'https://other.org/a', $link_domain: 'other.org', $link_text: 'Out', $link_id: 'o', $link_classes: 'x' },
      ])
      expect(named(a, '$file_download').map((e) => e.properties)).toMatchObject([{ $file_name: '/files/report.PDF', $file_extension: 'pdf' }])
    })

    it('form start fires once a session; submit reads no values', () => {
      const a = make({})
      html('<form id="f" name="signup" action="/go"><input id="i" value="secret"></form>')
      $('#i').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      $('#i').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      $('#f').addEventListener('submit', (e) => e.preventDefault())
      $('#f').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      expect(named(a, '$form_start').map((e) => e.properties)).toMatchObject([{ $form_id: 'f', $form_name: 'signup', $form_destination: '/go' }])
      expect(named(a, '$form_submit')).toHaveLength(1)
      expect(JSON.stringify(queued(a))).not.toContain('secret')
    })

    it('finds a search term in the URL', () => {
      ;(window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://example.test/results?keyword=boots&page=2')
      const a = make({ capturePageview: true })
      expect(named(a, '$view_search_results').map((e) => e.properties.$search_term)).toEqual(['boots'])
    })

    it('a 100 s video at 26 s has passed 10 and 25, once each', () => {
      const a = make({})
      html('<video id="v" title="Tour"></video>')
      const v = $('#v') as HTMLVideoElement
      Object.defineProperty(v, 'duration', { configurable: true, value: 100 })
      Object.defineProperty(v, 'currentTime', { configurable: true, writable: true, value: 0 })
      v.dispatchEvent(new Event('play'))
      v.dispatchEvent(new Event('play'))
      v.currentTime = 26
      v.dispatchEvent(new Event('timeupdate'))
      v.dispatchEvent(new Event('timeupdate'))
      expect(named(a, '$video_start')).toHaveLength(1)
      expect(named(a, '$video_progress').map((e) => e.properties.$video_percent)).toEqual([10, 25])
      v.dispatchEvent(new Event('ended'))
      expect(named(a, '$video_complete').map((e) => e.properties)).toMatchObject([{ $video_title: 'Tour', $video_provider: 'html5', $video_percent: 100 }])
    })

    it('can be switched off', () => {
      const a = make({ enhancedMeasurement: false })
      html('<a id="o" href="https://other.org/a">Out</a>')
      $('#o').addEventListener('click', (e) => e.preventDefault())
      click($('#o'))
      page(2000, 500, 1400)
      expect(named(a, '$outbound_click')).toEqual([])
      expect(named(a, '$scroll')).toEqual([])
    })
  })

  describe('autocapture options', () => {
    const auto = (a: ReturnType<typeof make>) => named(a, '$autocapture')

    it('allow and ignore lists decide what is captured', () => {
      html('<button id="b">x</button><a id="l" class="go" href="#">y</a>')
      const tags = make({ autocapture: { elementAllowlist: ['a'] } })
      click($('#b'))
      click($('#l'))
      expect(auto(tags)).toHaveLength(1)
    })

    it('a URL on the ignore list captures nothing', () => {
      const a = make({ autocapture: { urlIgnorelist: ['.*'] } })
      html('<button id="b">x</button>')
      click($('#b'))
      expect(auto(a)).toEqual([])
    })

    it('a selector allowlist and an event allowlist narrow it further', () => {
      const a = make({ autocapture: { cssSelectorAllowlist: ['[data-track]'], domEventAllowlist: ['click'] } })
      html('<button id="b">x</button><div data-track><button id="c">y</button></div>')
      click($('#b'))
      click($('#c'))
      expect(auto(a)).toHaveLength(1)
    })

    it('leaves ignored attributes out of the chain', () => {
      const a = make({ autocapture: { elementAttributeIgnorelist: ['data-email'] } })
      html('<button id="b" data-email="a@b.c">x</button>')
      click($('#b'))
      expect(auto(a)[0]!.properties.$elements_chain).not.toContain('a@b.c')
    })

    it('capture attributes become properties, the closest winning', () => {
      const a = make({ autocapture: true })
      html('<div data-an-capture-attribute-plan="outer" data-ph-capture-attribute-team="red"><button id="b" data-an-capture-attribute-plan="pro">x</button></div>')
      click($('#b'))
      expect(auto(a)[0]!.properties).toMatchObject({ plan: 'pro', team: 'red' })
    })
  })
})
