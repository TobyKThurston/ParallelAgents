/**
 * Run the Helix mock SaaS site as a standalone web server you can browse
 * yourself. No swarm, no agents — just the buggy app.
 *
 *   pnpm run helix          → http://127.0.0.1:3100
 *   pnpm run helix -- 4000  → http://127.0.0.1:4000
 */

import { startBuggyServer } from '../lib/buggy-cart-server'

const portArg = process.argv[2]
const port = portArg ? parseInt(portArg, 10) : 3100

startBuggyServer(port)
  .then((s) => {
    console.log('')
    console.log(`  ◆ Helix · running at ${s.url}`)
    console.log(`    /             dashboard`)
    console.log(`    /issues       issue list`)
    console.log(`    /issues/new   create issue (race + XSS + 5xx bugs)`)
    console.log(`    /billing      plan upgrade (race + 5xx + coupon abuse)`)
    console.log(`    /settings     profile (avatar URL javascript: bypass)`)
    console.log('')
    console.log('  Ctrl+C to stop.')
    console.log('')
  })
  .catch((e) => {
    if ((e as any)?.code === 'EADDRINUSE') {
      console.error(`port ${port} is already in use. try: pnpm run helix -- 4000`)
    } else {
      console.error(e)
    }
    process.exit(1)
  })
