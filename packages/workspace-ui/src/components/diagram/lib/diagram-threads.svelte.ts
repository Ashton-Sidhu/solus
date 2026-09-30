import type { PlanComment } from "@solus/contracts/types";
import { uuid } from "@solus/contracts/uuid";
import type { SurfaceContext } from "../../../contexts";
import { formatInlineComments } from "../../../contexts/workspace/session.utils";
import { isResolved, isUnread, type CommentReader } from "../../comments/lib/thread";
import { firstUnreadThread, pinSummary, threadCounts, threadsByAnchor, type PinSummary } from "./comment-threads";
import type { ThreadAnchor } from "./thread-card-position";

interface ThreadOptions {
  surface: SurfaceContext;
  workId: () => string | undefined;
  title: () => string;
  reader: () => CommentReader;
  /** What a thread anchored to this node or edge is about, for its byline. */
  anchorLabel: (anchor: ThreadAnchor) => string | null;
  /** Select the anchor so the inspector agrees with the thread. */
  selectAnchor: (anchor: ThreadAnchor) => void;
  /** Bring a node into view, selected. */
  revealNode: (nodeId: string) => void;
  /** The panel and the inspector share the side of the board. */
  closeDrawers: () => void;
  /** The pins follow the threads; re-read them onto the canvas. */
  refreshPins: () => void;
}

/**
 * The comment threads of one open diagram: the Comments panel, the floating
 * thread card and composer, and the pins they put on the canvas. A thread is
 * attached to a node or an edge, never to a coordinate; threads are
 * annotations beside the diagram, not diagram content.
 */
export class DiagramThreads {
  commentsOpen = $state(false);
  // The node the panel composer is anchored to; null = whole-diagram comment.
  commentDraftNodeId = $state<string | null>(null);
  commentsAutoFocus = $state(false);
  // At most one card is open at a time; the composer becomes the card.
  openThreadId = $state<string | null>(null);
  editingThreadId = $state<string | null>(null);
  composerAnchor = $state<ThreadAnchor | null>(null);
  // Off by default: resolved work should not add dots to the graph.
  showResolved = $state(false);
  // One clock for every thread surface rather than a timer per card.
  now = $state(Date.now());

  readonly comments = $derived.by((): PlanComment[] => {
    const workId = this.options.workId();
    return workId ? this.options.surface.worksStore.annotationComments(workId) : [];
  });
  /** Every thread surface reads this one map, so none can disagree about attachment. */
  readonly byAnchor = $derived(threadsByAnchor(this.comments));
  readonly counts = $derived.by(() => threadCounts(this.comments, this.options.reader()));
  readonly openThread = $derived(
    this.openThreadId === null ? null : (this.comments.find((c) => c.id === this.openThreadId) ?? null),
  );

  constructor(private readonly options: ThreadOptions) {
    // Load the threads for the open work and keep re-reading them: another
    // person's thread, or an agent's, must land on this canvas too.
    $effect(() => {
      const id = options.workId();
      if (!id) return;
      const refresh = () => {
        if (options.workId() === id) options.refreshPins();
      };
      void options.surface.worksStore.loadAnnotations(id).then(refresh);
      return options.surface.worksStore.watchAnnotations(id, refresh);
    });
    $effect(() => {
      const timer = setInterval(() => (this.now = Date.now()), 30_000);
      return () => clearInterval(timer);
    });
  }

  threadsOn(anchorId: string | null): PlanComment[] {
    return anchorId === null ? [] : (this.byAnchor.get(anchorId) ?? []);
  }

  pinFor(nodeId: string): PinSummary | null {
    return pinSummary(this.byAnchor.get(nodeId) ?? [], this.showResolved, this.options.reader());
  }

  setShowResolved(show: boolean) {
    this.showResolved = show;
    this.options.refreshPins();
  }

  openPanel(nodeId: string | null, autoFocus: boolean) {
    this.options.closeDrawers();
    this.closeFloating();
    this.commentDraftNodeId = nodeId;
    this.commentsAutoFocus = autoFocus;
    this.commentsOpen = true;
  }

  /** The card and the composer are never up together; this clears either. */
  closeFloating() {
    this.openThreadId = null;
    this.editingThreadId = null;
    this.composerAnchor = null;
  }

  openCard(commentId: string) {
    const comment = this.comments.find((c) => c.id === commentId);
    if (!comment) return;
    const anchor = { nodeId: comment.nodeId, edgeId: comment.edgeId };
    this.options.selectAnchor(anchor);
    this.openThreadId = commentId;
    this.editingThreadId = null;
    this.composerAnchor = null;
    const workId = this.options.workId();
    if (workId) {
      void this.options.surface.worksStore.markAnnotationRead(workId, commentId);
      this.options.refreshPins();
    }
    if (comment.nodeId) this.options.revealNode(comment.nodeId);
  }

  revealComment(commentId: string) {
    const nodeId = this.comments.find((c) => c.id === commentId)?.nodeId;
    if (nodeId) this.options.revealNode(nodeId);
  }

  /** The pin opens the thread that still wants something: unread first, else the newest shown. */
  openFirstOn(nodeId: string) {
    const threads = this.threadsOn(nodeId).filter((t) => this.showResolved || !isResolved(t));
    const target = threads.find((t) => isUnread(t, this.options.reader())) ?? threads.at(-1);
    if (target) this.openCard(target.id);
  }

  /** The threads pill scopes the canvas to the first thread somebody else has spoken in. */
  openFirstUnread() {
    const unread = firstUnreadThread(this.comments, this.options.reader());
    if (unread) this.openCard(unread.id);
    else this.openPanel(null, false);
  }

  // Anything anchored begins on the canvas; the panel keeps the diagram-wide list.
  openComposer(anchor: ThreadAnchor) {
    if (!this.options.workId()) return;
    this.commentsOpen = false;
    this.options.selectAnchor(anchor);
    this.openThreadId = null;
    this.editingThreadId = null;
    this.composerAnchor = anchor;
  }

  /** Post the composer's thread; the card takes its place. */
  submitComposer(text: string) {
    const anchor = this.composerAnchor;
    this.composerAnchor = null;
    const workId = this.options.workId();
    if (!anchor || !workId) return;
    const id = uuid();
    void this.options.surface.worksStore.addAnnotationComment(workId, {
      id,
      selectedText: this.options.anchorLabel(anchor) ?? this.options.title(),
      comment: text,
      ...anchor,
    });
    this.options.refreshPins();
    this.openThreadId = id;
  }

  /** A comment from the panel, on the draft anchor or on the whole diagram. */
  addPanelComment(text: string) {
    const workId = this.options.workId();
    if (!workId) return;
    const nodeId = this.commentDraftNodeId;
    const comment: PlanComment = {
      id: uuid(),
      selectedText: nodeId ? (this.options.anchorLabel({ nodeId }) ?? nodeId) : this.options.title(),
      comment: text,
    };
    if (nodeId) comment.nodeId = nodeId;
    void this.options.surface.worksStore.addAnnotationComment(workId, comment);
    this.options.refreshPins();
  }

  editComment(commentId: string, text: string) {
    const workId = this.options.workId();
    if (workId) void this.options.surface.worksStore.editAnnotationComment(workId, commentId, text);
  }

  deleteComment(commentId: string) {
    const workId = this.options.workId();
    if (!workId) return;
    void this.options.surface.worksStore.deleteAnnotationComment(workId, commentId);
    this.options.refreshPins();
  }

  reply(commentId: string, text: string) {
    const workId = this.options.workId();
    if (!workId) return;
    void this.options.surface.worksStore.addAnnotationReply(workId, commentId, {
      id: uuid(),
      text,
      createdAt: Date.now(),
    });
  }

  /** Resolve tints the thread sage, collapses its card and drops its pin. */
  resolve(commentId: string, resolved: boolean) {
    const workId = this.options.workId();
    if (!workId) return;
    void this.options.surface.worksStore.setAnnotationResolved(workId, commentId, resolved);
    this.options.refreshPins();
    if (resolved && this.openThreadId === commentId) this.closeFloating();
  }

  // Hand the comments to an agent as a chat message. The threads resolve
  // rather than vanish, so the round of feedback stays on the diagram.
  async sendToAgent() {
    const workId = this.options.workId();
    const workspace = this.options.surface.workspace;
    if (!workId || this.comments.length === 0 || !workspace) return;
    const body = formatInlineComments($state.snapshot(this.comments));
    const message = `Please address these comments on the diagram "${this.options.title()}" (work_id: ${workId}):\n${body}`;
    if (!(await workspace.sendMessageToNewWorkSession(workId, message))) return;
    await this.options.surface.worksStore.resolveOpenAnnotationComments(workId);
    this.options.refreshPins();
  }
}
