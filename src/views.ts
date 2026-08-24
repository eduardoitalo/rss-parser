import { prefixForType } from './adapters/registry.js'
import { config } from './config.js'
import type { SourceRow } from './db.js'
import { type Average, formatPerDay } from './lib/activity.js'
import type { AssetUsage } from './lib/assets.js'
import { escapeHtml } from './lib/html.js'
import type { ProxyTraffic } from './lib/proxyTraffic.js'
import { feedUrlFor, landingUrl, sourceLink } from './lib/rss.js'
import { nextDailyRun } from './lib/schedule.js'

/**
 * The two HTML pages, as template strings. No template engine and no client-side
 * framework: one status page and one tiny landing page don't justify either.
 */

/*
 * Deliberately low-fi, as the pre-rewrite landing page was: one system monospace
 * stack, no webfonts, no external requests. Black on white paper, default browser
 * link blue as the only accent. Rows are separated by whitespace alone — no rules,
 * borders, or boxes.
 */
const STYLES = `
  :root {
    --bg: #ffffff; --fg: #000000; --muted: #8a8a8a; --line: #eeeeee;
    --accent: #0000ee; --visited: #551a8b; --bad: #cc0000;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); -webkit-font-smoothing: antialiased; }
  body {
    margin: 0; padding: 3rem 1.25rem 2rem; background: var(--bg); color: var(--fg);
    font: 1rem/1.7 var(--mono);
  }
  main { max-width: 44rem; margin: 0 auto; }
  /* Two-tier type scale in rem (px at the default 16px root in parens):
     1.25rem/20 heading / 1rem/16 everything else, the base set on <body>.
     16px is the floor for text: secondary matter (meta, chrome, code, feed
     URLs, status values) and the uppercase keys separate themselves by colour,
     case, and letter-spacing instead of by shrinking. Keep new text on one rung. */
  h1 { font-size: 1.25rem; font-weight: 700; margin: 0 0 .3rem; }
  .sub { color: var(--muted); margin: 0 0 2rem; }
  .back { margin: 0 0 1.5rem; }
  code, .mono { font-family: var(--mono); font-size: 1rem; }
  a { color: var(--accent); }
  a:visited { color: var(--visited); }
  a:focus-visible { outline: 0.125rem solid var(--accent); outline-offset: 0.125rem; }
  /* Set off as an inline-block so the link's underline stops at the text and
     never runs under the arrow; no colour of its own, so it still inherits the
     link's colour, including the :visited state. */
  a.ext::after {
    content: "↗"; display: inline-block; flex: none; margin-left: .15em;
  }
  ul { list-style: none; margin: 1.25rem 0; padding: 0; }
  li { padding: .9rem 0; display: grid; gap: .45rem; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: .55rem; }
  .handle { font-weight: 700; }
  .avatar {
    width: 2.125rem; height: 2.125rem; object-fit: cover;
    background: var(--line); flex: none;
  }
  .feed { display: block; overflow-x: auto; white-space: nowrap; }
  .feed-box {
    margin: 1.5rem 0; padding: .7rem .85rem; background: #fafafa;
    border: 0.0625rem solid var(--line);
  }
  .feed-box .label {
    display: block; color: var(--muted); letter-spacing: .08em;
    text-transform: uppercase; margin-bottom: .3rem;
  }
  .status-box {
    display: flex; flex-direction: column;
    margin: 1.5rem 0; padding: .35rem .95rem; background: #fafafa;
    border: 0.0625rem solid var(--line);
  }
  .stat {
    display: flex; align-items: baseline; gap: .6rem;
    padding: .4rem 0; border-top: 0.0625rem solid var(--line);
  }
  .stat:first-child { border-top: 0; }
  .stat-key {
    flex: none; width: 6.5rem; color: var(--muted);
    letter-spacing: .08em; text-transform: uppercase;
  }
  /* Health colours, shared by the status-box cell and the index's per-feed
     indicator so one feed reads the same on both pages. */
  .ok { color: var(--accent); }
  .bad { color: var(--bad); }
  .wait { color: var(--muted); }
  .more { margin-left: auto; white-space: nowrap; }
  .err { color: var(--bad); word-break: break-word; }
  footer { margin-top: 3.5rem; color: var(--muted); }
  .empty { padding: 1.5rem 0; }
`

const layout = (title: string, head: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
${head}</head>
<body>
<main>
${body}
</main>
</body>
</html>
`

/** Coarse relative time, good enough for "how stale is this feed". */
function ago(ms: number | null): string {
  if (!ms) return 'never'
  const seconds = Math.round((Date.now() - ms) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Byte sizes at a glance — powers of 1024, one decimal from MB up. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

function until(ms: number): string {
  const minutes = Math.round((ms - Date.now()) / 60_000)
  if (minutes <= 0) return 'due now'
  if (minutes < 60) return `in ${minutes}m`
  return `in ${Math.round(minutes / 60)}h`
}

/** An hour of the day as a wall clock reads it: 0 → "00:00". */
const clockHour = (hour: number): string => `${String(hour).padStart(2, '0')}:00`

/** One labelled cell in the status box: an uppercase key over its value. */
function stat(key: string, value: string, valueClass = '', title = ''): string {
  const cls = valueClass ? ` ${valueClass}` : ''
  const attr = title ? ` title="${escapeHtml(title)}"` : ''
  return `  <div class="stat"><span class="stat-key">${escapeHtml(key)}</span><span class="stat-val${cls}"${attr}>${value}</span></div>`
}

/**
 * When this feed is next fetched. Normally the daily cycle, but a feed whose
 * last fetch failed has a retry pending sooner than that, and saying "in 9h"
 * while it is about to be retried in ten minutes would just be wrong.
 */
function nextStat(source: SourceRow): string {
  const daily = nextDailyRun(config.refreshHour)
  const retry = source.retry_at
  const soonest = retry !== null && retry < daily ? retry : daily
  const title =
    soonest === daily
      ? `daily refresh at ${clockHour(config.refreshHour)}`
      : 'retrying after a failed fetch'
  return stat('next', escapeHtml(until(soonest)), '', title)
}

/** The health word for a feed, plus the colour class it should carry. */
function statusLabel(source: SourceRow): { text: string; cls: string } {
  if (source.permanent_error) return { text: 'broken', cls: 'bad' }
  if (source.last_fetch_status === 'error') return { text: 'failing', cls: 'bad' }
  if (source.last_fetch_status === 'success') return { text: 'ok', cls: 'ok' }
  return { text: 'pending', cls: 'wait' }
}

/**
 * The per-day rate as a status-box cell. Carries the underlying figures in a
 * tooltip so the number can be sanity-checked without opening the database, and
 * falls back to an em dash for a feed that hasn't been fetched yet — there is no
 * observation period to average over.
 */
function rateStat(average: Average | null | undefined): string {
  if (!average) return stat('rate', '—', 'wait')
  const days = Math.round(average.days)
  const title = `${average.posts} new post${average.posts === 1 ? '' : 's'} over ${days} day${days === 1 ? '' : 's'}`
  return stat('rate', `${formatPerDay(average.perDay)}/day`, '', title)
}

/** The single page listing every published feed. */
export function renderIndex(
  sources: SourceRow[],
  usage: AssetUsage,
  traffic: ProxyTraffic | null,
): string {
  const items = sources
    .map((source) => {
      const avatar = source.profile_image_url
        ? `<img class="avatar" src="${escapeHtml(source.profile_image_url)}" alt="" />`
        : '<span class="avatar"></span>'

      // The health word rather than the last-fetch time: whether a feed is
      // working is what this list is for, and "updated 3h ago" says nothing
      // about that. The exact timestamp is a click away on the landing page.
      const status = statusLabel(source)

      return `  <li>
    <div class="row">
      ${avatar}
      <span class="handle">@${escapeHtml(source.handle)}</span>
      <span class="status ${status.cls}">${status.text}</span>
      <a class="more" href="${escapeHtml(landingUrl(source))}">more</a>
    </div>
  </li>`
    })
    .join('\n')

  const body = sources.length
    ? `<ul>\n${items}\n</ul>`
    : `<div class="empty">No feeds yet. Add an Instagram username to <code>accounts.txt</code>, one per line — it is published on the next deploy.</div>`

  // The same PNG the landing pages fall back to, reused as the site favicon.
  // Browsers accept a PNG icon directly, so no .ico conversion is needed. Left
  // off the landing pages on purpose: those declare a per-feed icon (see
  // renderLanding) that a competing site-wide default would only muddy.
  const head =
    `<link rel="icon" type="image/png" href="/feed-icon-fallback.png" />\n` +
    `<link rel="apple-touch-icon" href="/feed-icon-fallback.png" />\n`

  return layout(
    'Feeds — rss-parser',
    head,
    `<h1>Feeds</h1>
<p class="sub">Public Instagram accounts published as RSS feeds. New accounts can be submitted via PR to <a class="ext" href="https://github.com/numbersoffice/rss-parser/blob/main/accounts.txt"><code>accounts.txt</code></a>.</p>
${body}
<footer>Refreshed once a day at ${clockHour(config.refreshHour)} and on every deploy, keeping the newest ${config.maxItemsPerFeed} posts per feed.<br />
Mirrored images: <strong>${formatBytes(usage.bytes)}</strong> across ${usage.files} file${usage.files === 1 ? '' : 's'}.${
      traffic
        ? `<br />\nProxy traffic remaining: <strong>${formatBytes(traffic.remainingBytes)}</strong> of ${formatBytes(traffic.limitBytes)}.`
        : ''
    }</footer>`,
  )
}

/**
 * The per-feed landing page. It exists for one reason: RSS readers that derive a
 * feed's sidebar icon by scraping its home page (NetNewsWire among them) prefer
 * that page's favicon over the feed's declared image. Pointing the channel
 * <link> here instead of at instagram.com is what stops them showing Instagram's
 * glyph for every feed.
 *
 * Unlike the Next.js version, the icon <link> tags have to be written out
 * explicitly — there is no file-convention magic injecting them.
 */
export function renderLanding(source: SourceRow, average: Average | null, count: number): string {
  const icon = `${config.publicBaseUrl}/f/${prefixForType(source.type)}/${encodeURIComponent(source.handle)}/icon`
  const head =
    `<link rel="icon" href="${escapeHtml(icon)}" sizes="any" />\n` +
    `<link rel="apple-touch-icon" sizes="180x180" href="${escapeHtml(icon)}" />\n` +
    `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(source.name)}" href="${escapeHtml(feedUrlFor(source))}" />\n`

  // source.name is "Full Name (@handle)"; the sub line below already shows the
  // handle, so drop that suffix from the heading to avoid repeating it.
  const title = source.name.replace(/\s*\(@[^)]+\)\s*$/, '')
  const status = statusLabel(source)
  const error =
    source.permanent_error ??
    (source.last_fetch_status === 'error' ? source.last_fetch_error : null)

  return layout(
    source.name,
    head,
    `<p class="back"><a href="${escapeHtml(config.publicBaseUrl)}/">all feeds</a></p>
<h1>${escapeHtml(title)}</h1>
<p class="sub">Instagram posts by <a class="ext" href="${escapeHtml(sourceLink(source))}">@${escapeHtml(source.handle)}</a>, as RSS.</p>
<div class="feed-box">
  <span class="label">RSS feed</span>
  <a class="feed mono" href="${escapeHtml(feedUrlFor(source))}">${escapeHtml(feedUrlFor(source))}</a>
</div>
<div class="status-box">
${stat('status', status.text, status.cls)}
${rateStat(average)}
${stat('posts', String(count))}
${stat('updated', escapeHtml(ago(source.last_fetched_at)))}
${nextStat(source)}
</div>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}`,
  )
}
