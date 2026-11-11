import { addVoiceTerms, filterVoiceDictionary, replaceVoiceTerm, type VoiceDictionary } from '@solus/contracts/voice-dictionary'

export class VoiceDictionaryEditor {
  query = $state('')
  /** `term` names the row the error belongs to; null is the add field. */
  error = $state<{ term: string | null; message: string } | null>(null)

  constructor(private read: () => VoiceDictionary, private write: (entries: VoiceDictionary) => boolean) {}

  get entries(): VoiceDictionary { return this.read() }
  get visible(): VoiceDictionary { return filterVoiceDictionary(this.read(), this.query) }

  clearError(): void { this.error = null }

  add(text: string): boolean {
    const added = this.commit(null, () => addVoiceTerms(this.read(), text))
    if (added) this.query = ''
    return added
  }

  rename(term: string, nextTerm: string): boolean {
    if (nextTerm.trim() === term) return true
    return this.replace(term, { term: nextTerm, aliases: this.aliasesOf(term) })
  }

  addAlias(term: string, alias: string): boolean {
    return this.replace(term, { term, aliases: [...this.aliasesOf(term), alias] })
  }

  removeAlias(term: string, alias: string): boolean {
    return this.replace(term, { term, aliases: this.aliasesOf(term).filter(item => item !== alias) })
  }

  remove(term: string): boolean {
    return this.commit(term, () => this.read().filter(entry => entry.term !== term))
  }

  private aliasesOf(term: string): string[] {
    return this.read().find(entry => entry.term === term)?.aliases ?? []
  }

  private replace(term: string, replacement: VoiceDictionary[number]): boolean {
    return this.commit(term, () => replaceVoiceTerm(this.read(), term, replacement))
  }

  private commit(term: string | null, change: () => VoiceDictionary): boolean {
    try {
      if (!this.write(change())) throw new Error('Could not save the dictionary')
      this.error = null
      return true
    } catch (error) {
      this.error = { term, message: error instanceof Error ? error.message : 'Invalid dictionary' }
      return false
    }
  }
}
