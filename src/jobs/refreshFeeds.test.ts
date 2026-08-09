import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type RefreshTarget, runRefreshCycle } from './refreshFeeds.js'
import type { RefreshResult } from '../lib/refresh.js'

const ok: RefreshResult = {
  status: 'success',
  itemCount: 3,
  created: 1,
  updated: 0,
  deleted: 0,
  mirrored: 1,
  httpStatus: 200,
  durationMs: 1,
}

const failure: RefreshResult = {
  status: 'error',
  itemCount: 0,
  created: 0,
  updated: 0,
  deleted: 0,
  mirrored: 0,
  httpStatus: 401,
  durationMs: 1,
  error: 'nope',
}

const sources = (...ids: number[]): RefreshTarget[] => ids.map((id) => ({ id, handle: `h${id}` }))

/** Yield to the microtask queue, so a stub's awaits get a chance to interleave. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('every source is refreshed, in order, without a due-check', async () => {
  const calls: number[] = []
  const result = await runRefreshCycle(
    sources(1, 2, 3),
    async (id) => {
      calls.push(id)
      return ok
    },
    0,
  )

  assert.deepEqual(calls, [1, 2, 3])
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.fields, {
    ok: 3,
    failed: undefined,
    new: 3,
    pruned: undefined,
    images: 3,
  })
})

test('refreshes run one after another, never concurrently', async () => {
  const events: string[] = []
  let inside = 0

  await runRefreshCycle(
    sources(1, 2),
    async (id) => {
      inside++
      assert.equal(inside, 1, 'never more than one refresh in flight')
      events.push(`start-${id}`)
      await tick()
      events.push(`end-${id}`)
      inside--
      return ok
    },
    0,
  )

  assert.deepEqual(events, ['start-1', 'end-1', 'start-2', 'end-2'])
})

test('the cycle waits the stagger between fetches, but not before the first', async () => {
  const startedAt = Date.now()
  await runRefreshCycle(sources(1, 2, 3), async () => ok, 20)
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed >= 40, `two gaps of 20ms, got ${elapsed}ms`)
  assert.ok(elapsed < 200, `and no more than that, got ${elapsed}ms`)
})

test('a failing source does not stop the ones after it', async () => {
  const calls: number[] = []
  const result = await runRefreshCycle(
    sources(1, 2, 3),
    async (id) => {
      calls.push(id)
      if (id === 1) throw new Error('boom')
      return id === 2 ? failure : ok
    },
    0,
  )

  assert.deepEqual(calls, [1, 2, 3])
  assert.equal(result.status, 'ok', 'one success is enough for an ok run')
  assert.equal(result.fields?.ok, 1)
  assert.equal(result.fields?.failed, 2)
})

test('a run where every source failed is reported as an error', async () => {
  const result = await runRefreshCycle(sources(1, 2), async () => failure, 0)
  assert.equal(result.status, 'error')
})

test('no sources is a skipped run, not an empty one', async () => {
  const result = await runRefreshCycle([], async () => ok, 0)
  assert.deepEqual(result, { skipped: true })
})
