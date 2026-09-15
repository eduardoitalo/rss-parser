import type {
  AdapterSource,
  AttemptRecord,
  NormalizedFeed,
  NormalizedItem,
  SourceAdapter,
} from './types.js'
import { PermanentFetchError, RetryableFetchError } from './types.js'
import { config } from '../config.js'
import { escapeHtml } from '../lib/html.js'
import { log } from '../log.js'
import { outboundFetch, proxyEndpoint, randomSessionId, sessionForSource } from '../lib/proxy.js'

/**
 * Fetches public Instagram profiles by reading the logged-out profile *page*
 * and pulling the data out of the Relay payload it ships with.
 *
 * This used to call Instagram's own `api/v1/users/web_profile_info` endpoint.
 * That endpoint now refuses every logged-out client — it answers 401 with
 * `{"require_login":true,"igweb_rollout":true}` no matter how complete the
 * cookie/CSRF/fingerprint handshake is, and from any IP. It is gone for our
 * purposes, and no amount of retrying or rotating exit IPs brings it back.
 *
 * What still works is the ordinary page a logged-out visitor gets. Instagram
 * server-renders it and embeds the query results in `<script
 * type="application/json">` blocks, which carry both the account metadata and
 * the first page of the timeline — the same two things the old endpoint
 * returned, in the newer "XIGPolaris" shape.
 *
 * The one thing the timeline payload omits is a carousel's individual frames:
 * a gallery arrives as its cover plus a count. Those come from the post's own
 * page, which embeds the full `carousel_media` array, so carousels cost one
 * extra request each (bounded by `maxItemsPerFeed`).
 *
 * Still unofficial: Instagram may rate-limit or block. Errors are logged and
 * recorded on the source, and previously cached items keep serving.
 */

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// Client-hint headers must agree with USER_AGENT (Chrome 126 on macOS) — a UA
// with no/mismatched hints is itself a bot tell.
const SEC_CH_UA = '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"'

/** The headers a logged-out Chrome sends for a top-level page navigation. */
const PAGE_HEADERS: Record<string, string> = {
  'user-agent': USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': SEC_CH_UA,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
}

/** Pause between retry attempts, each of which rotates the proxy exit IP. */
const RETRY_DELAY_MS = 2_000

/** Pause between a profile page and the post pages its carousels need, so one
 * account's refresh doesn't arrive as a dozen requests inside a second. */
const POST_DELAY_MS = 750

/**
 * Instagram media ids encode their creation time: the id's top bits are
 * milliseconds since this epoch, the low 23 bits a shard/sequence counter.
 * The page payload carries no `taken_at` on timeline entries, so this is how a
 * post's date is recovered — checked against the dates Instagram itself renders
 * into `accessibility_caption`, and against the `taken_at` on post pages, where
 * the two agree to within a second.
 */
const IG_EPOCH_MS = 1314220021721n

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Strip a leading "@" and surrounding whitespace from a handle. */
export const normalizeHandle = (handle: string): string =>
  handle.trim().replace(/^@/, '').toLowerCase()

/** Snapshot a subset of response headers (those present) for the debug record. */
function pickHeaders(headers: Headers, names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = headers.get(name)
    if (value !== null) out[name] = value
  }
  return out
}

/** The per-attempt HTTP metadata fetchProfile leaves on `debug`. */
function attemptMeta(
  debug: Record<string, unknown>,
): Pick<AttemptRecord, 'httpStatus' | 'durationMs'> {
  return {
    httpStatus: typeof debug.httpStatus === 'number' ? debug.httpStatus : null,
    durationMs: typeof debug.durationMs === 'number' ? debug.durationMs : null,
  }
}

// ---------------------------------------------------------------------------
// The embedded payload
// ---------------------------------------------------------------------------

/**
 * Every `<script type="application/json">` body on the page. Instagram escapes
 * the `/` of any `</script>` appearing inside one, so a non-greedy match to the
 * first real closing tag can't cut a payload short.
 */
function jsonBlocks(html: string): string[] {
  return [...html.matchAll(/<script type="application\/json"[^>]*>(.*?)<\/script>/gs)].map(
    (match) => match[1] ?? '',
  )
}

/**
 * Visit every object in a parsed JSON tree. The query results sit at the bottom
 * of a deep, version-specific wrapper of Relay/bootloader plumbing
 * (`require[...][...].__bbox.result.data`), so we search for the payloads by
 * name instead of hard-coding a path that Instagram reshuffles at will.
 */
function walkObjects(node: unknown, visit: (object: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walkObjects(child, visit)
    return
  }
  visit(node as Record<string, unknown>)
  for (const child of Object.values(node as Record<string, unknown>)) walkObjects(child, visit)
}

/** Parse the page's JSON blocks and hand every object in them to `visit`. */
function walkPayloads(html: string, visit: (object: Record<string, unknown>) => void): void {
  for (const block of jsonBlocks(html)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      continue // a block that isn't a query payload; nothing to mine
    }
    walkObjects(parsed, visit)
  }
}

interface XigMedia {
  pk?: string
  code?: string
  __typename?: string
  media_type?: number
  taken_at?: number
  display_uri?: string
  caption?: { text?: string } | null
  carousel_media?: XigMedia[]
}

interface XigUser {
  username?: string
  full_name?: string
  biography?: string
  is_private?: boolean
  profile_pic_url?: string
  polaris_ordered_timeline_connection?: { edges?: Array<{ node?: XigMedia }> }
}

/**
 * The account payload, assembled from the page's query results. Instagram
 * answers the profile header and the post grid as two separate queries, so
 * `xig_user_by_username` appears more than once — one copy carries the bio and
 * avatar, another the timeline. Merge them rather than betting on which is
 * which.
 */
function readUser(html: string): { profile: XigUser | null; media: XigMedia[] } {
  let profile: XigUser | null = null
  let media: XigMedia[] = []

  walkPayloads(html, (object) => {
    const user = object.xig_user_by_username
    if (user === null || typeof user !== 'object') return
    const candidate = user as XigUser
    // The header query is the one that carries the bio fields.
    if (typeof candidate.biography === 'string' || typeof candidate.full_name === 'string') {
      profile = candidate
    }
    const edges = candidate.polaris_ordered_timeline_connection?.edges
    if (Array.isArray(edges) && edges.length > media.length) {
      media = edges.map((edge) => edge?.node).filter((node): node is XigMedia => Boolean(node))
    }
  })

  return { profile, media }
}

/** A post page's media object, which — unlike the timeline — carries the full
 * `carousel_media` array. `if_not_gated_logged_out` is the copy served to a
 * logged-out viewer; it is absent when Instagram gates the post. */
function readMedia(html: string): XigMedia | null {
  let found: XigMedia | null = null
  walkPayloads(html, (object) => {
    const media = object.xig_polaris_media
    if (media === null || typeof media !== 'object') return
    const gated = media as { if_not_gated_logged_out?: XigMedia }
    const node = gated.if_not_gated_logged_out ?? (media as XigMedia)
    if (Array.isArray(node.carousel_media) || typeof node.display_uri === 'string') found = node
  })
  return found
}

// ---------------------------------------------------------------------------
// Normalizing
// ---------------------------------------------------------------------------

/** When a post was published. Prefers Instagram's own `taken_at` (post pages
 * carry it), falling back to the timestamp encoded in the media id (timeline
 * entries don't). A given post always resolves the same way, so `published_at`
 * doesn't drift between refreshes. */
function publishedAt(media: XigMedia): Date {
  if (typeof media.taken_at === 'number' && media.taken_at > 0) {
    return new Date(media.taken_at * 1000)
  }
  return new Date(Number((BigInt(media.pk ?? '0') >> 23n) + IG_EPOCH_MS))
}

/** Instagram's media_type for a carousel; its children are the real frames. */
const CAROUSEL = 8

const isCarousel = (media: XigMedia): boolean =>
  media.media_type === CAROUSEL || media.__typename === 'XIGPolarisCarouselMedia'

function firstLine(text: string, maxLength = 120): string {
  const line = (text.split('\n')[0] ?? '').trim()
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line
}

/**
 * Every image URL in a post, in order. A carousel contributes one per child
 * (video children contribute their poster frame, as top-level videos do);
 * anything else is its single `display_uri`.
 */
function imageUrls(media: XigMedia): string[] {
  const children = media.carousel_media
  if (Array.isArray(children) && children.length > 0) {
    const urls = children
      .map((child) => child.display_uri)
      .filter((url): url is string => Boolean(url))
    // Bound the gallery so one pathological carousel can't multiply the metered
    // proxy bytes and disk; the default cap covers every real gallery. Always
    // keep at least the cover.
    if (urls.length > 0) return urls.slice(0, Math.max(1, config.maxGalleryImages))
  }
  return media.display_uri ? [media.display_uri] : []
}

function toItem(media: XigMedia, username: string): NormalizedItem {
  const caption = media.caption?.text ?? ''
  const url = `https://www.instagram.com/p/${media.code}/`
  const images = imageUrls(media)
  const isGallery = images.length > 1

  const parts: string[] = []
  // One <img> per image, in order, so a gallery renders each frame one after
  // another inside the single entry body.
  for (const image of images) {
    parts.push(`<p><a href="${escapeHtml(url)}"><img src="${escapeHtml(image)}" alt="" /></a></p>`)
  }
  if (caption) {
    parts.push(`<p>${escapeHtml(caption).replaceAll('\n', '<br />')}</p>`)
  }

  const kind = isGallery ? 'Gallery' : media.media_type === 2 ? 'Video' : 'Post'
  return {
    // The media id, matching what the old web_profile_info adapter stored, so
    // items already in the database are recognized rather than re-created.
    externalId: media.pk!,
    title: caption ? firstLine(caption) : `${kind} by @${username}`,
    content: parts.join('\n') || `<p>Post by @${username}</p>`,
    url,
    // Cover keeps the single enclosure resolving; `images` carries the whole set.
    imageUrl: images[0],
    images,
    publishedAt: publishedAt(media),
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** GET a page as a logged-out browser would. `debug` keys are recorded only for
 * the profile request, which is the one the fetch log reports on. */
async function fetchPage(
  url: string,
  session: string,
  debug?: Record<string, unknown>,
): Promise<string> {
  const startedAt = Date.now()
  const res = await outboundFetch(
    url,
    {
      headers: PAGE_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    },
    { session },
  )
  if (debug) {
    debug.durationMs = Date.now() - startedAt
    debug.httpStatus = res.status
    debug.contentType = res.headers.get('content-type') ?? ''
    // Headers Instagram sets when throttling or challenging a client — the
    // clearest signal of whether a failure is IP-level blocking vs. a bad handle.
    debug.responseHeaders = pickHeaders(res.headers, [
      'retry-after',
      'x-ratelimit-remaining',
      'www-authenticate',
      'x-fb-rlafr',
      'location',
    ])
  }

  if (!res.ok) {
    // 401/403/429/5xx — usually a burned exit IP; a retry on a new IP recovers.
    throw new RetryableFetchError(
      `Instagram responded with ${res.status} — likely rate-limited or blocked, try again later`,
    )
  }
  return res.text()
}

/**
 * A carousel's frames, from the post's own page. Returns null when the frames
 * can't be read — a blocked request, a gated post, an unexpected shape. The
 * caller then drops the post from this refresh rather than reporting it with
 * only its cover: a gallery that came back one image wide would look like a
 * genuine edit and overwrite the stored post, discarding the frames already
 * mirrored for it.
 */
async function carouselFrames(
  code: string,
  session: string,
  username: string,
): Promise<XigMedia | null> {
  try {
    const html = await fetchPage(`https://www.instagram.com/p/${code}/`, session)
    const media = readMedia(html)
    if (!media || !Array.isArray(media.carousel_media) || media.carousel_media.length === 0) {
      return null
    }
    return media
  } catch (err) {
    log.debug('could not read carousel frames', {
      handle: `@${username}`,
      post: code,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * One attempt at reading a profile on a given sticky proxy session: fetch the
 * profile page, mine its embedded payload, then fill in each carousel from its
 * own page. Throws `RetryableFetchError` for blocks and login walls so the
 * caller can retry on a new IP; throws `PermanentFetchError` for a missing or
 * private profile.
 */
async function fetchProfile(
  username: string,
  session: string,
  debug: Record<string, unknown>,
): Promise<NormalizedFeed> {
  const html = await fetchPage(`https://www.instagram.com/${username}/`, session, debug)

  const { profile, media } = readUser(html)
  debug.hasPayload = profile !== null

  if (!profile) {
    // Instagram serves 200 for a handle that doesn't exist, so absence of the
    // payload is the only signal. It is also what a login wall looks like, so
    // separate the two: a real "no such account" page still renders the site
    // shell, whereas a wall redirects us to the login route.
    if (/\/accounts\/login/.test(html) && !/xig_user_by_username/.test(html)) {
      throw new RetryableFetchError(
        'Instagram served a login wall instead of the profile — try again later',
      )
    }
    throw new PermanentFetchError(`Instagram profile @${username} not found`, 'notfound')
  }
  if (profile.is_private) {
    throw new PermanentFetchError(
      `Instagram profile @${username} is private — only public profiles can be converted`,
      'private',
    )
  }

  const profileImageUrl = profile.profile_pic_url
  debug.hasProfileImage = Boolean(profileImageUrl)

  const fullName = profile.full_name?.trim()
  const biography = profile.biography?.trim()

  const items: NormalizedItem[] = []
  let galleries = 0
  let incomplete = 0
  for (const node of media) {
    if (!node.pk || !node.code) continue
    if (isCarousel(node)) {
      // One request per gallery. Bounded by the timeline page (12 posts), and
      // the images themselves are mirrored once, so this is the only repeat cost.
      await sleep(POST_DELAY_MS)
      const expanded = await carouselFrames(node.code, session, username)
      if (!expanded) {
        incomplete++
        continue
      }
      galleries++
      items.push(toItem({ ...node, ...expanded }, username))
      continue
    }
    items.push(toItem(node, username))
  }

  debug.itemCount = items.length
  debug.galleries = galleries
  debug.incompleteGalleries = incomplete

  return {
    items,
    profile: {
      imageUrl: profileImageUrl,
      title: fullName ? `${fullName} (@${username})` : `@${username}`,
      description: biography || `Instagram posts by @${username}`,
    },
  }
}

export const instagramAdapter: SourceAdapter = {
  type: 'instagram',

  sourceUrl(source: AdapterSource): string {
    return `https://www.instagram.com/${normalizeHandle(source.handle ?? '')}/`
  },

  async fetchItems(
    source: AdapterSource,
    debug: Record<string, unknown> = {},
    maxAttempts = 1,
  ): Promise<NormalizedFeed> {
    const proxy = proxyEndpoint()
    debug.proxied = proxy !== null
    debug.proxy = proxy ?? 'direct'

    const username = normalizeHandle(source.handle ?? '')
    if (!username) {
      throw new PermanentFetchError('Source has no Instagram handle configured', 'handle')
    }

    debug.endpoint = `https://www.instagram.com/${username}/`

    // Instagram blocks a fraction of exit IPs no matter how well-formed the
    // request is, so a failed fetch is usually just a bad IP. Retry up to
    // maxAttempts, rotating the proxy session — and thus the exit IP — each
    // time. Attempt 1 keeps the source's own sticky session so the profile page
    // and the post pages behind it leave from one IP; retries take a fresh
    // random session (a no-op when the proxy isn't session-aware).
    const attempts = Math.max(1, maxAttempts)
    // One record per attempt, surfaced so the refresh layer can log each try as
    // its own request (retries count as regular requests in the fetch log).
    const attemptLog: AttemptRecord[] = []
    debug.attempts = attemptLog
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Clear so a stale value from a prior attempt can't leak into this one's
      // record if this attempt fails before the profile request runs.
      debug.httpStatus = null
      debug.durationMs = null
      const session = attempt === 1 ? sessionForSource(source) : randomSessionId()
      try {
        const feed = await fetchProfile(username, session, debug)
        attemptLog.push({ status: 'success', ...attemptMeta(debug), error: null })
        return feed
      } catch (err) {
        attemptLog.push({
          status: 'error',
          ...attemptMeta(debug),
          error: err instanceof Error ? err.message : String(err),
        })
        lastError = err
        if (err instanceof RetryableFetchError && attempt < attempts) {
          // Brief pause before rotating to a new exit IP. Hammering the proxy
          // pool three times inside a second is the least useful form of retry.
          await sleep(RETRY_DELAY_MS)
          continue
        }
        throw err
      }
    }
    throw lastError
  },
}
