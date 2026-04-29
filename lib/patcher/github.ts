/**
 * GitHub App auth + PR creation.
 *
 * Why an App and not a fine-grained PAT:
 *   - PATs hit a known 403 on PR creation in some configurations
 *     (https://github.com/orgs/community/discussions/106661)
 *   - Apps are tied to the App identity, not a user, so PRs are authored by the bot
 *   - Apps support short-lived installation tokens (1h max) — better blast radius
 *
 * Flow:
 *   1. Sign a 10-min JWT with the App's private key (RS256)
 *   2. POST /app/installations/{id}/access_tokens — get a 1h installation token
 *   3. Use that token with the standard REST API for branch/commit/PR operations
 *
 * No extra deps — Node's `crypto.createSign('RSA-SHA256')` does RS256 natively.
 */

import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

export type GithubRepo = { owner: string; repo: string }

function loadPrivateKey(): string {
  if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
    return readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8')
  }
  const inline = process.env.GITHUB_APP_PRIVATE_KEY
  if (!inline) {
    throw new Error(
      'GitHub App private key missing — set GITHUB_APP_PRIVATE_KEY (PEM) or GITHUB_APP_PRIVATE_KEY_PATH'
    )
  }
  // Allow `\n`-encoded newlines for env-var convenience
  return inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf
  return b.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/** Sign a 10-minute JWT identifying the GitHub App itself. */
function signAppJwt(): string {
  const appId = process.env.GITHUB_APP_ID
  if (!appId) throw new Error('GITHUB_APP_ID not set')
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  // GitHub recommends iat = now - 60s to absorb clock skew, exp ≤ now + 600s
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId }
  const encHeader = b64url(JSON.stringify(header))
  const encPayload = b64url(JSON.stringify(payload))
  const signingInput = `${encHeader}.${encPayload}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  const sig = signer.sign(loadPrivateKey())
  return `${signingInput}.${b64url(sig)}`
}

const tokenCache = new Map<number, { token: string; expiresAt: number }>()

/** Exchange an App JWT for an installation access token (cached, ~1h TTL). */
export async function getInstallationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId)
  // Refresh 60s before expiry to avoid races
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token

  const jwt = signAppJwt()
  const r = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  )
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`GitHub installation token exchange failed: ${r.status} ${body.slice(0, 200)}`)
  }
  const j = (await r.json()) as { token: string; expires_at: string }
  const expiresAt = new Date(j.expires_at).getTime()
  tokenCache.set(installationId, { token: j.token, expiresAt })
  return j.token
}

async function gh<T>(
  token: string,
  path: string,
  opts?: { method?: string; json?: unknown }
): Promise<T> {
  const r = await fetch(`https://api.github.com${path}`, {
    method: opts?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: opts?.json !== undefined ? JSON.stringify(opts.json) : undefined,
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`GitHub ${opts?.method ?? 'GET'} ${path}: ${r.status} ${body.slice(0, 300)}`)
  }
  return (await r.json()) as T
}

/** Look up the SHA the base branch points at (used as the parent for our new branch). */
export async function getBaseBranchSha(token: string, repo: GithubRepo, branch: string): Promise<string> {
  const j = await gh<{ object: { sha: string } }>(
    token,
    `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${branch}`
  )
  return j.object.sha
}

/** Create a feature branch off baseSha. Idempotent: returns silently if it already exists. */
export async function createBranch(
  token: string,
  repo: GithubRepo,
  branchName: string,
  baseSha: string
): Promise<void> {
  try {
    await gh(token, `/repos/${repo.owner}/${repo.repo}/git/refs`, {
      method: 'POST',
      json: { ref: `refs/heads/${branchName}`, sha: baseSha },
    })
  } catch (e) {
    const msg = (e as Error).message
    if (!/Reference already exists/i.test(msg)) throw e
  }
}

/**
 * Open a PR.
 *
 * Branch protection on the base branch is the user's responsibility — we
 * never merge, we only PR. Body should already include the DO NOT MERGE
 * notice (built upstream in lib/patcher/prompt.ts).
 */
export async function openPullRequest(
  token: string,
  repo: GithubRepo,
  opts: { branch: string; baseBranch: string; title: string; body: string; labels?: string[] }
): Promise<{ number: number; url: string }> {
  const pr = await gh<{ number: number; html_url: string }>(
    token,
    `/repos/${repo.owner}/${repo.repo}/pulls`,
    {
      method: 'POST',
      json: { title: opts.title, head: opts.branch, base: opts.baseBranch, body: opts.body },
    }
  )
  if (opts.labels?.length) {
    // Best-effort — missing labels just no-op
    await gh(token, `/repos/${repo.owner}/${repo.repo}/issues/${pr.number}/labels`, {
      method: 'POST',
      json: { labels: opts.labels },
    }).catch(() => {})
  }
  return { number: pr.number, url: pr.html_url }
}

/**
 * Helper for the orchestrator: returns the git remote URL the sandbox should
 * use to push, with the installation token embedded for HTTPS auth.
 */
export function authedRemoteUrl(token: string, repo: GithubRepo): string {
  // x-access-token is GitHub's documented username for App tokens over HTTPS
  return `https://x-access-token:${token}@github.com/${repo.owner}/${repo.repo}.git`
}
