import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextDailyRun, previousDailyRun } from './schedule.js'

const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 7, day, hour, minute, 0, 0).getTime()

test('previousDailyRun is today’s occurrence once it has passed', () => {
  assert.equal(previousDailyRun(0, at(5, 14)), at(5, 0))
  assert.equal(previousDailyRun(0, at(5, 0)), at(5, 0), 'exactly on the hour counts as passed')
})

test('previousDailyRun falls back to yesterday before the hour', () => {
  assert.equal(previousDailyRun(3, at(5, 2, 59)), at(4, 3))
})

test('nextDailyRun is strictly in the future', () => {
  assert.equal(nextDailyRun(0, at(5, 14)), at(6, 0))
  assert.equal(nextDailyRun(0, at(5, 0)), at(6, 0), 'on the hour, the next one is tomorrow')
  assert.equal(nextDailyRun(3, at(5, 2, 59)), at(5, 3))
})
