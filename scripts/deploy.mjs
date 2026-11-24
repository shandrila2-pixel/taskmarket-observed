/**
 * deploy.mjs — publish this dashboard to GitHub Pages in one command.
 *
 *   GITHUB_TOKEN=ghp_… GITHUB_REPO=you/taskmarket-observed node deploy.mjs
 *
 * What it does:
 *   1. runs the fetch, so the deployed snapshot is the one you just took
 *   2. commits the working tree to a fresh `main` and force-pushes it
 *   3. switches the repo's Pages site to the GitHub Actions workflow
 *
 * The workflow in .github/workflows/deploy.yml does the rest: it re-runs the
 * fetch every hour, uploads public/ as the site, and deploys it. Nothing is
 * committed by CI, so the repository stays clean and the site never drifts.
 *
 * No dependencies. Node 20+.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const REPO = process.env.GITHUB_REPO

if (!TOKEN) fail('set GITHUB_TOKEN to a token with the "repo" scope')
if (!REPO || !/^[\w.-]+\/[\w.-]+$/.test(REPO)) fail('set GITHUB_REPO=owner/name')

function fail(msg) {
  console.error('deploy: ' + msg)
  process.exit(1)
}

function git(...args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
}

function step(msg) {
  console.log('→ ' + msg)
}

/* 1. fresh data ---------------------------------------------------------- */
step('fetching a fresh snapshot')
execFileSync(process.execPath, ['scripts/fetch.mjs'], { stdio: 'inherit' })

/* 2. push ---------------------------------------------------------------- */
step('committing and pushing')
if (!existsSync('.git')) {
  git('init', '-q')
  git('checkout', '-q', '-b', 'main')
}
git('add', '-A')
try {
  git('commit', '-q', '-m', 'Deploy ' + new Date().toISOString().slice(0, 16).replace('T', ' '))
} catch {
  step('nothing new to commit, pushing the existing tree')
}
const remote = 'https://x-access-token:' + encodeURIComponent(TOKEN) + '@github.com/' + REPO + '.git'
try {
  git('remote', 'remove', 'origin')
} catch {}
git('remote', 'add', 'origin', remote)
git('push', '-q', '--force', 'origin', 'main')

/* 3. pages --------------------------------------------------------------- */
step('pointing GitHub Pages at the workflow')

const api = async (path, init = {}) => {
  const res = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + TOKEN,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const body = await res.text()
  return { ok: res.ok, status: res.status, body: body ? JSON.parse(body) : null }
}

const repo = await api('/repos/' + REPO)
if (!repo.ok) fail('cannot read the repo: HTTP ' + repo.status + ' ' + (repo.body && repo.body.message))

// Create the Pages site if it does not exist yet, then make sure it builds
// from the workflow rather than from a branch.
let pages = await api('/repos/' + REPO + '/pages')
if (pages.status === 404) {
  pages = await api('/repos/' + REPO + '/pages', { method: 'POST', body: JSON.stringify({ build_type: 'workflow' }) })
} else if (pages.ok && pages.body.build_type !== 'workflow') {
  pages = await api('/repos/' + REPO + '/pages', { method: 'PUT', body: JSON.stringify({ build_type: 'workflow' }) })
}
if (!pages.ok && pages.status !== 409) {
  fail('cannot configure Pages: HTTP ' + pages.status + ' ' + (pages.body && pages.body.message))
}

// Make the workflow public-safe: the artifact must be readable by Pages.
const workflow = await api('/repos/' + REPO + '/actions/workflows/deploy.yml/enable', { method: 'PUT' })
if (!workflow.ok && workflow.status !== 404) {
  console.warn('  note: could not enable the workflow automatically (HTTP ' + workflow.status + ')')
}

const owner = REPO.split('/')[0].toLowerCase()
const name = REPO.split('/')[1].toLowerCase()
console.log('\nDone. The first deploy takes a minute.')
console.log('  site: https://' + owner + '.github.io/' + name + '/')
console.log('  runs: https://github.com/' + REPO + '/actions')

// Strip the token from the saved remote so it does not sit in .git/config.
try {
  git('remote', 'set-url', 'origin', 'https://github.com/' + REPO + '.git')
} catch {}