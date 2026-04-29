/**
 * Smoke: exchange App JWT -> installation token, list repos the App can access.
 *
 * Run: pnpm tsx scripts/patcher-smoke-install.ts <installationId>
 */

import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

const installationId = process.argv[2]
if (!installationId) {
  console.error('usage: pnpm tsx scripts/patcher-smoke-install.ts <installationId>')
  process.exit(1)
}

const { getInstallationToken } = await import('../lib/patcher/github')

const token = await getInstallationToken(Number(installationId))
console.log(`[smoke] installation token acquired (len=${token.length})`)

const r = await fetch('https://api.github.com/installation/repositories?per_page=100', {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
})
if (!r.ok) {
  console.error(`[smoke] FAIL ${r.status}: ${await r.text()}`)
  process.exit(1)
}
const j = (await r.json()) as { total_count: number; repositories: Array<{ full_name: string; default_branch: string; private: boolean }> }
console.log(`[smoke] ${j.total_count} accessible repo(s):`)
for (const repo of j.repositories) {
  console.log(`  - ${repo.full_name} (default: ${repo.default_branch}${repo.private ? ', private' : ''})`)
}
