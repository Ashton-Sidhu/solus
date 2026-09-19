import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import type { InstalledSkill } from '@solus/contracts/skill-types'
import type { RemoteSkill } from '@solus/contracts/types'

/** One inventory per host, shared by mounted Settings pages. */
export class SkillsStore {
  skills = $state<InstalledSkill[]>([])
  loading = $state(false)
  loaded = $state(false)
  error = $state('')
  message = $state('')
  busy = $state<string | null>(null)
  readonly errors = new SvelteMap<string, string>()
  private readonly installedIds = new SvelteMap<string, string>()
  private loadSequence = 0

  async load(api: Pick<HostApi, 'skillsList'>): Promise<void> {
    const sequence = ++this.loadSequence
    this.loading = true
    this.error = ''
    try {
      const result = await api.skillsList()
      if (sequence !== this.loadSequence) return
      if (result.ok) {
        this.installedIds.clear()
        this.skills = result.skills
        this.loaded = true
      } else this.error = result.error
    } catch {
      if (sequence === this.loadSequence) this.error = 'Could not load global skills. Try again.'
    } finally {
      if (sequence === this.loadSequence) this.loading = false
    }
  }

  matching(filter: string): InstalledSkill[] {
    const query = filter.trim().toLowerCase()
    return this.skills.filter((skill) => `${skill.name} ${skill.agents.join(' ')} ${skill.source ?? ''}`.toLowerCase().includes(query))
  }

  isInstalled(skill: RemoteSkill): boolean {
    return this.installedIds.has(skill.id) || this.skills.some((installed) => installed.name === skill.name && installed.source === skill.repo)
  }

  async install(api: Pick<HostApi, 'skillsInstall' | 'skillsList'>, skill: RemoteSkill, canManage: boolean): Promise<boolean> {
    if (this.busy) return false
    this.busy = skill.id
    this.errors.delete(skill.id)
    this.message = ''
    try {
      const result = await api.skillsInstall(skill.id)
      if (!result.ok) {
        this.errors.set(skill.id, result.error || 'Could not install the skill.')
        return false
      }
      this.installedIds.set(skill.id, skill.name)
      this.message = `${skill.name} installed globally.`
      if (canManage) await this.load(api)
      return true
    } catch {
      this.errors.set(skill.id, 'Could not install the skill. Try again.')
      return false
    } finally {
      this.busy = null
    }
  }

  async remove(api: Pick<HostApi, 'skillsRemove' | 'skillsList'>, name: string): Promise<boolean> {
    if (this.busy) return false
    this.busy = name
    this.errors.delete(name)
    this.message = ''
    try {
      const result = await api.skillsRemove(name)
      if (!result.ok) {
        this.errors.set(name, result.error)
        await this.load(api)
        return false
      }
      for (const [id, installedName] of this.installedIds) {
        if (installedName === name) this.installedIds.delete(id)
      }
      this.message = `${name} removed globally.`
      await this.load(api)
      return true
    } catch {
      this.errors.set(name, 'Could not remove the skill. Try again.')
      return false
    } finally {
      this.busy = null
    }
  }
}

// Stable host lookup cache; only the state inside each store is reactive.
const stores = new Map<string, SkillsStore>()
export function skillsForHost(serverId: string): SkillsStore {
  let store = stores.get(serverId)
  if (!store) {
    store = new SkillsStore()
    stores.set(serverId, store)
  }
  return store
}

/** A settings card scrolls with the page, so a long list is paged rather than
 *  virtualized: mount one page, grow by one page on request. Build a fresh
 *  window whenever the underlying list changes so paging restarts at the top. */
export class ListWindow {
  static readonly PAGE = 25
  shown = $state(ListWindow.PAGE)

  slice<T>(items: T[]): T[] {
    return items.length > this.shown ? items.slice(0, this.shown) : items
  }

  remaining(total: number): number {
    return Math.max(0, total - this.shown)
  }

  showMore(): void {
    this.shown += ListWindow.PAGE
  }
}

/** Search state is local to one page; invalidate as soon as the query changes. */
export class SkillSearch {
  results = $state<RemoteSkill[]>([])
  searching = $state(false)
  hasSearched = $state(false)
  error = $state('')
  private sequence = 0

  cancel(): void {
    this.sequence++
    this.results = []
    this.hasSearched = false
    this.error = ''
    this.searching = false
  }

  async search(api: Pick<HostApi, 'skillsSearch'>, query: string): Promise<void> {
    const sequence = ++this.sequence
    this.error = ''
    this.results = []
    this.hasSearched = false
    if (!query.trim()) return
    this.searching = true
    try {
      const results = await api.skillsSearch(query.trim())
      if (sequence !== this.sequence) return
      this.results = results
      this.hasSearched = true
    } catch {
      if (sequence === this.sequence) this.error = 'Could not search skills.sh. Try again.'
    } finally {
      if (sequence === this.sequence) this.searching = false
    }
  }
}
