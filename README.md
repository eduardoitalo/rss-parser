# rss-parser

Publishes public Instagram accounts as RSS feeds. The list of accounts is a text
file in this repo, so adding or removing a feed is a commit.

An Express app with three runtime dependencies, a SQLite file and a directory of
images. It idles at well under 100 MB and does no work on the request path.

```
accounts.txt ──▶ sync-accounts ──▶ sources ──▶ refresh-feeds ──▶ items + assets
                                                                      │
                                          GET /feeds/ig/{handle}.xml ◀─┘
```

## Quick start

```sh
pnpm install
pnpm build
pnpm start                  # http://localhost:3000
```

Open `http://localhost:3000` for the list of published feeds. Startup kicks off a
refresh of every account, one at a time with a gap between them, so a longer list
takes a few minutes to fill in (see [Refreshing](#refreshing)).

With Docker:

```sh
cp .env.example .env        # set PUBLIC_BASE_URL, optionally OUTBOUND_PROXY_URL
docker compose up -d
docker compose logs -f      # job and per-account status lines
```

## Adding and removing feeds

`accounts.txt` is the interface. One Instagram username per line; `#` comments
and blank lines are ignored, a leading `@` is optional, and case doesn't matter.

```
nasa
natgeo
@euronews          # the @ is optional
```

- **Add a line** → the feed appears, and the startup refresh fills it in.
- **Remove a line** → the feed, its cached posts and every image it mirrored are
  deleted.

The file is read once at startup, so an edit applies on the next deploy or
`docker compose restart`.

If the file is missing, unreadable, or contains no usable usernames, **nothing is
deleted** — the app logs an error and leaves every feed alone. A failed bind
mount or a bad edit should not be able to wipe your feeds, since that's the one
thing here that a re-fetch can't rebuild.

## Feed URLs

```
https://your-host/feeds/ig/nasa.xml
```

Predictable and public: there are no per-subscriber tokens, and every feed is
listed on the index page. Serving them costs nothing but local bandwidth, since
nothing on the request path talks to Instagram.

Each feed also has a small landing page at `/f/ig/{handle}`, which the RSS channel
`<link>` points at. That's deliberate rather than linking to instagram.com: some
readers (NetNewsWire among them) derive a feed's sidebar icon by scraping its home
page, and would otherwise show Instagram's glyph on every feed. The landing page
serves the account's own avatar as its icon.

## How it works

### Refreshing

Feeds are refreshed **once a day at midnight, and on every deploy** — plus a
retry for anything that failed, described below. Nothing a reader does fetches
anything: polling a feed serves what is already stored, so outbound traffic
depends on how many accounts are published, not on how many readers are
subscribed or how often they poll.

A single 60-second tick decides which jobs are due. Each logs one line per run,
and a job still running from a previous tick is skipped rather than overlapped.

| Job                   | When               | What it does                                          |
| --------------------- | ------------------ | ----------------------------------------------------- |
| `refresh-feeds`       | 00:00, and at boot | Refreshes every account, one at a time                |
| `retry-feeds`         | 1 min              | Re-fetches accounts whose last attempt failed         |
| `check-proxy-traffic` | 00:00, and at boot | Reads the proxy plan's remaining traffic (if enabled) |
| `prune-history`       | 24 h               | Drops fetch records and day counts past their window  |
| `sweep-assets`        | 24 h               | Deletes image files no post references                |

`accounts.txt` is reconciled once at startup rather than by a job — the file is
committed, so editing it means a redeploy anyway, and the refresh that follows
boot fills in whatever was added.

Refreshes are **sequential with a 5-second gap**, never parallel. That's the
whole throttling strategy: it keeps at most one Instagram request in flight,
which is what a metered residential proxy wants and what Instagram's per-IP rate
limiting punishes you for ignoring. A 50-account list takes a few minutes of
wall clock against a whole day of headroom. The retry pass shares that same
one-at-a-time guarantee — a retry that comes due mid-cycle is dropped, since the
cycle is about to refresh that account anyway.

Midnight is the container's local time, so set `TZ` if UTC isn't the midnight
you mean. The hour itself is `refreshHour` in `src/config.ts`.

**A failed fetch is retried on a doubling backoff** — 10 → 20 → 40 → 80 minutes,
then every 4 hours until it works. The usual failure is a burned proxy exit IP or
a rate-limit blip, over in minutes, and a feed shouldn't sit a day stale waiting
for the next cycle. A failed fetch downloads no images, so a retry costs one
profile request and nothing else. An account that is _permanently_ broken
(deleted, renamed, gone private) gets no retry of its own — no backoff makes a
deleted account exist — and simply comes round again on the next daily cycle.

Nothing is ever given up on either way, because private accounts come back and
Instagram occasionally 404s a live profile. A feed that has been broken for over
a day gets a `[SYSTEM]` entry explaining why it stopped, so you find out in your
reader rather than by checking the status page.

Cached posts are never dropped because a fetch failed — the previous items keep
serving.

### Posts and images

Each refresh keeps the newest 12 posts per feed and prunes the rest, deleting
both the post and its mirrored image.

Instagram's image URLs are signed, expire after a few days, and are
origin-restricted, so many readers can't load them at all. So each post's image is
downloaded once into `data/assets/` and the feed serves that stable URL instead.
If a download fails the post still appears, pointing at Instagram's URL, and the
next refresh retries the mirror.

**Once is once.** A stored post is never re-downloaded — its `asset` column says
the image is already mirrored — and even when the rows and the directory disagree
(a refresh that stored images and then failed before committing, a database
restored without its assets volume, a post pruned and re-fetched), the file
already sitting under the post's name is adopted instead of fetched again. Asset
names are content-stable, `{source}-{post}[-{index}]`, which is the same property
that lets `/assets` be served immutable. The `images=` count in a refresh's log
line therefore counts real downloads: a daily cycle over feeds that haven't posted
shows no image traffic at all.

Images are ~95% of the bytes this app pulls, so by default they're fetched
**directly** and only retried through the proxy if that fails — the CDN serves
signed URLs to any IP, while the profile API is the part that actually needs a
residential exit. Set `imageFetch` in `src/config.ts` to `'proxy'` or `'direct'`
to override.

The index page footer shows what `data/assets/` currently occupies. It's a
running total, adjusted at the only two moments the directory changes — an image
being stored and an image being deleted — so reading it never touches the
filesystem and the page's cost doesn't grow with the number of images. It's
established against the directory once at startup, and the daily sweep re-walks
it as a backstop against drift.

It counts what is really on disk rather than adding up the byte counts stored
against posts, so profile pictures and any orphans awaiting the next sweep are
included. Note that it sums apparent file sizes, so `du -sh data/assets` will
report slightly more (each file rounds up to a filesystem block), and it covers
only the images — not the SQLite database alongside them.

### Posts per day

Each feed on the index page carries a small `3.4/day` figure — how many new posts
that account has been producing. It's the number that predicts which feeds are
expensive, since new posts are the only thing that costs outbound bandwidth
(each one is a fetch plus an image download). Hover it for the underlying
figures; the per-feed landing page shows the same number in prose.

New posts are counted into a sparse per-day bucket as they're stored, inside the
same transaction that stores them, so the count can't drift from the posts it
counts. The average divides by **elapsed days observed**, not by the days that
happened to have posts — otherwise a feed that posted 20 times one day and then
went quiet would outrank one posting 15 every day.

Two deliberate exclusions keep it honest:

- A feed's **first fetch doesn't count.** It seeds up to a full feed at once,
  which is a backfill, not a day's posting.
- The denominator is **floored at one day**, so a feed added an hour ago that
  picked up one post reads `1/day` rather than `24/day`.

A feed that has never been fetched shows no figure at all rather than a made-up
zero. The window is `activityWindowDays` in `src/config.ts` (30 days).

### Conditional requests

Feeds carry an `ETag` and `Last-Modified` derived from when the feed's contents
last actually changed — not when it was last fetched. A refresh that finds nothing
new writes nothing and invalidates nothing, so a reader polling every 15 minutes
gets a `304` with no body and no XML rendered. This is the main reason the app
stays cheap under a lot of subscribers.

### Routing fetches through a proxy

Instagram rate-limits and blocks datacenter IPs, which is where most deployments
run. Set `OUTBOUND_PROXY_URL` to route the profile fetches through a residential
proxy:

```sh
OUTBOUND_PROXY_URL=http://user-<USER>-country-us-session-{session}:<PASS>@gate.decodo.com:7000
```

**Sticky sessions.** The adapter primes a logged-out guest session (cookies + CSRF
token) and then makes the profile request, and the two must leave from the same
exit IP. Include the literal token `{session}` anywhere in the URL and it is
substituted per request, so the pair shares one IP; a retry after a block rotates
to a fresh session, and therefore a fresh IP. Each account keeps a stable session
derived from its handle, so two accounts refreshed in sequence never share an exit
IP. With no `{session}` token the proxy just rotates per request — the placeholder
works with any session-capable HTTP proxy.

Credentials are never logged or stored; only the proxy host appears in the boot
line. When unset, fetches go out directly.

## Configuration

Tunable knobs live in [`src/config.ts`](src/config.ts) and are committed, so
changing one is a commit like any other: the refresh hour, posts kept per feed,
fetch attempts, the gap between accounts, retry backoff, image mirroring,
retention.

Only deployment values and secrets come from the environment:

| Variable             | Default                 | Purpose                                                                                                                                                                               |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`    | `http://localhost:3000` | The public origin. Feed URLs and the image URLs inside feed items are built from it, so behind a reverse proxy it must be set. Changing it rewrites the stored URLs on the next boot. |
| `PORT`               | `3000`                  | Listen port                                                                                                                                                                           |
| `OUTBOUND_PROXY_URL` | —                       | Residential proxy for Instagram traffic (see above)                                                                                                                                   |
| `ACCOUNTS_FILE`      | `./accounts.txt`        | Path to the feed list                                                                                                                                                                 |
| `DATA_DIR`           | `./data`                | SQLite file and mirrored images                                                                                                                                                       |
| `LOG_LEVEL`          | `info`                  | `debug` \| `info` \| `warn` \| `error`                                                                                                                                                |
| `TZ`                 | `UTC`                   | Which midnight the daily jobs run at                                                                                                                                                  |

## Operations

Everything worth watching goes to stdout as one line per event:

```
INFO  rss-parser listening port=3000 url=https://rss.example.com feeds=12 proxy=gate.decodo.com:7000 …
INFO  job job=sync-accounts added=1 handles=+@newaccount feeds=13 took=3ms
INFO  refreshed handle=@nasa http=200 ms=812 items=12 new=2 pruned=2 images=2
WARN  refresh failed handle=@gone http=404 error="Instagram profile @gone not found"
INFO  job job=refresh-feeds ok=2 failed=1 new=2 pruned=2 images=2 took=16.0s
```

- `GET /healthz` returns 200 with feed count and last tick, or 503 if the
  scheduler has been stalled for over 5 minutes. Used by the container healthcheck.
- `data/` holds everything stateful (`rss.db` plus `assets/`) — that's the only
  thing to back up. Keep it on a normal filesystem; SQLite's WAL locking is
  unreliable on NFS/SMB.
- Deleting `data/` is recoverable: the feeds rebuild themselves from
  `accounts.txt` on the next start.

## Architecture

```
accounts.txt          the feed list — the only thing you normally edit
src/
  server.ts           express app, routes, boot and shutdown
  config.ts           every tunable knob
  db.ts               schema, queries, and the refresh write transaction
  log.ts              one-line stdout logger
  views.ts            the index page and the per-feed landing page
  adapters/
    types.ts          SourceAdapter + NormalizedItem — the extension point
    instagram.ts      Instagram's web API, incl. the guest-session handshake
    registry.ts       type → adapter, and the /feeds/{prefix} mapping
  lib/
    plan.ts           the reconciliation planner (pure, unit-tested)
    activity.ts       posts-per-day arithmetic (pure, unit-tested)
    refresh.ts        fetch → plan → mirror → commit
    assets.ts         local image store
    rss.ts            RSS 2.0 rendering
    accounts.ts       accounts.txt parsing
    schedule.ts       when the daily refresh is due (pure, unit-tested)
    proxy.ts          optional HTTP proxy with sticky sessions
    errors.ts         flattens error causes into one readable message
  jobs/
    scheduler.ts      the tick loop
    syncAccounts.ts refreshFeeds.ts pruneHistory.ts sweepAssets.ts
```

The reconciliation planner is the one piece with real invariants — the stored
posts must end up as exactly the newest N of what was fetched plus what was
already there, so that a post the platform keeps re-serving isn't inserted and
deleted on every cycle, and a short response never empties a feed. It's pure and
covered by tests:

```sh
pnpm test
```

## Adding another source type

Everything platform-specific is in one adapter file.

1. Create `src/adapters/<type>.ts` implementing `SourceAdapter` from
   `src/adapters/types.ts`: fetch the latest posts and map them to
   `NormalizedItem`s (`externalId`, `title`, `content` HTML, `url`, `imageUrl`,
   `publishedAt`). Throw `PermanentFetchError` for failures no retry can fix and
   `RetryableFetchError` for IP-level blocks.
2. Register it in `src/adapters/registry.ts` and give it a URL prefix in
   `FEED_PREFIXES`.

Refreshing, caching, image mirroring, pruning, error reporting and RSS rendering
all pick it up. The account list would need a way to say which platform a handle
belongs to — today every line in `accounts.txt` is an Instagram username.

## Caveats

- **The Instagram adapter uses Instagram's unofficial web API** — the same
  endpoint instagram.com itself uses. It needs no credentials and works for public
  profiles, but Instagram may rate-limit or block it, especially from datacenter
  IPs. Errors appear on the index page and in the logs; cached posts keep serving.
- Only public profiles work. A private account is reported as such and retried
  daily in case it opens up.
- Feed URLs are unauthenticated and enumerable by design. If that matters, put
  the whole app behind basic auth at the reverse proxy.
