import { resolve } from 'node:path'
import { assertTestBuild } from '../../scripts/qa/build-identity'

/** Refuse a stale or production build before any test process starts. */
export default function globalSetup() {
  assertTestBuild(resolve(__dirname, '../..'))
}
