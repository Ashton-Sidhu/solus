/** Test-owned operations, installed only after the suite selected its disposable data directory. */
export async function installTestWorkspaceTools(): Promise<() => void> {
  const [{ getDatabase }, { ShareManager }, { createWorkspaceOperations }, { installWorkspaceToolOperations }] = await Promise.all([
    import('@solus/server/db/database'), import('@solus/server/sharing/share-manager'),
    import('@solus/server/data/workspace/service'), import('@solus/server/data/workspace/tool-context'),
  ])
  return installWorkspaceToolOperations(createWorkspaceOperations(new ShareManager({ db: getDatabase() })), 'test-host')
}
