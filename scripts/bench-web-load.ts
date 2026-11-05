/**
 * How long a first visit takes to download and run the web client's workspace
 * code, on a shaped network, in Chromium and WebKit (Safari's engine).
 *
 *   node scripts/bench-web-load.ts before=/tmp/build-a after=/tmp/build-b [--runs 5] [--profile slow|fast|local] [--json out.json]
 *
 * Each label names a `vite build` output of apps/client. The script serves it the
 * way the CDN does (HTTP/2 over TLS, Brotli) and shapes every response itself, so
 * both engines see the same network: each request waits one round trip, and all
 * responses share one bandwidth limit. Every run is a fresh browser context with
 * an empty cache. The timer ends at the `solus:workspace-code` mark, which
 * apps/client/src/main.ts sets when the workspace code has loaded and run. The
 * same run reads first contentful paint: before the mark when the HTML holds
 * the first screen, after it when the page draws nothing until its code has run.
 *
 * It measures code loading only: no sign-in and no host. Requests outside the
 * build answer 404 after one round trip.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createSecureServer, type Http2SecureServer, type ServerHttp2Stream } from 'node:http2'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'
import { chromium, webkit, type Browser } from 'playwright'

const PROFILES = {
  // A poor mobile connection.
  slow: { roundTripMs: 300, megabitsPerSecond: 1.5, cpuSlowdown: 4 },
  // A good home connection.
  fast: { roundTripMs: 40, megabitsPerSecond: 20, cpuSlowdown: 1 },
  // Files on this machine, as the desktop app loads them: only parse, compile, and run remain.
  local: { roundTripMs: 0, megabitsPerSecond: 100_000, cpuSlowdown: 1 },
}
const TYPES = new Map(Object.entries({
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.wasm': 'application/wasm',
}))

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args.splice(index, 2)[1]
}
const runs = Number(option('--runs') ?? 5)
const profileName = option('--profile') ?? 'slow'
if (profileName !== 'slow' && profileName !== 'fast' && profileName !== 'local') throw new Error(`--profile is slow, fast, or local, not ${profileName}`)
const jsonPath = option('--json')
const profile = PROFILES[profileName]
const builds = args.map((arg) => {
  const [label, dir] = arg.split('=')
  if (!label || !dir || !existsSync(join(dir, 'index.html'))) throw new Error(`Expected label=<vite build dir>, got ${arg}`)
  return { label, dir }
})
if (builds.length === 0) throw new Error('Name at least one build: label=<dir>')

interface Served { body: Buffer; type: string }

function compressBuild(dir: string): Map<string, Served> {
  const files = new Map<string, Served>()
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else files.set(`/${relative(dir, path)}`, {
        body: brotliCompressSync(readFileSync(path), { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
        type: TYPES.get(extname(path)) ?? 'application/octet-stream',
      })
    }
  }
  walk(dir)
  return files
}

/** One bandwidth limit shared by every response, sent in 16 KB slices. */
function bandwidthLimit(megabitsPerSecond: number) {
  const bytesPerMs = (megabitsPerSecond * 1_000_000) / 8 / 1000
  let nextFree = 0
  return (stream: ServerHttp2Stream, body: Buffer) => {
    for (let offset = 0; offset < body.length; offset += 16_384) {
      const slice = body.subarray(offset, offset + 16_384)
      const start = Math.max(performance.now(), nextFree)
      nextFree = start + slice.length / bytesPerMs
      const isLast = offset + 16_384 >= body.length
      setTimeout(() => {
        if (stream.destroyed) return
        if (isLast) stream.end(slice)
        else stream.write(slice)
      }, nextFree - performance.now())
    }
    if (body.length === 0) setTimeout(() => stream.end(), 0)
  }
}

interface Tls { key: Buffer; cert: Buffer }

function certificate(): Tls {
  const dir = mkdtempSync(join(tmpdir(), 'solus-bench-cert-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }
}

async function serve(files: Map<string, Served>, tls: Tls): Promise<{ server: Http2SecureServer; origin: string; reset: () => void }> {
  let send = bandwidthLimit(profile.megabitsPerSecond)
  const server = createSecureServer(tls)
  server.on('stream', (stream: ServerHttp2Stream, headers) => {
    // A run ends at its mark and closes the page while later chunks still stream.
    stream.on('error', () => {})
    const path = String(headers[':path'] ?? '/').split('?')[0]
    const file = files.get(path === '/' ? '/index.html' : path)
    setTimeout(() => {
      if (stream.destroyed) return
      if (!file) {
        stream.respond({ ':status': 404 })
        stream.end()
        return
      }
      stream.respond({ ':status': 200, 'content-type': file.type, 'content-encoding': 'br', 'cache-control': 'no-store' })
      send(stream, file.body)
    }, profile.roundTripMs)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || !('port' in address)) throw new Error('The benchmark server has no port')
  return { server, origin: `https://localhost:${address.port}`, reset: () => { send = bandwidthLimit(profile.megabitsPerSecond) } }
}

interface Sample { firstPaintMs: number; stylesMs: number; workspaceCodeMs: number; requests: number; transferredKb: number }

async function measure(browser: Browser, engine: string, origin: string): Promise<Sample> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  const page = await context.newPage()
  if (engine === 'chromium' && profile.cpuSlowdown > 1) {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuSlowdown })
  }
  await page.goto(origin, { waitUntil: 'commit' })
  await page.waitForFunction(() => performance.getEntriesByName('solus:workspace-code').length > 0, undefined, { timeout: 180_000, polling: 50 })
  // A page with no first screen in its HTML paints only after the mark (the page that follows it).
  await page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0, undefined, { timeout: 60_000, polling: 50 })
  const sample = await page.evaluate(() => {
    // SAFETY: entries of type 'resource' are PerformanceResourceTiming by the Resource Timing spec.
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    return {
      firstPaintMs: Math.round(performance.getEntriesByName('first-contentful-paint')[0].startTime),
      // The stylesheets the HTML links hold the first paint: when the last of them has arrived.
      stylesMs: Math.round(Math.max(0, ...[...document.querySelectorAll<HTMLLinkElement>('head > link[rel="stylesheet"]')]
        .map((link) => resources.find((entry) => entry.name === link.href)?.responseEnd ?? 0))),
      workspaceCodeMs: Math.round(performance.getEntriesByName('solus:workspace-code')[0].startTime),
      requests: resources.length + 1,
      transferredKb: Math.round(resources.reduce((sum, entry) => sum + entry.encodedBodySize, 0) / 1000),
    }
  })
  await context.close()
  return sample
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

const tls = certificate()
interface BuildResult { build: string; engine: string; firstPaintMedianMs: number; stylesMedianMs: number; medianMs: number; minMs: number; maxMs: number; requests: number; transferredKb: number }
const results: BuildResult[] = []
for (const engine of ['chromium', 'webkit'] as const) {
  const browser = await (engine === 'chromium' ? chromium : webkit).launch()
  for (const build of builds) {
    const { server, origin, reset } = await serve(compressBuild(build.dir), tls)
    const samples: Sample[] = []
    for (let run = 0; run < runs; run++) {
      reset()
      samples.push(await measure(browser, engine, origin))
    }
    server.close()
    const times = samples.map((sample) => sample.workspaceCodeMs)
    results.push({
      build: build.label, engine, firstPaintMedianMs: median(samples.map((sample) => sample.firstPaintMs)), stylesMedianMs: median(samples.map((sample) => sample.stylesMs)), medianMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times),
      requests: median(samples.map((sample) => sample.requests)), transferredKb: median(samples.map((sample) => sample.transferredKb)),
    })
  }
  await browser.close()
}

console.log(`profile ${profileName}: ${profile.roundTripMs} ms round trip, ${profile.megabitsPerSecond} Mbit/s, CPU ÷${profile.cpuSlowdown} (Chromium only); ${runs} runs each`)
console.log('engine    build            FCP median  CSS median  code median     min     max  requests  KB (br)')
for (const result of results) {
  console.log(`${result.engine.padEnd(9)} ${result.build.padEnd(16)} ${String(result.firstPaintMedianMs).padStart(10)} ${String(result.stylesMedianMs).padStart(11)} ${String(result.medianMs).padStart(12)} ${String(result.minMs).padStart(7)} ${String(result.maxMs).padStart(7)} ${String(result.requests).padStart(9)} ${String(result.transferredKb).padStart(8)}`)
}
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify({ profile, runs, results }, null, 2)}\n`)
