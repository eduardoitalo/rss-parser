import { config } from '../config.js'
import { listSources, sourcesDueRetry } from '../db.js'
import { log } from '../log.js'
import { describeError } from '../lib/errors.js'
import { type RefreshResult, refreshSource } from '../lib/refresh.js'
import type { JobResult } from './scheduler.js'

/**
 * Refresh every account, one after another with a pause between.
 *
 * This runs twice a day at most: once at boot, so a deploy publishes whatever
 * changed while the old container was down, and once at the scheduled hour (see
 * server.ts). Nothing a reader does triggers a fetch — polling a feed serves
 * what is already stored — so outbound Instagram traffic is a function of the
 * account count alone, which is what a metered residential proxy wants to be
 * billed for.
 *
 * Sequential-with-stagger is the whole throttling strategy: never more than one
 * Instagram request in flight, which is what Instagram's per-IP rate limiting
 * punishes you for ignoring. A 50-account list at the default 5s gap takes a few
 * minutes of wall clock, against a whole day of headroom.
 *
 * Every account is refreshed on every run — there is no per-account due-check.
 * At one run a day a "not yet due" account would only mean a day-old feed.
 */
export async function refreshFeeds(): Promise<JobResult> {
  return runRefreshCycle(listSources(), refreshSource, config.refreshStaggerMs)
}

/**
 * Retry the accounts whose last fetch failed and whose backoff has elapsed (see
 * config.retryBackoffMs). Checked every tick, but the query returns nothing
 * unless something is actually broken, so on a healthy install this does no work
 * at all.
 *
 * It shares the serial guard below with the daily cycle, so "one Instagram
 * request at a time" holds across both — and a retry that comes due mid-cycle is
 * simply dropped, since the cycle is about to refresh that account anyway.
 */
export async function retryFailedFeeds(): Promise<JobResult> {
  return runRefreshCycle(sourcesDueRetry(), refreshSource, config.refreshStaggerMs)
}

/** What the cycle needs off a source row; the rest belongs to refreshSource. */
export interface RefreshTarget {
  id: number
  handle: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Held for the length of a cycle. The scheduler only stops a job overlapping
 * *itself* — ticks are not serialized with each other — so without this the
 * retry pass could start while the daily cycle was still working through the
 * list, and there would be two Instagram requests in flight.
 */
let cycleRunning = false

/**
 * The cycle itself, with its dependencies passed in so a test can drive it
 * without a network, database or filesystem.
 */
export async function runRefreshCycle(
  sources: RefreshTarget[],
  refresh: (sourceId: number) => Promise<RefreshResult>,
  staggerMs: number,
): Promise<JobResult> {
  if (sources.length === 0) return { skipped: true }
  if (cycleRunning) {
    log.debug('a refresh cycle is already running, skipping this one')
    return { skipped: true }
  }
  cycleRunning = true

  try {
    return await refreshEach(sources, refresh, staggerMs)
  } finally {
    cycleRunning = false
  }
}

async function refreshEach(
  sources: RefreshTarget[],
  refresh: (sourceId: number) => Promise<RefreshResult>,
  staggerMs: number,
): Promise<JobResult> {
  let ok = 0
  let failed = 0
  let created = 0
  let deleted = 0
  let mirrored = 0

  for (const [index, source] of sources.entries()) {
    if (index > 0 && staggerMs > 0) await sleep(staggerMs)

    let result: RefreshResult
    try {
      result = await refresh(source.id)
    } catch (err) {
      // refreshSource is contracted never to throw; if it ever does, the rest of
      // the accounts still get their turn.
      failed++
      log.error('refresh threw', { handle: `@${source.handle}`, error: describeError(err) })
      continue
    }

    if (result.status === 'success') {
      ok++
      created += result.created
      deleted += result.deleted
      mirrored += result.mirrored
      log.info('refreshed', {
        handle: `@${source.handle}`,
        http: result.httpStatus,
        ms: result.durationMs,
        items: result.itemCount,
        new: result.created || undefined,
        pruned: result.deleted || undefined,
        images: result.mirrored || undefined,
      })
    } else {
      failed++
      log.warn('refresh failed', {
        handle: `@${source.handle}`,
        http: result.httpStatus,
        error: result.error,
      })
    }
  }

  return {
    // One broken account is not a broken run; every account failing is.
    status: failed > 0 && ok === 0 ? 'error' : 'ok',
    fields: {
      ok,
      failed: failed || undefined,
      new: created || undefined,
      pruned: deleted || undefined,
      images: mirrored || undefined,
    },
  }
}
