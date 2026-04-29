import type { Browser } from 'playwright'

const isVercel = !!process.env.VERCEL

export async function launchChromium(opts: { slowMo?: number } = {}): Promise<Browser> {
  if (isVercel) {
    const [{ chromium }, sparticuz] = await Promise.all([
      import('playwright-core'),
      import('@sparticuz/chromium').then((m) => m.default),
    ])
    return chromium.launch({
      headless: true,
      args: sparticuz.args,
      executablePath: await sparticuz.executablePath(),
      slowMo: opts.slowMo,
    }) as unknown as Browser
  }

  const { chromium } = await import('playwright')
  return chromium.launch({
    headless: true,
    channel: 'chromium',
    slowMo: opts.slowMo,
  })
}
