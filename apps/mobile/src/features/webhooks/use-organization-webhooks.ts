import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { WebhookAdminOutcome } from '@solus/contracts/webhook-admin'
import type { DirectoryWorkspace } from '@solus/contracts/uplink'
import { solusApiId } from '@solus/contracts/uplink'
import { useApp, useListened } from '../../app/app-context'
import { adminActionErrorText, organizationWebhooksState, type AdminWebhookRow, type OrganizationWebhooksState } from './webhook-admin'

const NO_WORKSPACES: readonly DirectoryWorkspace[] = []

/**
 * The Organization view of the Webhooks screen (docs/plans/webhooks.md §2.7):
 * the organization webhooks of all members, read from the organization's Solus
 * API for the organization this phone works in. Read on focus, when the
 * organization changes, and when the Solus API connects. Pause and Resume read
 * the list again; a refusal or an error stays on its row. A call that throws is
 * a failed read, never an empty list.
 */
export function useOrganizationWebhooks() {
  const app = useApp()
  const workspaces = useListened(app.account.changes, () =>
    app.account.directory.kind === 'loaded' ? app.account.directory.workspaces : NO_WORKSPACES)
  const activeOrganizationId = useListened(app.account.changes, () => app.account.organizationId)
  const organizationId = workspaces.some((workspace) => workspace.organizationId === activeOrganizationId) ? activeOrganizationId : null
  const isReady = useListened(app.connections.changes, () =>
    organizationId !== null && app.connections.state(solusApiId(organizationId))?.readiness === 'ready')
  const [state, setState] = useState<OrganizationWebhooksState>({ kind: 'loading' })
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(new Map())
  /** Bumped by every read; an older answer does not land. */
  const request = useRef(0)
  /** The organization whose list shows now: a list of another one never shows while a read runs. */
  const shownFor = useRef<string | null>(null)

  const reload = useCallback(() => {
    if (!organizationId) return
    const read = ++request.current
    if (shownFor.current !== organizationId) {
      shownFor.current = organizationId
      setRowErrors(new Map())
      setState({ kind: 'loading' })
    } else {
      setState((previous) => (previous.kind === 'loaded' ? previous : { kind: 'loading' }))
    }
    const connection = app.connections.solusApi(organizationId)
    if (!connection) {
      setState({ kind: 'failed' })
      return
    }
    connection.api.webhookAdminList(organizationId).then(
      (outcome) => { if (read === request.current) setState(organizationWebhooksState(outcome)) },
      () => { if (read === request.current) setState({ kind: 'failed' }) },
    )
  }, [app, organizationId])

  useFocusEffect(reload)

  useEffect(() => {
    if (isReady) reload()
  }, [isReady, reload])

  const act = async (row: AdminWebhookRow): Promise<void> => {
    const connection = app.connections.solusApi(row.ref.organizationId)
    setBusyKey(row.key)
    setRowErrors((errors) => withoutKey(errors, row.key))
    let outcome: WebhookAdminOutcome<null> | null = null
    try {
      if (connection) {
        outcome = row.control === 'pause'
          ? await connection.api.webhookAdminPause(row.ref)
          : await connection.api.webhookAdminResume(row.ref)
      }
    } catch {
      outcome = null
    }
    setBusyKey(null)
    if (outcome?.ok) {
      reload()
      return
    }
    setRowErrors((errors) => new Map(errors).set(row.key, adminActionErrorText(row.control, outcome)))
  }

  const select = (nextOrganizationId: string) => app.account.selectOrganization(nextOrganizationId)

  return { workspaces, organizationId, state, busyKey, rowErrors, reload, act, select }
}

function withoutKey(errors: ReadonlyMap<string, string>, key: string): ReadonlyMap<string, string> {
  if (!errors.has(key)) return errors
  const next = new Map(errors)
  next.delete(key)
  return next
}

/** True when the person works in at least one organization: the Webhooks screen then offers the Organization view. */
export function useHasOrganization(): boolean {
  const app = useApp()
  return useListened(app.account.changes, () =>
    app.account.directory.kind === 'loaded' && app.account.directory.workspaces.length > 0)
}
