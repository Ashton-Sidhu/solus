/**
 * Worker for `scripts/check-mobile-compiler-coverage.ts`: covers one share of
 * the native sources and posts the outcomes back.
 *
 * The Expo transformer sets BABEL_ENV for each file and restores it after.
 * Fixing both variables here keeps that restore from switching a plugin to
 * development output in the middle of another file.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { coverFile, mobileToolchain, type CoverageRequest } from './mobile-compiler-transform'

process.env.NODE_ENV = 'production'
process.env.BABEL_ENV = 'production'

const requests: CoverageRequest[] = workerData
const root = requests[0]?.root
if (root) {
  const tools = mobileToolchain(root)
  parentPort?.postMessage(requests.map((request) => coverFile(tools, request)))
} else {
  parentPort?.postMessage([])
}
