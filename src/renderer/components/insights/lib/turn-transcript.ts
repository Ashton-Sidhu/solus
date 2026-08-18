import type { MetricsSpan } from '../../../../shared/observability-types'
import { formatTokens } from './format'
import { providerMark, providerName, type ProviderMarkId } from './provider'

/**
 * The three texts a turn recorded, as one ordered reading.
 *
 * A turn is a conversation: instructions, an ask, an answer. The panel used to
 * print each of them in its own identical card, so the reader had to notice
 * three headings to learn that they were reading one exchange. This model names
 * the roles instead, and the card draws them as one transcript.
 *
 * Order is prompt -> response -> system prompt, which is not chronological on
 * purpose. The ask and the answer are the pair a reader compares, so they stay
 * adjacent; the instructions are the largest text a turn carries and the one
 * opened deliberately, so they sit last, behind a control.
 *
 * The model names the roles and what was stored. How loudly each role is drawn
 * is the card's decision, not this file's.
 *
 * Pure and non-reactive.
 */

export type TranscriptRole = 'prompt' | 'response' | 'system'

/** The mark drawn beside a speaker's name. Null where there is no one to
 *  picture: the instructions are a document, and a turn whose backend was never
 *  captured gets no mark rather than a guessed brand. */
export type TranscriptMark = 'user' | ProviderMarkId

export interface TranscriptPane {
  role: TranscriptRole
  /** Names who spoke, not which attribute was read. */
  label: string
  mark: TranscriptMark
  /** Names the attribute again, where an analyst copying a field wants it. */
  copyTitle: string
  text: string
  /** Right of the label: what this text is made of. Null when unrecorded. */
  meta: string | null
  /** Shown when nothing was stored — a fact about capture, not a failure. */
  emptyNote: string
  /** The capture capped the stored text. */
  truncated: boolean
  /** Full length before the cap, when the capture recorded it. */
  chars: number | null
}

function stringAttr(span: MetricsSpan | null, key: string): string {
  const value = span?.attrs[key]
  return typeof value === 'string' ? value : ''
}

function numberAttr(span: MetricsSpan | null, key: string): number | null {
  const value = span?.attrs[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boolAttr(span: MetricsSpan | null, key: string): boolean {
  return span?.attrs[key] === true
}

export function turnTranscript(root: MetricsSpan | null): TranscriptPane[] {
  // A turn captured before the provider field existed is answered by "Agent":
  // the glossary's own word for whoever ran, and honest where a brand name
  // would be a guess.
  const answeredBy = providerName(root?.provider) ?? 'Agent'
  const inputTokens = numberAttr(root, 'inputTokens')
  const outputTokens = numberAttr(root, 'outputTokens')
  const systemChars = numberAttr(root, 'systemPromptChars')

  return [
    {
      // The speakers, not the attributes they were read from: the card is a
      // conversation, and a caption that says who is talking needs no
      // translation back from "Prompt" and "Response".
      role: 'prompt',
      label: 'User',
      mark: 'user',
      copyTitle: 'Copy the prompt',
      text: stringAttr(root, 'prompt'),
      meta: inputTokens == null ? null : `${formatTokens(inputTokens)} in`,
      emptyNote: 'This turn recorded no prompt text.',
      truncated: boolAttr(root, 'promptTruncated'),
      chars: numberAttr(root, 'promptChars'),
    },
    {
      role: 'response',
      label: answeredBy,
      mark: providerMark(root?.provider),
      copyTitle: 'Copy the response',
      text: stringAttr(root, 'response'),
      meta: outputTokens == null ? null : `${formatTokens(outputTokens)} out`,
      emptyNote:
        'No answer text was recorded for this turn. Turns captured before responses were instrumented have none, and a turn that never reached the provider has none to record.',
      truncated: boolAttr(root, 'responseTruncated'),
      chars: numberAttr(root, 'responseChars'),
    },
    {
      role: 'system',
      label: 'System prompt',
      mark: null,
      copyTitle: 'Copy the system prompt',
      text: stringAttr(root, 'systemPrompt'),
      meta: systemChars == null ? null : `${systemChars.toLocaleString()} characters`,
      emptyNote:
        'No system prompt was recorded for this turn. Turns captured before the instructions were instrumented have none.',
      truncated: boolAttr(root, 'systemPromptTruncated'),
      chars: systemChars,
    },
  ]
}

/** The size of the exchange, for the card's header: the two counts a reader
 *  compares, on one line, so neither role's own row has to carry chrome. Null
 *  when the capture measured neither — a "0 in" is not a measurement. */
export function exchangeMeta(panes: TranscriptPane[]): string | null {
  const counts = panes
    .filter((pane) => pane.role !== 'system')
    .map((pane) => pane.meta)
    .filter((meta): meta is string => meta !== null)
  return counts.length > 0 ? counts.join(' · ') : null
}

/** The whole exchange as one plain text, for the card's copy control. A reader
 *  pasting a turn into a report wants the roles named, not three copies. */
export function transcriptAsText(panes: TranscriptPane[]): string {
  return panes
    .filter((pane) => pane.text)
    .map((pane) => `## ${pane.label}\n\n${pane.text}`)
    .join('\n\n')
}

/** Nothing was captured at all — the card says so once instead of printing
 *  three empty notes. */
export function transcriptIsEmpty(panes: TranscriptPane[]): boolean {
  return panes.every((pane) => !pane.text)
}
