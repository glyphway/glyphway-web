export type Props = Record<string, unknown>

/** One event on the wire. */
export interface GlyphwayEvent {
  event: string
  distinct_id: string
  /** UUIDv7, generated once per event and reused on every retry (dedupe key). */
  uuid: string
  /** ISO-8601 with ms, client clock at capture. */
  timestamp: string
  properties: Props
}

/** What autocapture listens to (posthog-js option names, in camelCase). */
export interface AutocaptureOptions {
  /** Capture only on URLs matching one of these regexes. */
  urlAllowlist?: (string | RegExp)[]
  /** Never capture on URLs matching one of these regexes. */
  urlIgnorelist?: (string | RegExp)[]
  /** DOM events to capture, from `click`, `change`, `submit`. */
  domEventAllowlist?: string[]
  /** Capture only when the target or an ancestor is one of these tags. */
  elementAllowlist?: string[]
  /** Capture only when the target or an ancestor matches one of these selectors. */
  cssSelectorAllowlist?: string[]
  /** Attribute names left out of `$elements_chain`. */
  elementAttributeIgnorelist?: string[]
}

/** What the SDK can do; `features` turns parts on. See "Choosing features" in the README. */
export type Feature = 'analytics' | 'errors' | 'performance' | 'replay' | 'flags' | 'remoteConfig' | 'push' | 'surveys' | 'messages'

export interface Options {
  /** Edge base URL: the edge address that came with your Glyphway access. Required. */
  host: string
  /** Your build's version, sent as `$app_version`: crash-free rates and regressions go by it. */
  release?: string
  /** Adds `$debug: true` to every event and logs to the console. Default `false`. */
  debug?: boolean
  /** Click / submit / change autocapture and `$rageclick`. Default `true` (needs the full build). */
  autocapture?: boolean | AutocaptureOptions
  /** `$$heatmap` click and mouse-move positions. Default `true` (needs the full build). */
  heatmaps?: boolean
  /** `$dead_click`: a click that changed nothing. Default `true` (needs the full build). */
  deadClicks?: boolean
  /** Outbound clicks, downloads, forms, scroll, video and site search. Default `true` (needs the full build). */
  enhancedMeasurement?: boolean
  /** `$pageview` on load and on SPA history changes. Default `true`. */
  capturePageview?: boolean
  /** `$pageleave` with `$engagement_ms`. Defaults to the value of `capturePageview`. */
  capturePageleave?: boolean
  /** Where identity, session, super properties and the queue live. Default `'localStorage'`. */
  persistence?: 'localStorage' | 'memory'
  /**
   * Cookieless mode (posthog-js `cookieless_mode`): nothing is written to cookies, local or session
   * storage, so every page load is a new anonymous visitor. `'always'` from the start; `'on_reject'`
   * once `optOut()` is called. The project must also switch cookieless mode on (Settings), or these
   * events are dropped.
   */
  cookielessMode?: 'always' | 'on_reject'
  /** Read the project's web SDK switches (autocapture, dead clicks, heatmaps, cookieless) from the edge. Default `true`. */
  projectSettings?: boolean
  /** Start opted out until `optIn()` is called (the choice is remembered). Default `false`. */
  optOutByDefault?: boolean
  /** Flush timer. Default 10000 ms. A flush also happens at 20 queued events and on page hide. */
  flushIntervalMs?: number
  /** Queue bound in events (the byte bound is fixed at 1 MB). Default 1000. */
  maxQueue?: number
  /** Request body compression. `'gzip'` uses `CompressionStream` when available. Default `'gzip'`. */
  compression?: 'gzip' | 'none'
  /** Where `glyphway.toolbar.js` is, for a page opened from the app's "Open toolbar". Default: beside the SDK script. */
  toolbarUrl?: string
  /**
   * The features to run; the others start nothing. Default: all of them. Without `'analytics'` the app's `capture()`,
   * pageviews, autocapture and the toolbar are off, and one `$session_start` per new session is sent instead.
   */
  features?: Feature[]
  /** Last hook before an event is queued. Return the (possibly modified) event, or null to drop it. */
  beforeSend?: (event: GlyphwayEvent) => GlyphwayEvent | null | undefined
}

export type Config = Required<Omit<Options, 'beforeSend' | 'cookielessMode' | 'features'>> & Pick<Options, 'beforeSend' | 'cookielessMode' | 'features'>
