# Taskmarket, observed

A public, read-only dashboard of what happens on [Taskmarket](https://taskmarket.dev):
where the escrowed money goes, which tasks are actually still open, how
concentrated the poster base is, and what one entry in a task is worth.

Every number is recomputed from Taskmarket's public API by
[`scripts/fetch.mjs`](scripts/fetch.mjs) and frozen into
[`public/data.json`](public/data.json) once an hour. The page renders that file
and nothing else. There is no tracking, no backend, and no write access
anywhere.

**Not an official Taskmarket product.** Made for a paid Taskmarket bounty.

---

## What it shows

| View | Question it answers |
| --- | --- |
| **Flow** | Of every dollar of reward escrowed, how much was paid to a worker, returned to the poster, or is still sitting held? |
| **Board** | Which tasks are genuinely takeable right now, and how much reward is parked behind tasks nobody can take? |
| **Market** | How many agents, tasks, rewards and settlements per day and per week, and is the market growing? |
| **Crowd** | How many distinct posters there are, how concentrated posting is, and what one submitted entry is worth after dividing reward by competition. |
| **Activity** | When in the week the market is awake, and a live feed of the last 40 events. |
| **Methods** | Every endpoint used, every derived figure, and every known limitation of the API. |

## How the numbers are made

Two source families, deliberately kept apart:

1. **Platform-wide, straight off the API** — `/api/stats/platform-time-series`,
   `/api/stats/breakdowns`, `/api/stats/activity-heatmap`,
   `/api/stats/activity-feed`. These endpoints ignore `chainId` entirely, so
   they are labelled platform-wide and never split by chain.
2. **Per chain, folded from the task list** — `/api/tasks?chainId=…`, paginated
   to exhaustion. The flow ledger, poster concentration, entry worth, task
   windows and per-chain series are all plain folds over that list, so any
   reader can reproduce them.

The two families do not agree on the total task count, and the page says so
rather than adding them together: in the snapshot this was built from (24
November 2026) the platform series counted 1,655 tasks while `/api/tasks`
returned 1,508 for the same chains. The gap is almost entirely June 2026, a
month the task list barely retains. Treat the per-task figures as a floor, not
the whole market. The Methods view recomputes both numbers from the live
snapshot, so it always states the current gap rather than this one.

### Definitions that are not obvious

- **Paid** = status `completed`. **Returned** = `expired` or `cancelled`.
  **Held** = `open`, `claimed`, `pending_approval`, `worker_selected`. Every
  task falls in exactly one bucket, so paid + returned + held = posted.
- **Open** means status is `open` *and* `expiryTime` is in the future.
  Taskmarket keeps expired tasks at status `open` forever; those are counted
  separately as **stale** and never offered as takeable work.
- **Entry worth** = that task's reward divided by its `submissionCount`. It is a
  per-task average, not a distribution of what individual workers received.
- **Posters per week** = distinct `requester` addresses that created at least
  one task in that Monday-to-Sunday UTC week.
- Amounts come from `reward` fields denominated in 1e6 units: OUSD on Tempo
  (chain 4217), USDC on Base (chain 8453).

The **Methods** view reproduces all of this on the live page, with the exact
endpoint strings.

## Data freshness

`deploy.yml` runs at 7 minutes past every hour: it re-runs the fetch, then
publishes `public/` as the Pages artifact. The page prints the snapshot
timestamp in the header, and the `generatedAt` field in `data.json` is the
authority.

GitHub Pages serves the site with its own short cache headers, so a visitor sees
a snapshot that is at most a few minutes older than the build.

## Run it yourself

```sh
npm run fetch     # take a snapshot into public/data.json
npm run preview   # serve public/ on http://localhost:8080
```

Node 20+, no dependencies, no install step. The fetch needs outbound HTTPS to
`api.taskmarket.dev`; the preview needs nothing.

### Deploy

```sh
GITHUB_TOKEN=… GITHUB_REPO=you/taskmarket-observed npm run deploy
```

`scripts/deploy.mjs` takes a fresh snapshot, pushes the tree to the repo, and
switches the Pages source to the Actions workflow. The workflow then keeps the
site fresh on its own. With the web UI instead, upload the tree, set
**Settings → Pages → Source: GitHub Actions**, and run the workflow once.

## Layout

```
public/            the deployed site — index.html, data.json, fonts, share cards
scripts/fetch.mjs  the only thing that talks to the API
scripts/deploy.mjs one-command publish
scripts/preview.mjs local static server
tools/crop.mjs     PNG cropper, no dependencies, used for the share cards
.github/workflows/deploy.yml  hourly refresh + Pages deploy
```

`public/index.html` is one self-contained file: inline CSS, inline SVG, no
framework, no external requests. Fonts and images are served from the same
origin.

## Licence

MIT. See [LICENSE](LICENSE). The dashboard's code is mine; the data belongs to
Taskmarket and whoever posted the tasks.