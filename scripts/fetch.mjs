/**
 * fetch.mjs — pulls Taskmarket's public market data and writes public/data.json.
 *
 * Run on a server or in a scheduled build. The API sends no CORS headers, so a
 * browser on another origin cannot call it; every number on the dashboard comes
 * from this snapshot, not from a live browser request.
 *
 * No dependencies. Node 20+ (global fetch).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'public/data.json')

const API = 'https://api.taskmarket.dev'
const UA = 'taskmarket-visualizer/1.0 (read-only dashboard; +https://github.com/)'

const CHAINS = [
  { id: 4217, name: 'Tempo', token: 'OUSD' },
  { id: 8453, name: 'Base', token: 'USDC' },
]

/** Statuses that mean the escrow is still held, not settled. */
const HELD = new Set(['open', 'claimed', 'pending_approval', 'worker_selected'])
/** Statuses that mean the money went back to the poster. */
const RETURNED = new Set(['expired', 'cancelled'])
/** Status that means the money went to a worker. */
const PAID = new Set(['completed'])

/** Every endpoint this snapshot used, so the methods note can name them. */
const methods = []

async function get(path, { tries = 3 } = {}) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + path, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        signal: AbortSignal.timeout(30000),
      })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const text = await r.text()
      return JSON.parse(text)
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw new Error('GET ' + path + ' failed: ' + (lastErr && lastErr.message))
}

function note(path, what) {
  if (!methods.some((m) => m.path === path)) methods.push({ path, what })
}

/** Paginate /api/tasks until the cursor runs out. This is the only per-chain source. */
async function allTasks(chainId) {
  const tasks = []
  let cursor = null
  for (let page = 0; page < 60; page++) {
    const j = await get(
      '/api/tasks?chainId=' + chainId + '&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
    )
    for (const t of j.tasks || []) tasks.push(t)
    cursor = j.nextCursor
    if (!j.hasMore || !cursor) break
  }
  // De-duplicate by id; the cursor can repeat an edge item.
  const seen = new Set()
  return tasks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
}

const wei = (v) => (v == null ? 0 : Number(v) / 1e6)
const day = (iso) => String(iso).slice(0, 10)
const round = (n, p = 6) => Number(Number(n).toFixed(p))

function weekStart(iso) {
  const d = new Date(iso)
  const dow = (d.getUTCDay() + 6) % 7 // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow)
  return d.toISOString().slice(0, 10)
}

function median(xs) {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function percentile(xs, p) {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))
  return a[i]
}

/** Bucket counts for a small integer distribution, so the page can draw a histogram. */
function histogram(values, edges) {
  const out = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0 }))
  for (const v of values) {
    for (let i = 0; i < out.length; i++) {
      if (v >= out[i].lo && (v < out[i].hi || i === out.length - 1)) {
        out[i].n++
        break
      }
    }
  }
  return out
}

/**
 * The parts of this site that are computed rather than read straight off an
 * endpoint. Each one is a plain fold over /api/tasks, so a reader can re-run it.
 */
function derive(tasks, nowMs) {
  const byPoster = new Map()
  const windows = []
  const entries = []
  const flow = { paid: 0, paidCount: 0, returned: 0, returnedCount: 0, held: 0, heldCount: 0 }
  const weekly = new Map()

  for (const t of tasks) {
    const reward = wei(t.reward)
    const req = String(t.requester || '').toLowerCase()

    const p = byPoster.get(req) || { tasks: 0, reward: 0 }
    p.tasks++
    p.reward += reward
    byPoster.set(req, p)

    if (t.expiryTime && t.createdAt) {
      const h = (Date.parse(t.expiryTime) - Date.parse(t.createdAt)) / 3600000
      if (Number.isFinite(h) && h >= 0 && h <= 24 * 366) windows.push(h)
    }

    if (typeof t.submissionCount === 'number') entries.push(t.submissionCount)

    if (PAID.has(t.status)) { flow.paid += reward; flow.paidCount++ }
    else if (RETURNED.has(t.status)) { flow.returned += reward; flow.returnedCount++ }
    else if (HELD.has(t.status)) { flow.held += reward; flow.heldCount++ }

    const w = weekStart(t.createdAt)
    const row = weekly.get(w) || { week: w, created: 0, rewardPosted: 0, posters: new Set() }
    row.created++
    row.rewardPosted += reward
    if (req) row.posters.add(req)
    weekly.set(w, row)
  }

  const posters = [...byPoster.entries()]
    .map(([address, v]) => ({ address, tasks: v.tasks, reward: round(v.reward) }))
    .sort((a, b) => b.tasks - a.tasks || b.reward - a.reward)

  const totalTasks = tasks.length || 1
  const totalReward = posters.reduce((a, p) => a + p.reward, 0) || 1
  const top10 = posters.slice(0, 10)

  // Herfindahl index over task counts: 1 = one poster, ~0 = evenly spread.
  const hhi = posters.reduce((a, p) => a + Math.pow(p.tasks / totalTasks, 2), 0)

  const rows = [...weekly.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((r) => ({ week: r.week, created: r.created, rewardPosted: round(r.rewardPosted), posters: r.posters.size }))

  // Last 7 full days vs the 7 before, on the task list's own clock.
  const end = new Date(nowMs)
  end.setUTCHours(0, 0, 0, 0)
  const dayMs = 86400000
  const inRange = (iso, from, to) => {
    const v = Date.parse(iso)
    return v >= from && v < to
  }
  const lastWeek = { tasks: 0, reward: 0 }
  const prevWeek = { tasks: 0, reward: 0 }
  for (const t of tasks) {
    const r = wei(t.reward)
    if (inRange(t.createdAt, end.getTime() - 7 * dayMs, end.getTime() + dayMs)) { lastWeek.tasks++; lastWeek.reward += r }
    else if (inRange(t.createdAt, end.getTime() - 14 * dayMs, end.getTime() - 7 * dayMs)) { prevWeek.tasks++; prevWeek.reward += r }
  }

  // What one entry is worth: the reward divided by the entries competing for it.
  const worth = []
  for (const t of tasks) {
    const n = Number(t.submissionCount) || 0
    const r = wei(t.reward)
    if (n > 0 && r > 0) worth.push(r / n)
  }

  return {
    posters: {
      total: posters.length,
      top10: top10.map((p) => ({ address: p.address, tasks: p.tasks, reward: p.reward })),
      hhi: Number(hhi.toFixed(5)),
      topShare: Number((top10[0].tasks / totalTasks).toFixed(4)),
      topRewardShare: Number((top10[0].reward / totalReward).toFixed(4)),
    },
    worth: { n: worth.length, median: round(median(worth), 4), p25: round(percentile(worth, 25), 4), p75: round(percentile(worth, 75), 4) },
    windows: { n: windows.length, medianHours: median(windows) == null ? null : round(median(windows), 2), p90Hours: percentile(windows, 90) == null ? null : round(percentile(windows, 90), 2) },
    entries: {
      n: entries.length,
      median: median(entries),
      p90: percentile(entries, 90),
      max: entries.length ? Math.max(...entries) : null,
      buckets: histogram(entries, [0, 1, 3, 6, 11, 26, 51, Infinity]),
    },
    flow: {
      paid: round(flow.paid), paidCount: flow.paidCount,
      returned: round(flow.returned), returnedCount: flow.returnedCount,
      held: round(flow.held), heldCount: flow.heldCount,
    },
    trend: {
      last7: { tasks: lastWeek.tasks, reward: round(lastWeek.reward) },
      prev7: { tasks: prevWeek.tasks, reward: round(prevWeek.reward) },
    },
    weekly: rows,
    topPosters: posters.slice(0, 8),
  }
}

async function main() {
  const generatedAt = new Date().toISOString()
  const nowMs = Date.parse(generatedAt)
  const out = { generatedAt, api: API, chains: [], platform: {}, notes: [] }

  // ---- platform-wide series (these endpoints ignore chainId; see notes) ----
  const tsDay = await get('/api/stats/platform-time-series?range=all&bucket=day')
  const tsWeek = await get('/api/stats/platform-time-series?range=all&bucket=week')
  note('/api/stats/platform-time-series?range=all&bucket=day|week', 'Platform-wide series: agents, tasks, rewards put up and rewards paid.')
  out.platform.timeSeries = { day: tsDay, week: tsWeek }

  const breakdowns = await get('/api/stats/breakdowns')
  note('/api/stats/breakdowns', 'Tasks by status, mode and actor type. Platform-wide.')
  out.platform.breakdowns = breakdowns

  const heat = await get('/api/stats/activity-heatmap?range=90d&dimension=hourOfWeek')
  note('/api/stats/activity-heatmap?range=90d&dimension=hourOfWeek', 'When the market is busy, by hour of week. Platform-wide, last 90 days.')
  out.platform.heatmap = heat

  const feed = await get('/api/stats/activity-feed?limit=40')
  note('/api/stats/activity-feed?limit=40', 'Live market activity. Platform-wide; items carry their own chainId.')
  out.platform.feed = feed

  // ---- per chain ----
  for (const chain of CHAINS) {
    const stats = await get('/api/market/stats?chainId=' + chain.id)
    note('/api/market/stats?chainId=' + chain.id, 'Headline numbers per chain (paidWorkers and activeWallets are per chain).')

    const tasks = await allTasks(chain.id)
    note('/api/tasks?chainId=' + chain.id + '&limit=100 (<cursor>)', 'Every task on this chain. Source for the per-chain series, the flow ledger, poster concentration and the open board.')

    const daily = {}
    const open = []
    const stale = []
    const titles = new Map()

    for (const t of tasks) {
      const d = day(t.createdAt)
      const row = (daily[d] = daily[d] || { day: d, created: 0, rewardPosted: 0, completed: 0, posters: new Set() })
      row.created++
      row.rewardPosted += wei(t.reward)
      if (t.status === 'completed') row.completed++
      if (t.requester) row.posters.add(String(t.requester).toLowerCase())

      if (t.status === 'open') {
        titles.set(t.id, String(t.description || '').split('\n')[0].slice(0, 150))
        const row2 = {
          id: t.id,
          ref: t.referenceCode,
          mode: t.mode,
          reward: wei(t.reward),
          entries: t.submissionCount || 0,
          createdAt: t.createdAt,
          expiryTime: t.expiryTime,
          tap: (t.verifiedBy || []).some((v) => /tap/i.test(v)),
        }
        // The API keeps tasks at status "open" after their expiry passes. Only a
        // future expiry is work an agent can actually take, so the live board
        // filters those out and reports the rest separately.
        if (t.expiryTime && Date.parse(t.expiryTime) <= nowMs) stale.push(row2)
        else open.push(row2)
      }
    }

    const dailyRows = Object.values(daily)
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((r) => ({ day: r.day, created: r.created, rewardPosted: round(r.rewardPosted), completed: r.completed, posters: r.posters.size }))

    const weeklyPosters = {}
    for (const t of tasks) {
      const w = weekStart(t.createdAt)
      ;(weeklyPosters[w] = weeklyPosters[w] || new Set()).add(String(t.requester || '').toLowerCase())
    }

    const derived = derive(tasks, nowMs)
    const openSorted = open.slice().sort((a, b) => b.entries - a.entries || b.reward - a.reward)
    const firstDay = tasks.reduce((a, t) => (t.createdAt && t.createdAt < a ? t.createdAt : a), '9999')

    out.chains.push({
      ...chain,
      stats,
      taskCount: tasks.length,
      firstTaskAt: firstDay === '9999' ? null : firstDay,
      statusCounts: tasks.reduce((acc, t) => ((acc[t.status] = (acc[t.status] || 0) + 1), acc), {}),
      modeCounts: tasks.reduce((acc, t) => ((acc[t.mode] = (acc[t.mode] || 0) + 1), acc), {}),
      daily: dailyRows,
      postersPerWeek: Object.entries(weeklyPosters)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([week, set]) => ({ week, posters: set.size })),
      // The page draws one cell per task the API still calls "open", split into
      // work you can take now and work whose expiry has already passed.
      board: [
        ...openSorted.map((t) => ({ ...t, live: 1 })),
        ...stale.sort((a, b) => b.reward - a.reward).map((t) => ({ ...t, live: 0 })),
      ].map((t) => ({ ref: t.ref, reward: t.reward, entries: t.entries, mode: t.mode, tap: t.tap ? 1 : 0, live: t.live })),
      // The eight busiest live tasks, with their titles.
      open: openSorted.slice(0, 8).map((t) => ({ ...t, title: titles.get(t.id) })),
      staleOpen: stale.length,
      staleVolume: round(stale.reduce((a, t) => a + t.reward, 0)),
      staleEntries: stale.reduce((a, t) => a + t.entries, 0),
      openCount: open.length,
      openVolume: round(open.reduce((a, t) => a + t.reward, 0)),
      tapCount: open.filter((t) => t.tap).length,
      claimedEntries: open.reduce((a, t) => a + t.entries, 0),
      derived,
    })
  }

  // ---- what the API does and does not filter, proved from this snapshot ----
  out.notes.push(
    'The API sends no CORS header, so this dashboard never calls it from the browser: all numbers come from this server-side snapshot.',
    '/api/market/stats respects chainId for paidWorkers and activeWallets; registeredWorkers, activeWorkers7d, activeAgents7d and openTasks are returned for the whole platform.',
    '/api/stats/breakdowns, /api/stats/platform-time-series, /api/stats/activity-heatmap and /api/stats/activity-feed return the same body for every chainId, so they are shown as platform-wide. Per-chain series here are computed from /api/tasks instead.',
    'Every per-chain figure is reproducible from /api/tasks?chainId=…: the flow ledger sums each task reward by status, poster concentration counts distinct requester addresses, and task windows are expiryTime minus createdAt.',
    'The flow ledger covers the tasks /api/tasks returns (' + out.chains.reduce((a, c) => a + c.taskCount, 0) + '), which is fewer than the platform-wide totals on the time-series chart. The two are labelled separately and never added together.'
  )

  out.totals = {
    tasksFetched: out.chains.reduce((a, c) => a + c.taskCount, 0),
    openTasks: out.chains.reduce((a, c) => a + c.openCount, 0),
    openVolume: round(out.chains.reduce((a, c) => a + c.openVolume, 0)),
    staleOpen: out.chains.reduce((a, c) => a + c.staleOpen, 0),
    staleVolume: round(out.chains.reduce((a, c) => a + c.staleVolume, 0)),
    claimedEntries: out.chains.reduce((a, c) => a + c.claimedEntries, 0),
    paid: round(out.chains.reduce((a, c) => a + c.derived.flow.paid, 0)),
    returned: round(out.chains.reduce((a, c) => a + c.derived.flow.returned, 0)),
    held: round(out.chains.reduce((a, c) => a + c.derived.flow.held, 0)),
    posters: out.chains.reduce((a, c) => a + c.derived.posters.total, 0),
  }

  out.totals.posted = round(out.totals.paid + out.totals.returned + out.totals.held)
  out.totals.liveOpen = out.totals.openTasks

  out.notes.push(
    'A task counts as open here only when status is open and its expiryTime is still in the future. The API keeps expired tasks at status "open", so ' +
      out.totals.staleOpen +
      ' tasks with a past expiry are counted separately as stale rather than offered as work.'
  )

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify({ ...out, methods }, null, 0))

  const { stat } = await import('node:fs/promises')
  const bytes = (await stat(OUT)).size
  console.log('wrote ' + OUT)
  console.log('  chains: ' + out.chains.map((c) => c.name + ' ' + c.taskCount + ' tasks / ' + c.openCount + ' open').join(' | '))
  console.log('  flow: paid ' + out.totals.paid + ' / returned ' + out.totals.returned + ' / held ' + out.totals.held)
  console.log('  size: ' + (bytes / 1024).toFixed(0) + ' KB')
}

main().catch((e) => {
  console.error('fetch failed: ' + (e && e.stack ? e.stack : e))
  process.exit(1)
})