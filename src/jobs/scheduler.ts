import { config } from '../config.js'
import { lastJobRun, recordJobRun } from '../db.js'
import { formatDuration, log } from '../log.js'
import { describeError } from '../lib/errors.js'
import { previousDailyRun } from '../lib/schedule.js'

/**
 * The cron replacement: one timer, a static list of jobs, no dependency and no
 * queue table. Each tick asks every job whether it's due; a job that's still
 * running from a previous tick is skipped rather than overlapped.
 *
 * Run times are persisted (see db.job_runs) rather than kept in memory, because
 * with an in-memory timestamp a container that restarts every few hours would
 * run the "daily" jobs every few hours.
 */

export interface JobResult {
  /** Defaults to 'ok'. */
  status?: 'ok' | 'error'
  /** Nothing to do — suppresses the log line entirely. */
  skipped?: boolean
  /** Extra `key=value` detail for the log line. */
  fields?: Record<string, unknown>
}

/**
 * Either "this often" or "once a day at this hour". Housekeeping jobs only care
 * about the rate; the feed refresh has to land at a particular time of day, and
 * an `everyMs: DAY_MS` job drifts later by however long the previous run took
 * plus a tick, which after a few restarts is any hour at all.
 */
export type JobSchedule =
  | { kind: 'every'; ms: number }
  /** Local time — see lib/schedule.ts on what that means in a container. */
  | { kind: 'dailyAt'; hour: number }

export const every = (ms: number): JobSchedule => ({ kind: 'every', ms })
export const dailyAt = (hour: number): JobSchedule => ({ kind: 'dailyAt', hour })

/** Whether a job last run at `lastRunAt` (0 = never) is due at `now`. */
export function isDue(schedule: JobSchedule, lastRunAt: number, now: number): boolean {
  return schedule.kind === 'every'
    ? now - lastRunAt >= schedule.ms
    : lastRunAt < previousDailyRun(schedule.hour, now)
}

export interface Job {
  name: string
  schedule: JobSchedule
  /**
   * Run once shortly after boot as well, whatever the schedule says. For the
   * feed refresh this is what makes a deploy a refresh: the persisted run time
   * would otherwise say today's run already happened.
   */
  runAtStartup?: boolean
  run(): Promise<JobResult>
}

interface JobState {
  job: Job
  running: boolean
  /** A pending `runAtStartup`, cleared by the run it triggers. */
  startupDue: boolean
}

export class Scheduler {
  private readonly states: JobState[]
  private timer: NodeJS.Timeout | undefined
  private lastTickAt = 0

  constructor(jobs: Job[]) {
    this.states = jobs.map((job) => ({
      job,
      running: false,
      startupDue: job.runAtStartup ?? false,
    }))
  }

  start(): void {
    // A short delay so the HTTP server is listening and /healthz is green before
    // any outbound proxy traffic starts.
    setTimeout(() => {
      void this.tick()
      this.timer = setInterval(() => void this.tick(), config.tickIntervalMs)
    }, 5_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** For /healthz: whether the scheduler is actually turning over. */
  get lastTick(): number {
    return this.lastTickAt
  }

  private async tick(): Promise<void> {
    this.lastTickAt = Date.now()
    for (const state of this.states) {
      if (state.running) {
        log.debug('job still running, skipping this tick', { job: state.job.name })
        continue
      }
      const last = lastJobRun(state.job.name) ?? 0
      if (!state.startupDue && !isDue(state.job.schedule, last, Date.now())) continue
      state.startupDue = false

      state.running = true
      const startedAt = Date.now()
      try {
        const result = await state.job.run()
        const elapsed = Date.now() - startedAt
        const status = result.status ?? 'ok'
        recordJobRun(state.job.name, result.skipped ? 'skipped' : status, elapsed)
        if (!result.skipped) {
          const line = { job: state.job.name, ...result.fields, took: formatDuration(elapsed) }
          if (status === 'error') log.warn('job finished with errors', line)
          else log.info('job', line)
        }
      } catch (err) {
        // A throwing job must never take the tick loop down with it.
        const elapsed = Date.now() - startedAt
        recordJobRun(state.job.name, 'error', elapsed)
        log.error('job threw', {
          job: state.job.name,
          error: describeError(err),
          took: formatDuration(elapsed),
        })
      } finally {
        state.running = false
      }
    }
  }
}
