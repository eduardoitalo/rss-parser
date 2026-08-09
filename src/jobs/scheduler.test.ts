import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dailyAt, every, isDue } from './scheduler.js'

/** A local-time timestamp, so the assertions don't depend on the test host's TZ. */
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 7, day, hour, minute, 0, 0).getTime()

test('an interval job is due once the interval has elapsed', () => {
  const schedule = every(60_000)
  assert.equal(isDue(schedule, at(1, 12, 0), at(1, 12, 0) + 59_999), false)
  assert.equal(isDue(schedule, at(1, 12, 0), at(1, 12, 1)), true)
  assert.equal(isDue(schedule, 0, at(1, 12, 0)), true, 'never run is due immediately')
})

test('a daily job is due once past midnight and not again that day', () => {
  const schedule = dailyAt(0)

  // Ran yesterday afternoon; midnight has since passed.
  assert.equal(isDue(schedule, at(1, 15), at(2, 0, 1)), true)
  // Ran just after midnight; not due again until tomorrow's.
  assert.equal(isDue(schedule, at(2, 0, 1), at(2, 0, 2)), false)
  assert.equal(isDue(schedule, at(2, 0, 1), at(2, 23, 59)), false)
  assert.equal(isDue(schedule, at(2, 0, 1), at(3, 0, 0)), true)
})

test('a daily job that has never run is due right away', () => {
  assert.equal(isDue(dailyAt(0), 0, at(1, 14)), true)
})

test('a daily job at a non-midnight hour waits for that hour', () => {
  const schedule = dailyAt(3)
  assert.equal(isDue(schedule, at(1, 3, 5), at(2, 2, 59)), false, 'before today’s 03:00')
  assert.equal(isDue(schedule, at(1, 3, 5), at(2, 3, 0)), true)
})
