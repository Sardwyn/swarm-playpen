// Which browser automation is available on this machine?
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
for (const p of ['playwright', 'playwright-core', 'puppeteer', 'puppeteer-core']) {
  try {
    console.log(p, '->', require.resolve(p))
  } catch {
    console.log(p, '-> not resolvable')
  }
}
