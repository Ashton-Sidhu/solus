import type { Message } from '@solus/contracts/types'
import { untrack } from 'svelte'
import {
  buildTurns,
  groupMessages,
  opensSegment,
  reuseGroupedItems,
  runContinuesBefore,
  type GroupedItem,
  type Turn,
} from './turns'
import { messageTurnIds } from './transcript-navigation'
import { artifactRevisions, reuseArtifactRevisions, type ArtifactRevision } from './artifact-revisions'

/**
 * One run of messages from a prompt or divider up to the next. Its grouping
 * and its turns are its own deriveds, so a change inside one segment — a
 * streamed token, a tool result — recomputes that segment and nothing else.
 */
class TranscriptSegment {
  readonly grouped: GroupedItem[] = $derived.by(() => {
    const next = reuseGroupedItems(groupMessages(this.messages), this.previousGrouped)
    this.previousGrouped = next
    return next
  })

  /** A boolean of its own: a change in which segments are live re-asks every
   *  segment, but rebuilds only those whose answer changed. */
  private readonly live: boolean = $derived.by(() => this.isLive(this))

  readonly turns: Turn[] = $derived.by(() => buildTurns(this.grouped, { running: this.live }))

  private previousArtifacts: ArtifactRevision[] = []
  /** The artifact revisions this segment holds: a streamed token rescans this
   *  segment only, and hands back the same list when no revision changed. */
  readonly artifacts: ArtifactRevision[] = $derived.by(() => {
    this.previousArtifacts = reuseArtifactRevisions(artifactRevisions(this.messages), this.previousArtifacts)
    return this.previousArtifacts
  })

  /** Which of this segment's turns holds each of its messages. */
  readonly turnIdByMessage: Map<string, string> = $derived(messageTurnIds(this.turns))

  /** `previousGrouped` seeds item identity from the segment this one grew
   *  from, so a row the new message did not touch keeps its object. */
  constructor(
    readonly messages: Message[],
    private readonly isLive: (segment: TranscriptSegment) => boolean,
    public previousGrouped: GroupedItem[] = [],
  ) {}
}

function sameMessages(a: readonly Message[], b: readonly Message[], start: number, end: number): boolean {
  if (a.length !== end - start) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[start + i]) return false
  return true
}

/** Whether a message starts a segment never changes after it is made: every
 *  field `opensSegment` reads is set when the message is created, and a later
 *  write (a question's answer on its tool row, a work on its artifact row)
 *  lands on a row that could not start one. So the answer is cached per
 *  message and read untracked, and the cut depends only on which messages
 *  the transcript holds, in which order. */
const segmentStarts = new WeakMap<Message, boolean>()
function startsSegment(message: Message): boolean {
  let starts = segmentStarts.get(message)
  if (starts === undefined) {
    starts = untrack(() => opensSegment(message))
    segmentStarts.set(message, starts)
  }
  return starts
}

/**
 * The turns of one transcript, built segment by segment (`opensSegment`).
 *
 * The cut reads which messages the transcript holds, never their text, so
 * streaming does not re-cut. A segment whose messages are unchanged keeps
 * its object and therefore its deriveds; only the segment that grew is built
 * again. The whole-transcript rebuild this replaces ran on every streamed
 * chunk, for every mounted tab.
 */
export class TranscriptTurns {
  private previousSegments: TranscriptSegment[] = []
  private previousRows: Message[] = []

  /**
   * A plain copy of the transcript's rows. Tracked: the length and the two
   * ends. Every structural change to a transcript moves one of them — an
   * append, a prepended page, a released page, a removed row, or a wholesale
   * replacement (which brings new objects, starting with the first). No code
   * swaps a middle row for another object in place. So an append or a
   * prepend reads only the new rows through the proxy; the rest are the
   * previous copy. Any other change copies every row.
   */
  private rows(source: Message[]): Message[] {
    const length = source.length
    const first = source[0]
    const last = source[length - 1]
    const rows = untrack(() => {
      const previous = this.previousRows
      const added = length - previous.length
      if (added >= 0 && previous.length > 0) {
        if (first === previous[0] && source[previous.length - 1] === previous[previous.length - 1]) {
          const next = previous.slice()
          for (let i = previous.length; i < length; i++) next.push(source[i])
          return next
        }
        if (last === previous[previous.length - 1] && source[added] === previous[0]) {
          const head: Message[] = []
          for (let i = 0; i < added; i++) head.push(source[i])
          return head.concat(previous)
        }
      }
      return source.slice()
    })
    this.previousRows = rows
    return rows
  }

  readonly segments: TranscriptSegment[] = $derived.by(() => {
    const messages = this.rows(this.messages())
    const previousByFirst = new Map<Message, TranscriptSegment>()
    for (const segment of this.previousSegments) previousByFirst.set(segment.messages[0], segment)
    const segments: TranscriptSegment[] = []
    let start = 0
    const close = (end: number) => {
      if (end <= start) return
      const prior = previousByFirst.get(messages[start])
      segments.push(prior && sameMessages(prior.messages, messages, start, end)
        ? prior
        : new TranscriptSegment(messages.slice(start, end), this.isLive, prior?.previousGrouped))
      start = end
    }
    for (let i = 1; i < messages.length; i++) if (startsSegment(messages[i])) close(i)
    close(messages.length)
    const previous = this.previousSegments
    if (segments.length === previous.length && segments.every((segment, index) => segment === previous[index])) return previous
    this.previousSegments = segments
    return segments
  })

  /** The segments a running run still reaches: the last one, and before it
   *  every segment a steered prompt continued. Reads groupings, never turns. */
  private previousLive = new Set<TranscriptSegment>()
  private readonly liveSegments: Set<TranscriptSegment> = $derived.by(() => {
    const live = new Set<TranscriptSegment>()
    if (this.running()) {
      for (let i = this.segments.length - 1; i >= 0; i--) {
        const segment = this.segments[i]
        live.add(segment)
        if (!runContinuesBefore(segment.grouped)) break
      }
    }
    // Every segment asks this set whether it is live. An equal set stays the
    // same object, so a new message does not re-ask every segment.
    const previous = this.previousLive
    if (live.size === previous.size && [...live].every((segment) => previous.has(segment))) return previous
    this.previousLive = live
    return live
  })

  readonly turns: Turn[] = $derived(this.segments.flatMap((segment) => segment.turns))

  private segmentByMessage = new Map<string, TranscriptSegment>()
  private indexedSegments = new Set<TranscriptSegment>()
  /**
   * The turn that holds a message, for Find and the message navigator. The
   * message → segment index is kept up to date by the segments that changed,
   * not rebuilt; each segment answers for its own turns.
   */
  readonly messageTurns: { get(messageId: string): string | undefined } = $derived.by(() => {
    const segments = this.segments
    untrack(() => {
      const current = new Set(segments)
      for (const segment of this.indexedSegments) {
        if (current.has(segment)) continue
        for (const message of segment.messages) {
          if (this.segmentByMessage.get(message.id) === segment) this.segmentByMessage.delete(message.id)
        }
        this.indexedSegments.delete(segment)
      }
      for (const segment of segments) {
        if (this.indexedSegments.has(segment)) continue
        for (const message of segment.messages) this.segmentByMessage.set(message.id, segment)
        this.indexedSegments.add(segment)
      }
    })
    return { get: (messageId) => this.segmentByMessage.get(messageId)?.turnIdByMessage.get(messageId) }
  })

  constructor(
    private readonly messages: () => Message[],
    private readonly running: () => boolean,
  ) {}

  private isLive = (segment: TranscriptSegment): boolean => this.liveSegments.has(segment)
}
