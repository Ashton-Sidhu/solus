/**
 * An embedded Postgres for the Lab's local cloud: PGlite on a data directory, served on
 * the Postgres wire protocol on loopback, so the cloud's dev server and its migrations
 * connect with an ordinary `DATABASE_URL` and no Docker.
 *
 *   bun packages/lab/src/pglite-server.ts <solus-cloud dir> <data dir> <port>
 *
 * PGlite has one session. Many client connections share it, so a connection holds the
 * session for one whole exchange: from its first message to the `Sync` or simple `Query`
 * that ends it, and longer while a transaction it began is open. (The multiplexer of
 * `@electric-sql/pglite-socket` shares the session per message, so the `Parse` of one
 * connection and the `Bind` of another meet, and the cloud's first queries fail.)
 * PGlite comes from the cloud checkout, which already depends on it.
 */
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'

interface PGliteSession {
  waitReady: Promise<void>
  execProtocolRawStream(message: Uint8Array, options: { onRawData: (data: Uint8Array) => void }): Promise<void>
  isInTransaction(): boolean
  exec(query: string): Promise<unknown>
  close(): Promise<void>
}
interface PGliteModule {
  PGlite: new (dataDir: string) => PGliteSession
}

const SSL_REQUEST = 80877103
const PROTOCOL_3 = 196608

const [cloudDir, dataDir, portArgument] = process.argv.slice(2)
if (!cloudDir || !dataDir || !portArgument) {
  console.error('usage: bun pglite-server.ts <solus-cloud dir> <data dir> <port>')
  process.exit(2)
}

// SAFETY: the module is PGlite's own entry; the interface above names the members used here.
const pglite = (await import(join(cloudDir, 'node_modules/@electric-sql/pglite/dist/index.js'))) as PGliteModule
const db = new pglite.PGlite(dataDir)
await db.waitReady

let owner: Socket | null = null
const waiters: Array<() => void> = []

async function acquire(connection: Socket): Promise<void> {
  while (owner !== null && owner !== connection) await new Promise<void>((wake) => waiters.push(wake))
  owner = connection
}

function release(connection: Socket): void {
  if (owner !== connection || db.isInTransaction()) return
  owner = null
  for (const wake of waiters.splice(0)) wake()
}

function serve(socket: Socket): void {
  let buffer = Buffer.alloc(0)
  let batch: Buffer[] = []
  let started = false
  let chain = Promise.resolve()

  /** `endsExchange`: the batch ends with `Sync` or a simple `Query`; after a `Flush` the client sends more of the same exchange. */
  const run = (messages: Buffer[], endsExchange: boolean) => {
    chain = chain.then(async () => {
      await acquire(socket)
      try {
        for (const message of messages) {
          await db.execProtocolRawStream(new Uint8Array(message), {
            onRawData: (data) => { if (socket.writable) socket.write(Buffer.from(data)) },
          })
        }
      } finally {
        if (endsExchange) release(socket)
      }
    }).catch((error: unknown) => {
      console.error('pglite_exchange_failed', error)
      socket.destroy()
    })
  }

  socket.on('data', (data: Buffer) => {
    buffer = Buffer.concat([buffer, data])
    while (true) {
      if (!started) {
        if (buffer.length < 8) return
        const length = buffer.readInt32BE(0)
        const code = buffer.readInt32BE(4)
        if (length === 8 && code === SSL_REQUEST) {
          socket.write('N')
          buffer = buffer.subarray(8)
          continue
        }
        if (code !== PROTOCOL_3 || buffer.length < length) return
        run([buffer.subarray(0, length)], true)
        buffer = buffer.subarray(length)
        started = true
        continue
      }
      if (buffer.length < 5) return
      const length = 1 + buffer.readInt32BE(1)
      if (buffer.length < length) return
      const message = buffer.subarray(0, length)
      buffer = buffer.subarray(length)
      const type = String.fromCharCode(message[0]!)
      if (type === 'X') {
        socket.end()
        return
      }
      batch.push(message)
      // `Sync`, a simple `Query`, and `Flush` end what a client waits on.
      if (type === 'S' || type === 'Q' || type === 'H') {
        run(batch, type !== 'H')
        batch = []
      }
    }
  })
  socket.on('close', () => {
    chain = chain.then(async () => {
      // A connection that leaves inside its transaction must not keep the session.
      if (owner === socket && db.isInTransaction()) await db.exec('ROLLBACK')
      if (owner === socket) {
        owner = null
        for (const wake of waiters.splice(0)) wake()
      }
    })
  })
  socket.on('error', () => socket.destroy())
}

const server = createServer(serve)
server.listen(Number(portArgument), '127.0.0.1', () => {
  const address = server.address()
  console.log(`pglite_listening ${typeof address === 'object' && address ? address.port : portArgument}`)
})

const stop = async () => {
  server.close()
  await db.close()
  process.exit(0)
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
