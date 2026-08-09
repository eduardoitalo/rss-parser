/**
 * When the next thing is due — the daily job, and the retry after a failure.
 *
 * The daily side lives here because two places need the same answer: the
 * scheduler, to decide whether today's run has already happened, and the status
 * pages, to say when the next one is.
 *
 * Everything is computed in the process's local time, so `TZ` in the container
 * decides what "midnight" means (unset, that's UTC). Local time rather than UTC
 * on purpose: the point of refreshing at midnight is to have the day's posts
 * ready before anyone is awake to read them, and that is a wall-clock claim.
 * The Date arithmetic below goes through setHours/setDate rather than adding
 * 86_400_000, so the two DST days a year land on the right wall-clock hour
 * instead of drifting an hour off.
 */

/** The most recent occurrence of `hour:00` local time, at or before `now`. */
export function previousDailyRun(hour: number, now: number = Date.now()): number {
  const at = new Date(now)
  at.setHours(hour, 0, 0, 0)
  if (at.getTime() > now) at.setDate(at.getDate() - 1)
  return at.getTime()
}

/** The next occurrence of `hour:00` local time, strictly after `now`. */
export function nextDailyRun(hour: number, now: number = Date.now()): number {
  const at = new Date(now)
  at.setHours(hour, 0, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/**
 * How long to wait before retrying an account that has now failed `failures`
 * times in a row: `base`, doubling each time, never more than `cap`.
 *
 * Doubling rather than a fixed interval because the two failure modes want
 * different things — a burned proxy exit IP is gone in minutes, while an
 * account failing all afternoon is not going to be fixed by asking faster.
 */
export function retryBackoff(failures: number, base: number, cap: number): number {
  return Math.min(cap, base * 2 ** Math.max(0, failures - 1))
}
