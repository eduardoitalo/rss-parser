import path from 'node:path'

/**
 * Every tunable knob lives here, in the repo, so changing one is a commit —
 * the same workflow as adding a line to accounts.txt. Only values that are
 * secret (the proxy credentials) or that differ per deployment (origin, port)
 * come from the environment.
 *
 * The defaults reproduce the behaviour of the Payload build this replaced,
 * where these were admin-editable settings.
 */

const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

/** Strip trailing slashes so `${publicBaseUrl}/assets/x` never doubles up. */
const normalizeBaseUrl = (url: string): string => url.replace(/\/+$/, '')

export const config = {
  // ---- deployment / secrets: environment only -----------------------------

  port: Number(env('PORT') ?? 3000),

  /**
   * The origin this instance is reachable at. Feed URLs, the `<img>` URLs
   * embedded in item content, and the RSS channel `<link>` are all built from
   * it — behind a reverse proxy the request's own host is the internal
   * container address, so it can't be derived. Changing it rewrites the stored
   * absolute asset URLs on the next boot (see db.ts).
   */
  publicBaseUrl: normalizeBaseUrl(env('PUBLIC_BASE_URL') ?? 'http://localhost:3000'),

  /** debug | info | warn | error */
  logLevel: env('LOG_LEVEL') ?? 'info',

  // OUTBOUND_PROXY_URL is deliberately not read here — lib/proxy.ts owns it, so
  // the credentials it contains never pass through the logged config object.

  // ---- committed knobs ----------------------------------------------------

  /**
   * The feed list. One username per line; "#" comments and blanks ignored.
   * Committed to the repo, but overridable so it can be bind-mounted into a
   * container and edited without an image rebuild.
   */
  accountsFile: path.resolve(env('ACCOUNTS_FILE') ?? 'accounts.txt'),

  /** SQLite file and mirrored images. Mount this as a volume. */
  dataDir: path.resolve(env('DATA_DIR') ?? 'data'),

  /**
   * How many posts to keep per feed. Each refresh prunes the oldest beyond
   * this cap, deleting the item and its mirrored image.
   */
  maxItemsPerFeed: 12,

  /**
   * How many times to try fetching an account before giving up. Instagram
   * returns 401 from a fraction of residential-proxy exit IPs no matter how
   * well-formed the request is, and each retry rotates to a fresh IP — 2-3
   * attempts recovers most transient blocks. Set to 1 to disable retrying.
   */
  maxFetchAttempts: 3,

  /**
   * The hour of the local-time day the feed refresh runs, 0 being midnight —
   * the only schedule there is. Every account is refreshed then, and again on
   * the way up after a deploy; nothing a reader does triggers a fetch. Local
   * time means the container's, so set `TZ` if UTC isn't the midnight you mean
   * (see lib/schedule.ts).
   */
  refreshHour: 0,

  /**
   * The hour of the local-time day the proxy provider (Decodo) is polled for
   * the residential plan's remaining traffic, shown in the status footer. Only
   * runs when DECODO_API_TOKEN is set.
   *
   * The same hour as `refreshHour` on purpose: the refresh is what spends the
   * traffic, so the figure is only stale between a refresh and the poll that
   * follows it. Polling on the same schedule — plus once on the way up after a
   * deploy — means the footer is re-read right after every cycle that could
   * have changed it, and never at some unrelated hour in between.
   */
  proxyTrafficHour: 0,

  /**
   * Download each post image once and serve it from our own /assets, instead
   * of linking Instagram's CDN. Their URLs are signed, expire after a few
   * days, and are origin-restricted, so many readers can't load them at all.
   */
  mirrorImages: true,

  /**
   * How image downloads reach Instagram's CDN. Images are ~95% of the bytes
   * this app pulls (a JSON profile response is ~40 KB; a post image ~250 KB),
   * so on a metered residential proxy they dominate the bill.
   *
   * The CDN serves signed URLs to anonymous clients and doesn't apply the login
   * wall to media, so a datacenter IP usually fetches them fine — hence the
   * default: try direct, fall back to the proxy on any failure. Set to 'proxy'
   * to always tunnel, or 'direct' to never. The profile fetch itself is always
   * proxied regardless; that's where the exit IP actually matters.
   */
  imageFetch: 'direct-then-proxy' as 'direct' | 'proxy' | 'direct-then-proxy',

  /** Refuse an image larger than this, so one bad URL can't fill the volume. */
  maxImageBytes: 8 * 1024 * 1024,

  /**
   * Most images to mirror and render for a single gallery/carousel post. A
   * carousel can hold ~20 images and each is a metered proxy download plus disk,
   * so this caps the worst case; the default covers every real gallery, so in
   * practice all images are shown. The cover always counts as the first.
   */
  maxGalleryImages: 20,

  /** How often the scheduler wakes up to see which jobs are due. */
  tickIntervalMs: 60_000,

  /**
   * Pause the refresh job leaves between successive accounts. The refresh runs
   * one account at a time (see jobs/refreshFeeds.ts); this keeps a 50-account
   * run from hammering the proxy pool back to back. There is a whole day of
   * headroom, so it can afford to be generous.
   */
  refreshStaggerMs: 5_000,

  /**
   * How soon a failed account is retried, doubling per consecutive failure and
   * capped below: 10m, 20m, 40m, 80m, then every 4h until it works.
   *
   * This is the one thing that fetches outside the daily cycle, and it exists
   * because the common failure is a burned proxy exit IP or a rate-limit blip —
   * minutes old, not a day old. Waiting for tomorrow's cycle would leave a feed
   * a full day stale over something that fixes itself. A failed fetch downloads
   * no images, so a retry costs a profile request (~40 KB) and nothing more.
   *
   * Accounts that fail *permanently* (gone, private, renamed) are not retried
   * here at all — no backoff makes a deleted account exist, so they wait for the
   * next daily cycle, which is the same once-a-day retry they had before.
   */
  retryBackoffMs: 10 * 60_000,
  maxRetryBackoffMs: 4 * 60 * 60_000,

  /** How long per-attempt fetch records are kept for diagnosing proxy trouble. */
  fetchLogRetentionDays: 7,

  /**
   * How many days of daily post counts to keep and average over — the window
   * behind the posts-per-day figure on each feed. Thirty rather than a week
   * because an account that posts weekly needs more than one bucket before the
   * average means anything; the rows are sparse, so the cost is nil.
   */
  activityWindowDays: 30,

  /**
   * Grace period before the orphan sweep will unlink an unreferenced file. A
   * refresh writes image files before committing the rows that reference them,
   * so a sweep landing in that window must not delete a file that is about to
   * be referenced. The window is milliseconds; an hour is free insurance.
   */
  assetSweepGraceMs: 60 * 60_000,
} as const

export const dbFile = path.join(config.dataDir, 'rss.db')
export const assetsDir = path.join(config.dataDir, 'assets')
/** Downloads land here first and are renamed into place, so a partial write
 * is never visible under /assets. Same filesystem, so the rename is atomic. */
export const tmpDir = path.join(config.dataDir, 'tmp')

/** The public URL of a mirrored image, as stored in the DB and served in feeds. */
export const assetUrl = (filename: string): string =>
  `${config.publicBaseUrl}/assets/${encodeURIComponent(filename)}`
