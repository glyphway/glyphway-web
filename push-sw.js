// Service worker for Glyphway web push. Copy it to your own origin, for
// example /glyphway-push-sw.js, which is where `registerPush` looks for it by default.
//
// It shows the notification and tells the open page what happened, which reports it with
// `$push_received`, `$push_opened` or `$push_dismissed` and the campaign id. When no page is open the
// reports wait here, in memory, for the next page that registers; a worker the browser has stopped
// in the meantime loses them (on purpose: a worker has no write key or identity to report with).
'use strict'

const pending = []

async function tell(kind, data) {
  const msg = { type: 'glyphway_push', kind, data }
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (pages.length) pages.forEach((p) => p.postMessage(msg))
  else if (pending.length < 50) pending.push(msg)
}

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'glyphway_push_ready') {
    while (pending.length) e.source.postMessage(pending.shift())
  }
})

self.addEventListener('push', (e) => {
  let p = {}
  try {
    p = e.data ? e.data.json() : {}
  } catch (_) {
    p = { title: e.data ? e.data.text() : '' }
  }
  const data = p.data || {}
  const options = { body: p.body || '', data }
  if (p.image) options.image = p.image
  if (data.campaign_id) options.tag = 'campaign-' + data.campaign_id
  e.waitUntil(Promise.all([self.registration.showNotification(p.title || '', options), tell('received', data)]))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const data = e.notification.data || {}
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/'
  e.waitUntil(
    (async () => {
      await tell('opened', data)
      const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (pages.length && 'focus' in pages[0]) return pages[0].focus()
      return self.clients.openWindow(url)
    })(),
  )
})

self.addEventListener('notificationclose', (e) => {
  e.waitUntil(tell('dismissed', e.notification.data || {}))
})
