/**
 * Smoke: verify the GitHub App JWT signing path works.
 *
 * Hits GET /app (App self-introspection — only needs the App JWT, no
 * installation token, so it works before any repo is picked).
 *
 * Run: pnpm tsx scripts/patcher-smoke-app.ts
 */

import { config as loadEnv } from 'dotenv'
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

loadEnv({ path: '.env.local' })

function loadKey(): string {
  if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
    return readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8')
  }
  const inline = process.env.GITHUB_APP_PRIVATE_KEY
  if (!inline) throw new Error('GITHUB_APP_PRIVATE_KEY[_PATH] not set')
  return inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf
  return b.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

const appId = process.env.GITHUB_APP_ID
if (!appId) throw new Error('GITHUB_APP_ID not set')

const now = Math.floor(Date.now() / 1000)
const header = { alg: 'RS256', typ: 'JWT' }
const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId }
const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
const signer = createSign('RSA-SHA256')
signer.update(signingInput)
const sig = signer.sign(loadKey())
const jwt = `${signingInput}.${b64url(sig)}`

console.log(`[smoke] signed JWT (len=${jwt.length})`)

const r = await fetch('https://api.github.com/app', {
  headers: {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
})

if (!r.ok) {
  const body = await r.text()
  console.error(`[smoke] FAIL: ${r.status} ${body.slice(0, 400)}`)
  process.exit(1)
}

const j = (await r.json()) as { name: string; id: number; owner: { login: string }; permissions: Record<string, string> }
console.log(`[smoke] OK — App "${j.name}" (id ${j.id}, owner ${j.owner.login})`)
console.log(`[smoke] permissions: ${JSON.stringify(j.permissions)}`)

// Also list installations so we can show the user their installation IDs
const installs = await fetch('https://api.github.com/app/installations', {
  headers: {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
}).then((rr) => rr.json() as Promise<Array<{ id: number; account: { login: string }; repository_selection: string }>>)

if (installs.length === 0) {
  console.log(`[smoke] no installations yet — install the App on your target repo to get an installation id`)
} else {
  console.log(`[smoke] installations:`)
  for (const inst of installs) {
    console.log(`  - id=${inst.id} on @${inst.account.login} (${inst.repository_selection})`)
  }
}
