// What a session produced or linked (docs/plans/session-artifacts.md): the
// Artifacts surface reads one list that joins the session's pull requests,
// the works linked to it, and its file and automation links. Nothing here is
// stored on its own; each item names the record that holds it.

import type { SessionPullRequestLink } from './session-pull-requests'
import type { WorkType } from './types'

/** One pull request the session works on. */
export interface PullRequestArtifact {
  kind: 'pull-request'
  link: SessionPullRequestLink
}

/** One work (document, slides, diagram, or artifact) linked to the session. */
export interface WorkArtifact {
  kind: 'work'
  workId: string
  title: string
  workType: WorkType
  linkedAt: number
}

/** One file on the session's execution host. An image file is `image`. */
export interface FileArtifact {
  kind: 'file' | 'image'
  hostId: string
  path: string
  title: string
  linkedAt: number
}

/** One automation linked to the session. */
export interface AutomationArtifact {
  kind: 'automation'
  hostId: string
  automationId: string
  title: string
  linkedAt: number
}

export type SessionArtifact = PullRequestArtifact | WorkArtifact | FileArtifact | AutomationArtifact
export type SessionArtifactKind = SessionArtifact['kind']

/** The artifacts of one session. A lead's list carries one group per session it started. */
export interface SessionArtifactGroup {
  sessionId: string
  /** The session's name as the sidebar shows it; null when the record has none yet. */
  title: string | null
  items: SessionArtifact[]
}

export interface SessionArtifacts {
  /** The session's own artifacts. */
  own: SessionArtifact[]
  /** The artifacts of the sessions this session started, in the order they were started. */
  children: SessionArtifactGroup[]
}

/** Every artifact in a list, own first, then each child's. */
export function allSessionArtifacts(artifacts: SessionArtifacts): SessionArtifact[] {
  return [...artifacts.own, ...artifacts.children.flatMap((group) => group.items)]
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic'])

/** Whether a linked file is shown as an image, by its extension. */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}
