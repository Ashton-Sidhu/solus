import type { PrFilter, PrListPage, PrProjectListing } from '@solus/contracts/providers'
import type { IpcContext } from '@solus/contracts/types'
import type { PrsStore, ProjectPrs } from '@solus/workspace-ui/contexts/prs/prs.store.svelte'

type PageRead = (ctx: IpcContext, filter?: PrFilter, page?: number) => Promise<PrListPage>

/**
 * Answer the page read the way a host does: each named project's first page,
 * from the `prList` the test already describes, with a failed project reported
 * by itself. So a suite can keep saying what its host lists in one place.
 */
export function listingFrom<Api extends { prList: PageRead }>(api: Api): Api & {
  prListProjects: (ctx: IpcContext, projectRoots: string[], filter?: PrFilter) => Promise<PrProjectListing[]>
} {
  return {
    ...api,
    prListProjects: (ctx, projectRoots, filter) => Promise.all(projectRoots.map(async (projectRoot): Promise<PrProjectListing> => {
      const projectCtx = { ...ctx, session: { ...ctx.session, projectPath: projectRoot, workingDirectory: projectRoot } }
      try {
        return { projectRoot, page: await api.prList(projectCtx, filter, 1) }
      } catch (error) {
        return { projectRoot, error: error instanceof Error ? error.message : String(error) }
      }
    })),
  }
}

/** The page's own first-page read of one project: what opening or refreshing the list does. */
export function readFirstPage(store: PrsStore, project: ProjectPrs, opts: { force?: boolean } = {}): Promise<void> {
  return store.readPage([project], { state: 'open' }, { memoryKey: 'test', ...opts })
}
