import { config } from '../config.js'
import { listSources } from '../db.js'
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
 * At one run a day a "not yet due" account would simply mean a day-old feed, and
 * a failed fetch waits for tomorrow's run rather than a backoff of its own.
 */
export async function refreshFeeds(): Promise<JobResult> {
  return runRefreshCycle(listSources(), refreshSource, config.refreshStaggerMs)
}

/** What the cycle needs off a source row; the rest belongs to refreshSource. */
export interface RefreshTarget {
  id: number
  handle: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
