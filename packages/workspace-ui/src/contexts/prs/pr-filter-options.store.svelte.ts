// The label and author choices the code host offers for the pull request
// list's filters, beyond the rows a page has loaded.
//
// The Filters menu's pickers search through this: each search asks every
// repository the list covers (`prFilterOptions`), 250ms after typing stops,
// and merges the answers. A newer search drops an older answer, and a change
// of the projects in view drops the answers of the projects it left.

import type { PrFilterChoice, PrFilterField } from '@solus/contracts/providers'
import { mergeFilterChoices } from '@solus/client-core/pr-filter-choices'
import { detached, type ProjectPrs } from './project-prs.svelte'

const SEARCH_DEBOUNCE_MS = 250
/** Answers kept for repeated searches; dropped together when full. */
const CACHE_LIMIT = 100

export class PrFilterOptionsStore {
  /** The host's answers to the last search of each field. */
  readonly choices = $state<{ [field in PrFilterField]: PrFilterChoice[] }>({ label: [], author: [] })

  private readonly timers = new Map<PrFilterField, ReturnType<typeof setTimeout>>()
  private readonly tokens = { label: 0, author: 0 }
  private readonly cache = new Map<string, Promise<PrFilterChoice[]>>()
  private scopeKey = ''

  constructor(private readonly projects: () => readonly ProjectPrs[]) {}

  /** Search the hosts for `field` choices that match `query`, once typing stops. */
  search(field: PrFilterField, query: string): void {
    const projects = uniqueRepositories(this.projects())
    const scopeKey = projects.map((project) => project.key).join('\n')
    if (scopeKey !== this.scopeKey) {
      this.scopeKey = scopeKey
      this.choices.label = []
      this.choices.author = []
    }
    clearTimeout(this.timers.get(field))
    const token = ++this.tokens[field]
    this.timers.set(field, setTimeout(() => void this.read(field, query.trim(), projects, token), SEARCH_DEBOUNCE_MS))
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private async read(field: PrFilterField, query: string, projects: ProjectPrs[], token: number): Promise<void> {
    // A repository that cannot be read adds nothing; the loaded rows still offer theirs.
    const lists = await Promise.all(projects.map((project) => this.ask(project, field, query).catch(() => [])))
    if (token !== this.tokens[field]) return
    this.choices[field] = mergeFilterChoices(lists)
  }

  private ask(project: ProjectPrs, field: PrFilterField, query: string): Promise<PrFilterChoice[]> {
    const key = `${project.key}\n${field}\n${query}`
    const held = this.cache.get(key)
    if (held) return held
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear()
    const answer = project.hostApi.prFilterOptions(detached(project.hostContext), field, query)
    this.cache.set(key, answer)
    answer.catch(() => this.cache.delete(key))
    return answer
  }
}

/** One project per repository: two checkouts of one repository have the same labels and people. */
function uniqueRepositories(projects: readonly ProjectPrs[]): ProjectPrs[] {
  const seen = new Set<string>()
  return projects.filter((project) => {
    const key = project.repositoryKey ?? project.key
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
