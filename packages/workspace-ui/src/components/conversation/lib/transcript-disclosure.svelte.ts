import { getContext, setContext } from 'svelte'

interface Disclosure {
  expanded: boolean
  selectedToolId: string | null
  openedByUser: boolean | null
  showAllRows: boolean
  pickedId: string | null
  draft: string
}

const contextKey = Symbol('transcript-disclosure')

/** UI choices belong to the conversation, not to a virtual row's lifetime. */
export class TranscriptDisclosure {
  private entries = new Map<string, Disclosure>()

  forKey(key: string): Disclosure {
    let value = this.entries.get(key)
    if (!value) {
      const created: Disclosure = $state({ expanded: false, selectedToolId: null, openedByUser: null, showAllRows: false, pickedId: null, draft: '' })
      value = created
      this.entries.set(key, value)
    }
    return value
  }
}

export function provideTranscriptDisclosure(): void {
  setContext(contextKey, new TranscriptDisclosure())
}

export function getTranscriptDisclosure(): TranscriptDisclosure {
  return getContext<TranscriptDisclosure | undefined>(contextKey) ?? new TranscriptDisclosure()
}
