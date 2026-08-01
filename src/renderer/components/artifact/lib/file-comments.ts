export interface FileCommentRange {
  startLine: number
  endLine: number
}

export function selectedTextForFileRange(
  contents: string,
  range: FileCommentRange,
): string {
  const lines = contents.split('\n')
  const startIndex = Math.max(0, range.startLine - 1)
  const endIndex = Math.min(lines.length, Math.max(range.startLine, range.endLine))
  return lines.slice(startIndex, endIndex).join('\n')
}

export function rangeFromRemappedAnchor(
  lineNumber: number,
  lineSpan: number,
): FileCommentRange {
  const endLine = Math.max(1, lineNumber)
  return {
    startLine: Math.max(1, endLine - Math.max(0, lineSpan)),
    endLine,
  }
}

export function fileContentVersion(contents: string): number {
  let hash = contents.length
  const step = Math.max(1, Math.floor(contents.length / 128))
  for (let index = 0; index < contents.length; index += step) {
    hash = (hash * 31 + contents.charCodeAt(index)) >>> 0
  }
  return hash
}

const EDITOR_INPUT_EVENTS = [
  'pointerdown',
  'keydown',
  'beforeinput',
  'copy',
  'cut',
  'paste',
  'drop',
  'compositionstart',
  'compositionend',
]

export function isolateFileCommentEvents(element: HTMLElement): () => void {
  const stopPropagation = (event: Event) => event.stopPropagation()
  for (const eventName of EDITOR_INPUT_EVENTS) {
    element.addEventListener(eventName, stopPropagation)
  }
  return () => {
    for (const eventName of EDITOR_INPUT_EVENTS) {
      element.removeEventListener(eventName, stopPropagation)
    }
  }
}
