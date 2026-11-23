import { describe, expect, it, vi } from 'vitest'
import { make, mockFetch, queued, useEnv } from './helpers'
const hr = process.hrtime.bigint.bind(process.hrtime) // taken before fake timers replace it

// L5: the cost of one capture while the offline queue is full (1,000 events near 0.5 KB each).
// The old queue parsed and rewrote the whole stored queue on every push; storage writes are now one small key per event.
describe('capture cost with a full offline queue', () => {
  useEnv()

  it('stays flat: one small write per event, not a rewrite of the queue', () => {
    mockFetch(() => 503)
    const a = make({ maxQueue: 1000 })
    vi.spyOn(a.q_, 'flush').mockResolvedValue()
    const pad = 'x'.repeat(200)
    for (let i = 0; i < 1000; i++) a.capture('fill' + i, { pad })
    expect(queued(a)).toHaveLength(1000)
    const t0 = hr()
    const N = 300
    for (let i = 0; i < N; i++) a.capture('more' + i, { pad })
    const per = Number(hr() - t0) / 1e6 / N
    process.stderr.write(`capture with a full queue: ${per.toFixed(3)} ms each` + "\n")
    expect(queued(a)).toHaveLength(1000)
    expect(per).toBeLessThan(1.2) // before: about 2.4 ms in this setup, after: about 0.3 ms
  })

  it('writes the size of the event to storage, not of the queue', () => {
    mockFetch(() => 503)
    const a = make({ maxQueue: 1000 })
    vi.spyOn(a.q_, 'flush').mockResolvedValue()
    const pad = 'x'.repeat(200)
    for (let i = 0; i < 1000; i++) a.capture('fill' + i, { pad })
    let chars = 0
    const set = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      chars += k.length + v.length
      set.call(this, k, v)
    })
    for (let i = 0; i < 50; i++) a.capture('more' + i, { pad })
    spy.mockRestore()
    expect(chars / 50).toBeLessThan(3_000) // an event is about 0.6 KB; a rewrite of the queue was about 600 KB
  })
})
