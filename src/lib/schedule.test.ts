import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextDailyRun, previousDailyRun, retryBackoff } from './schedule.js'

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

test('the retry backoff doubles from the base and stops at the cap', () => {
  const backoff = (failures: number): number => retryBackoff(failures, 10, 80)
  assert.deepEqual([1, 2, 3, 4].map(backoff), [10, 20, 40, 80])
  assert.equal(backoff(5), 80, 'capped')
  assert.equal(backoff(99), 80, 'still capped, not overflowed to Infinity')
})

test('the first failure waits the base interval, however it is counted', () => {
  assert.equal(retryBackoff(1, 10, 80), 10)
  assert.equal(retryBackoff(0, 10, 80), 10, 'a zero count still waits, never fires immediately')
})
