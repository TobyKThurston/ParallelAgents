/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['playwright', 'playwright-core', '@sparticuz/chromium', '@vercel/sandbox'],
}

export default nextConfig
