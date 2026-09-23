import { afterEach, describe, expect, test } from 'bun:test'

const managedMode = await import('@solus/server/server/managed-mode')
const { setCloudOwnedOrganization, tasksAreCloudOwned } = await import('@solus/server/outbox/cloud-ownership')

// docs/plans/project-model.md §4: tasks are local first. A person's own machine
// keeps its tasks even when it is linked to an organization; only a cloud
// instance — a managed host — writes them to the workspace service.
describe('tasksAreCloudOwned', () => {
  const originalManaged = process.env.SOLUS_MANAGED

  afterEach(() => {
    setCloudOwnedOrganization(null)
    if (originalManaged === undefined) delete process.env.SOLUS_MANAGED
    else process.env.SOLUS_MANAGED = originalManaged
    managedMode.resetManagedModeForTests()
  })

  function onHost(kind: 'personal' | 'managed', organizationId: string | null) {
    if (kind === 'managed') process.env.SOLUS_MANAGED = '1'
    else delete process.env.SOLUS_MANAGED
    managedMode.resetManagedModeForTests()
    setCloudOwnedOrganization(organizationId)
  }

  test('a linked personal machine keeps its tasks local', () => {
    onHost('personal', 'org_1')
    expect(tasksAreCloudOwned()).toBe(false)
  })

  test('a managed host linked to an organization writes tasks to the cloud', () => {
    onHost('managed', 'org_1')
    expect(tasksAreCloudOwned()).toBe(true)
  })

  test('a managed host with no organization link keeps its tasks local', () => {
    onHost('managed', null)
    expect(tasksAreCloudOwned()).toBe(false)
  })
})
