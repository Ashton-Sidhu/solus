import type { Message } from '@solus/contracts/types'
import { messageReplyImages, replyImage, toolResultImages, type ReplyImage } from '@solus/client-core/reply-images'
import { viewedImagePath, workspaceRelativeImagePath } from '@solus/client-core/viewed-workspace-image'
import { hostPathKey, joinHostPath } from '@solus/contracts/host-path'
import { snapshotHref } from '../../browser/lib/snapshot-card'

/** The images a message adds to its turn's gallery: an image artifact, or the
 *  images its reply links. A tool row adds none. */
export function messageImages(message: Message): ReplyImage[] {
  if (message.artifact?.kind === 'image' && message.artifact.path) return [replyImage(message.artifact.path)]
  return message.role === 'tool' ? [] : messageReplyImages(message)
}

/** The images an open tool row shows. A call still running has none to decode. */
export function toolRowImages(tool: Message): ReplyImage[] {
  return tool.toolStatus === 'running' ? [] : toolResultImages(tool.toolImages)
}

/** Workspace files opened by the group's calls, in read order. */
export function toolGroupViewedImages(tools: readonly Message[], cwd: string | undefined): string[] {
  if (!cwd) return []
  const paths = new Map<string, string>()
  for (const tool of tools) {
    const viewed = viewedImagePath(tool.toolName, tool.toolInput, tool.toolStatus)
    const relative = viewed && workspaceRelativeImagePath(viewed, cwd)
    if (!relative) continue
    const path = joinHostPath(cwd, relative)
    const key = hostPathKey(path)
    if (!paths.has(key)) paths.set(key, path)
  }
  return [...paths.values()]
}

/** Every picture a turn's gallery shows, in turn order: the images its replies
 *  name and its browser captures. One viewer steps through all of them. */
export function galleryHrefs(messages: Message[]): string[] {
  return messages.flatMap((message) =>
    message.browserSnapshot
      ? [snapshotHref(message.browserSnapshot)]
      : messageImages(message).map((image) => image.href))
}

/** Whether a turn's gallery has a slide. The carousel mounts only then: an
 *  empty one still measured itself, which forced a layout of the whole
 *  transcript for every turn a session opened with. */
export function hasGallerySlides(messages: Message[]): boolean {
  return messages.some((message) => !!message.browserSnapshot || messageImages(message).length > 0)
}
