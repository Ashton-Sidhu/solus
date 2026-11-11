import { answerAppCall, type AppCallArguments, type AppCallValue } from '@solus/client-core/app-calls'
import type { HostApi } from '@solus/client-core/host-api'
import { appHostAccessNotice, hasAppManifest } from '@solus/contracts/apps'
import { appsStore } from './apps.store.svelte'

/** What an artifact render knows of itself, read live: the work it was saved as, its page, and the host that holds the work. */
export interface AppFrameSource {
  workId(): string | undefined
  contentVersion(): number | undefined
  html(): string | undefined
  api(): HostApi | null
}

interface Confirmation {
  title: string
  detail: string
  resolve(allowed: boolean): void
}

/**
 * One artifact render as an app (docs/plans/apps.md §4): whether its page is
 * one, what the host says of it, what answers the page's calls, and the one
 * approval a call may wait on. A render whose page has no app manifest is not
 * an app, and nothing here loads for it.
 */
export class AppFrame {
  /** The approval a call waits on. One at a time: a second request while one waits is refused. */
  confirmation = $state<Confirmation | null>(null)

  constructor(private readonly source: AppFrameSource) {}

  /** The saved work, when the page is an app and its host is connected. */
  readonly workId = $derived.by(() => {
    const html = this.source.html()
    return html !== undefined && hasAppManifest(html) ? this.source.workId() : undefined
  })

  readonly state = $derived.by(() => {
    const read = this.workId ? appsStore.read(this.workId) : null
    return read?.phase === 'ready' ? read.state : null
  })

  /** What the header says of the app's host access; null when it asks for nothing. */
  readonly notice = $derived(this.state ? appHostAccessNotice(this.state.hostAccess) : null)

  /** The integrations the app names that the viewer has not connected. */
  readonly missingRoles = $derived(this.state?.roles.filter((role) => !role.connected) ?? [])

  /** What the frame is given: the hosts in force, and what answers a call. Undefined when the page is not a saved app. */
  readonly frame = $derived.by(() => {
    const api = this.source.api()
    const workId = this.workId
    if (!api || !workId) return undefined
    return {
      network: this.state?.network ?? [],
      call: (name: string, args: AppCallArguments): Promise<AppCallValue> =>
        answerAppCall({
          toolInfo: (tool) => api.appToolInfo({ workId, name: tool }),
          callTool: (tool, argumentsJson, approved) => api.appCallTool({ workId, name: tool, argumentsJson, approved }),
          confirm: (title, detail) => this.confirm(title, detail),
        }, name, args),
    }
  })

  /** Reads what the host says of the app. Called from an effect: it reads again for a newer page. */
  load(): void {
    const api = this.source.api()
    if (api && this.workId) void appsStore.load(api, this.workId, this.source.contentVersion())
  }

  decideHostAccess(allow: boolean): void {
    const api = this.source.api()
    if (api && this.workId) void appsStore.decideHostAccess(api, this.workId, allow)
  }

  settle(allowed: boolean): void {
    const pending = this.confirmation
    this.confirmation = null
    pending?.resolve(allowed)
  }

  private confirm(title: string, detail: string): Promise<boolean> {
    if (this.confirmation) return Promise.resolve(false)
    return new Promise((resolve) => {
      this.confirmation = { title, detail, resolve }
    })
  }
}
