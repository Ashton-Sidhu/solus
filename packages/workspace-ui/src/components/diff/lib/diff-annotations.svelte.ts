import { mount, unmount, tick, type ComponentProps, type getAllContexts } from 'svelte'
import type { CodeView, DiffLineAnnotation } from '@pierre/diffs'
import type { DiffComment } from '@solus/contracts/types'
import DiffInlineComment from '../DiffInlineComment.svelte'
import DiffThreadComment from '../DiffThreadComment.svelte'
import type { DiffReviewThread } from './interdiff-annotations'
import type { InlineCommentDraft } from '../diff-comment-draft.store.svelte'

export type AnnotationMeta =
  | { kind: 'comment'; comment: DiffComment }
  | { kind: 'thread'; thread: DiffReviewThread; collapsed: boolean }
  | { kind: 'draft' }

type ThreadProps = ComponentProps<typeof DiffThreadComment>
type CommentProps = ComponentProps<typeof DiffInlineComment>
interface AnnotationHostProps {
  onThreadReply: ThreadProps['onReply']
  onThreadResolve: ThreadProps['onToggleResolve']
  onEditComment: CommentProps['onEdit']
  onDeleteComment: CommentProps['onDelete']
  commentsSendWith?: CommentProps['sendsWith']
}
type AnnotationRoot = {
  target: HTMLDivElement
  instance: ReturnType<typeof mount>
} & (
  | { kind: 'thread'; props: ThreadProps }
  | { kind: 'comment'; props: CommentProps }
)

type AnnotationDraft = Pick<InlineCommentDraft, 'filePath' | 'range' | 'editingCommentId'>

const DRAFT_META: Extract<AnnotationMeta, { kind: 'draft' }> = { kind: 'draft' }

/** Own Svelte roots for the lifetime of their annotation, including file recycling. */
export class DiffAnnotations {
  private roots = new Map<string, AnnotationRoot>()
  private metadata = new Map<string, AnnotationMeta>()
  private byFile = new Map<string, DiffLineAnnotation<AnnotationMeta>[]>()
  private expandedThreads = new Set<string>()
  private revision = 0

  constructor(
    private context: ReturnType<typeof getAllContexts>,
    private hostProps: () => AnnotationHostProps,
    private remeasure: () => void,
  ) {}

  private setThreadCollapsed = (threadId: string, collapsed: boolean) => {
    if (collapsed) this.expandedThreads.delete(threadId)
    else this.expandedThreads.add(threadId)
    this.remeasure()
  }

  /** setItems replaces the library's file records, but does not end reply drafts. */
  resetFiles(): void {
    this.byFile.clear()
  }

  render(metadata: Exclude<AnnotationMeta, { kind: 'draft' }>): HTMLDivElement {
    const key = metadata.kind === 'thread' ? `thread:${metadata.thread.id}` : `comment:${metadata.comment.id}`
    const existing = this.roots.get(key)
    if (existing) return existing.target
    const target = document.createElement('div')
    const hostProps = this.hostProps()
    if (metadata.kind === 'thread') {
      const props: ThreadProps = $state({
        thread: metadata.thread,
        collapsed: metadata.collapsed,
        onReply: hostProps.onThreadReply,
        onToggleResolve: hostProps.onThreadResolve,
        onSetCollapsed: this.setThreadCollapsed,
      })
      this.roots.set(key, { kind: 'thread', target, props,
        instance: mount(DiffThreadComment, { target, context: this.context, props }) })
    } else {
      const props: CommentProps = $state({
        comment: metadata.comment,
        sendsWith: hostProps.commentsSendWith,
        onEdit: hostProps.onEditComment,
        onDelete: hostProps.onDeleteComment,
      })
      this.roots.set(key, { kind: 'comment', target, props,
        instance: mount(DiffInlineComment, { target, props }) })
    }
    return target
  }

  private commentMetadata(key: string, comment: DiffComment, hostProps: AnnotationHostProps): Extract<AnnotationMeta, { kind: 'comment' }> {
    const previous = this.metadata.get(key)
    const root = this.roots.get(key)
    if (root?.kind === 'comment') {
      root.props.comment = comment
      root.props.sendsWith = hostProps.commentsSendWith
      root.props.onEdit = hostProps.onEditComment
      root.props.onDelete = hostProps.onDeleteComment
    }
    return previous?.kind === 'comment' && previous.comment === comment
      ? previous : { kind: 'comment', comment }
  }

  private threadMetadata(key: string, thread: DiffReviewThread, hostProps: AnnotationHostProps): Extract<AnnotationMeta, { kind: 'thread' }> {
    const collapsed = thread.isResolved && !this.expandedThreads.has(thread.id)
    const previous = this.metadata.get(key)
    const root = this.roots.get(key)
    if (root?.kind === 'thread') {
      root.props.thread = thread
      root.props.collapsed = collapsed
      root.props.onReply = hostProps.onThreadReply
      root.props.onToggleResolve = hostProps.onThreadResolve
    }
    return previous?.kind === 'thread' && previous.thread === thread && previous.collapsed === collapsed
      ? previous : { kind: 'thread', thread, collapsed }
  }

  async sync(
    view: CodeView<AnnotationMeta>,
    paths: string[],
    comments: DiffComment[],
    threads: DiffReviewThread[],
    draft: AnnotationDraft,
  ): Promise<void> {
    const revision = ++this.revision
    const next = new Map<string, DiffLineAnnotation<AnnotationMeta>[]>()
    const liveMetadata = new Map<string, AnnotationMeta>()
    const filePaths = new Set(paths)
    const hostProps = this.hostProps()
    const add = (path: string, annotation: DiffLineAnnotation<AnnotationMeta>) => {
      const list = next.get(path)
      if (list) list.push(annotation)
      else next.set(path, [annotation])
    }
    for (const comment of comments) {
      if (!filePaths.has(comment.filePath) || comment.id === draft.editingCommentId) continue
      const key = `comment:${comment.id}`
      const metadata = this.commentMetadata(key, comment, hostProps)
      liveMetadata.set(key, metadata)
      add(comment.filePath, { side: comment.side === 'old' ? 'deletions' : 'additions', lineNumber: comment.endLine, metadata })
    }
    for (const thread of threads) {
      if (!filePaths.has(thread.filePath) || thread.line == null) continue
      const key = `thread:${thread.id}`
      const metadata = this.threadMetadata(key, thread, hostProps)
      liveMetadata.set(key, metadata)
      add(thread.filePath, { side: thread.side === 'LEFT' ? 'deletions' : 'additions', lineNumber: thread.line, metadata })
    }
    if (draft.filePath && draft.range && filePaths.has(draft.filePath)) {
      add(draft.filePath, { side: draft.range.side === 'old' ? 'deletions' : 'additions', lineNumber: draft.range.endLine, metadata: DRAFT_META })
    }
    for (const [key, root] of this.roots) {
      if (liveMetadata.has(key)) continue
      void unmount(root.instance)
      this.roots.delete(key)
      if (root.kind === 'thread') this.expandedThreads.delete(root.props.thread.id)
    }
    this.metadata = liveMetadata

    // Let existing roots apply changed props before CodeView measures their height.
    await tick()
    if (revision !== this.revision) return
    this.updateFiles(view, paths, next)
    this.byFile = next
  }

  private updateFiles(view: CodeView<AnnotationMeta>, paths: string[], next: Map<string, DiffLineAnnotation<AnnotationMeta>[]>): void {
    for (const path of paths) {
      const annotations = next.get(path) ?? []
      const previous = this.byFile.get(path) ?? []
      if (previous.length === annotations.length && previous.every((entry, i) =>
        entry.side === annotations[i].side && entry.lineNumber === annotations[i].lineNumber && entry.metadata === annotations[i].metadata)) continue
      const item = view.getItem(path)
      if (!item || item.type !== 'diff') continue
      item.annotations = annotations
      item.version = (item.version ?? 0) + 1
      view.updateItem(item)
    }
  }

  destroy(): void {
    this.revision++
    for (const root of this.roots.values()) void unmount(root.instance)
    this.roots.clear()
    this.metadata.clear()
    this.byFile.clear()
    this.expandedThreads.clear()
  }
}
