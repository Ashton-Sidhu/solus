/** A TCP proxy that limits server→client throughput, as a slow remote link. */
import net from 'node:net'

const [listenPort, targetPort, mbpsArg] = process.argv.slice(2)
const bytesPerMs = (Number(mbpsArg) * 1_000_000) / 8 / 1000
const LINK_BUFFER = 64 * 1024

net.createServer((client) => {
  const upstream = net.connect(Number(targetPort), process.env.SERVER_HOST ?? '127.0.0.1')
  client.pipe(upstream)
  const queue: Buffer[] = []
  let queued = 0
  let last = performance.now()
  upstream.on('data', (chunk: Buffer) => {
    queue.push(chunk)
    queued += chunk.length
    if (queued > LINK_BUFFER) upstream.pause()
  })
  const timer = setInterval(() => {
    const now = performance.now()
    let budget = Math.floor((now - last) * bytesPerMs)
    last = now
    while (budget > 0 && queue.length) {
      const head = queue[0]!
      const take = Math.min(budget, head.length)
      client.write(head.subarray(0, take))
      if (take === head.length) queue.shift()
      else queue[0] = head.subarray(take)
      queued -= take
      budget -= take
    }
    if (queued <= LINK_BUFFER) upstream.resume()
  }, 2)
  const end = () => { clearInterval(timer); client.destroy(); upstream.destroy() }
  client.on('close', end)
  upstream.on('close', end)
  client.on('error', end)
  upstream.on('error', end)
}).listen(Number(listenPort), '127.0.0.1', () => console.log('ready'))
