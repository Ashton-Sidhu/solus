import { readFile } from 'node:fs/promises'
import { APP_DEPLOYMENT_ENV, appAccessModeSchema, appKeySchema, appLinkSecretSchema, appVersionPushSchema, appVisitorRoleSchema } from '@solus/contracts/app-deployments'
import { parsePort } from '@solus/contracts/entrypoint'
import { randomBytes } from 'node:crypto'
import packageJson from '../../../package.json'
import { AppRuntime } from '@solus/server/apps/runtime/app-runtime'
import { listenRuntime } from '@solus/server/apps/runtime/runtime-http'
import { closeDbForShutdown } from '@solus/server/db'
import { createLogger, flushLogs } from '@solus/server/logger'

/**
 * The process of a `solus-apps-runtime` container (docs/plans/app-deploy.md
 * §5.1): one app, its data in `SOLUS_DATA_DIR`, and the management API on
 * `PORT`. Everything it knows of its Solus is in its env vars.
 */

const log = createLogger('main', 'apps-runtime')

const DEFAULT_PORT = 8080
const DEFAULT_DATA_DIR = '/data'

/**
 * An exported image holds one version (docs/plans/app-deploy.md §8.4): no
 * Solus sends it one. Its access is in its env vars: public, or a link whose
 * secret the person who runs the image chose.
 */
async function takeHeldVersion(runtime: AppRuntime): Promise<void> {
  const file = process.env[APP_DEPLOYMENT_ENV.versionFile]
  if (!file) return
  const held = appVersionPushSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const mode = appAccessModeSchema.parse(process.env[APP_DEPLOYMENT_ENV.access] ?? 'link')
  const linkSecret = process.env[APP_DEPLOYMENT_ENV.linkSecret]
  if (mode === 'link' && !linkSecret) throw new Error(`Set ${APP_DEPLOYMENT_ENV.linkSecret} to 43 characters of a-z, A-Z, 0-9, - and _, or set ${APP_DEPLOYMENT_ENV.access}=public.`)
  const receipt = await runtime.receiveVersion({
    ...held,
    // A public app has no link; the runtime still keeps a secret, which nobody has.
    access: { mode, role: appVisitorRoleSchema.parse(process.env[APP_DEPLOYMENT_ENV.role] ?? 'editor'), linkSecret: appLinkSecretSchema.parse(linkSecret ?? randomBytes(32).toString('base64url')) },
  })
  if (!receipt.active) throw new Error(`The version in this image did not start: ${receipt.error}`)
}

async function main(): Promise<void> {
  // A container's platform collects stdout. The runtime writes no log file, in a container or out of one.
  process.env.SOLUS_LOG_STDOUT ||= '1'
  process.env[APP_DEPLOYMENT_ENV.dataDir] ||= DEFAULT_DATA_DIR
  const portValue = process.env[APP_DEPLOYMENT_ENV.port]
  const port = portValue == null || portValue.trim() === '' ? DEFAULT_PORT : parsePort(portValue, APP_DEPLOYMENT_ENV.port)
  const keyValue = process.env[APP_DEPLOYMENT_ENV.appKey]
  const appKey = keyValue ? appKeySchema.parse(keyValue) : null
  // The listener has the key now. No other part of the process reads it.
  delete process.env[APP_DEPLOYMENT_ENV.appKey]

  const solusUrl = process.env[APP_DEPLOYMENT_ENV.solusUrl]
  const runtime = new AppRuntime({ release: packageJson.version, solus: solusUrl && appKey ? { url: solusUrl, appKey } : null })
  await runtime.start()
  await takeHeldVersion(runtime)
  // A port of 0 lets the system choose one; the line below says which.
  const { server, port: listening } = await listenRuntime({ runtime, appKey }, port)
  if (!appKey) log.warn('app_runtime_no_app_key', {})
  process.stdout.write(`solus-apps-runtime ${packageJson.version} listens on port ${listening}\n`)

  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    server.close()
    runtime.stop()
    closeDbForShutdown()
    flushLogs()
    process.exit(0)
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

main().catch((error) => {
  process.stderr.write(`solus-apps-runtime could not start: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
