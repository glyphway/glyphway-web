import type { Props } from './types'

// Names follow posthog-js (`$browser`, `$os` values) so SDK- and edge-parsed
// values agree with what PostHog-shaped tooling expects. Order matters: the
// first match wins (Edge/Opera/Samsung before Chrome, CriOS before Safari).
const BROWSERS: [RegExp, string][] = [
  [/(?:Edg|EdgA|EdgiOS|Edge)\/([\d.]+)/, 'Microsoft Edge'],
  [/SamsungBrowser\/([\d.]+)/, 'Samsung Internet'],
  [/(?:OPR|Opera|OPiOS)\/([\d.]+)/, 'Opera'],
  [/(?:FBAV|FBSV)\/([\d.]+)/, 'Facebook Mobile'],
  [/UCBrowser\/([\d.]+)/, 'UC Browser'],
  [/CriOS\/([\d.]+)/, 'Chrome iOS'],
  [/FxiOS\/([\d.]+)/, 'Firefox iOS'],
  [/Firefox\/([\d.]+)/, 'Firefox'],
  [/(?:MSIE |Trident\/.*rv:)([\d.]+)/, 'Internet Explorer'],
  [/Chrome\/([\d.]+)/, 'Chrome'],
  [/Version\/([\d.]+).*Mobile.*Safari/, 'Mobile Safari'],
  [/Version\/([\d.]+).*Safari/, 'Safari'],
  [/Android.*Version\/([\d.]+)/, 'Android Mobile'],
]

const OSES: [RegExp, string][] = [
  [/Windows Phone(?: OS)? ([\d.]+)/, 'Windows Phone'],
  [/Windows NT ([\d.]+)/, 'Windows'],
  [/(?:iPhone|iPad|iPod).*? OS ([\d_]+)/, 'iOS'],
  [/Android ([\d.]+)/, 'Android'],
  [/CrOS/, 'Chrome OS'],
  [/Mac OS X ([\d_.]+)/, 'Mac OS X'],
  [/Linux/, 'Linux'],
]

const WIN: Record<string, string> = { '10.0': '10', '6.3': '8.1', '6.2': '8', '6.1': '7' }

/** `$browser`, `$browser_version`, `$os`, `$os_version`, `$device_type` from a UA string. */
export function parseUA(ua: string, touchPoints = 0): Props {
  const o: Props = {}
  for (const [re, name] of BROWSERS) {
    const m = ua.match(re)
    if (m) {
      o.$browser = name
      o.$browser_version = parseFloat(m[1]!)
      break
    }
  }
  // iPadOS 13+ sends a desktop Mac UA; touch support gives it away.
  const ipad = /Macintosh/.test(ua) && touchPoints > 1
  for (const [re, name] of OSES) {
    const m = ua.match(re)
    if (m) {
      o.$os = ipad ? 'iOS' : name
      const v = m[1] ? m[1].replace(/_/g, '.') : ''
      if (v) o.$os_version = name === 'Windows' ? WIN[v] || v : v
      break
    }
  }
  o.$device_type =
    ipad || /iPad|Tablet|Kindle|Silk|PlayBook/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
      ? 'Tablet'
      : /Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry/i.test(ua)
        ? 'Mobile'
        : 'Desktop'
  return o
}
