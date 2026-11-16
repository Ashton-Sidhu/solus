import { ArtifactOpenLog } from '@solus/client-core/recent-artifacts'
import type { SolusApp } from '../../../app/solus-app'

let log: ArtifactOpenLog | null = null

/** When this phone last opened each artifact, which orders the Threads screen's row. One log for the app. */
export function artifactOpenLog(app: SolusApp): ArtifactOpenLog {
  log ??= new ArtifactOpenLog(app.platform.storage)
  return log
}
