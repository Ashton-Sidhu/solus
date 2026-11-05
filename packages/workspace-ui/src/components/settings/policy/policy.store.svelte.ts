import { SvelteMap } from 'svelte/reactivity'
import type { PolicyKind } from '@solus/contracts/policy'
import type { PolicyApiResult } from '@solus/contracts/host-api'
import type { HostPoliciesResponse, OrganizationPolicyResponse } from '@solus/contracts/policy-api'
import type { PolicyCloudRequests } from '@solus/client-core/settings-requests'
import { accountSettingsRequests } from '../../../contexts/account/account-sync.store.svelte'
import { checkPolicyText, newPolicyDocument, policyResultMessage, policyText, readPolicy, type ReadPolicy } from './lib/policy-editor'

/**
 * One organization's policies as this account reads them (plans/030 §5.2, §7).
 * `forbidden`: not a member, or the organization is gone. Members read; only
 * `canManage` — computed by Solus Cloud — makes the editors writable.
 */
export type OrganizationPoliciesView =
  | { status: 'loading' }
  | { status: 'forbidden' }
  | { status: 'signed-out' }
  | { status: 'offline' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      organization: OrganizationPolicyResponse
      /** Null while it loads, or when its read failed (`hostPoliciesError`). */
      hostPolicies: HostPoliciesResponse | null
      hostPoliciesError: string | null
      /** An assignment in flight or refused, by host. */
      assigning: string | null
      assignmentError: string | null
    }

type ReadyView = Extract<OrganizationPoliciesView, { status: 'ready' }>

/** The organization policy, or one host policy by id. */
export type PolicyEditorTarget = { kind: 'organization' } | { kind: 'host'; policyId: string }

/**
 * An owner's unsaved edit of one document, kept apart from what was read, saved
 * against the revision that was read, and never queued offline. A conflict
 * keeps the text beside what the other owner saved until the owner chooses.
 */
export interface PolicyDraft {
  /** What was read. */
  saved: ReadPolicy
  text: string
  saving: boolean
  error: string | null
  /** What the other owner saved. */
  conflict: ReadPolicy | null
}

/** A document anyone can build and export as an MDM policy, without an organization. */
export interface PolicyBuilder {
  kind: PolicyKind
  text: string
}

/**
 * The policies of each organization by account origin. Final authority is Solus
 * Cloud for writes and, for work, the host.
 */
export class PolicyStore {
  readonly views = new SvelteMap<string, OrganizationPoliciesView>()
  readonly drafts = new SvelteMap<string, PolicyDraft>()
  /** The organization Settings shows. Chosen here only: it changes no window's or session's organization. */
  selectedOrganizationId = $state<string | null>(null)
  builder = $state<PolicyBuilder>({ kind: 'mdm', text: policyText(newPolicyDocument('mdm', 'My organization')) })
  private readonly loads = new Map<string, symbol>()

  constructor(private readonly requests: () => PolicyCloudRequests | null = accountSettingsRequests) {}

  viewFor(origin: string, organizationId: string): OrganizationPoliciesView | undefined {
    return this.views.get(viewKey(origin, organizationId))
  }

  draftFor(origin: string, organizationId: string, target: PolicyEditorTarget): PolicyDraft | undefined {
    return this.drafts.get(draftKey(origin, organizationId, target))
  }

  async load(origin: string, organizationId: string): Promise<void> {
    const key = viewKey(origin, organizationId)
    const requests = this.requests()
    if (!requests) {
      this.views.set(key, { status: 'signed-out' })
      return
    }
    const load = Symbol()
    this.loads.set(key, load)
    if (this.views.get(key)?.status !== 'ready') this.views.set(key, { status: 'loading' })
    const [organization, hostPolicies] = await Promise.all([requests.organizationPolicyGet(organizationId), requests.hostPoliciesGet(organizationId)])
    if (this.loads.get(key) !== load) return
    if (organization.kind !== 'ok') {
      const previous = this.views.get(key)
      // Offline or a failed read keeps what is on screen; a lost membership does not.
      if (previous?.status === 'ready' && (organization.kind === 'offline' || organization.kind === 'error')) return
      this.views.set(key, failedView(organization))
      return
    }
    const previous = this.views.get(key)
    // A proxy, so an assignment in flight changes one field, not the view.
    const ready = $state<ReadyView>({
      status: 'ready',
      organization: organization.value,
      hostPolicies: hostPolicies.kind === 'ok' ? hostPolicies.value : previous?.status === 'ready' ? previous.hostPolicies : null,
      hostPoliciesError: hostPolicies.kind === 'ok' ? null : policyResultMessage(hostPolicies),
      assigning: null,
      assignmentError: null,
    })
    this.views.set(key, ready)
    this.reconcileDraft(origin, organizationId, { kind: 'organization' }, readPolicy(organization.value, 'organization'))
    if (hostPolicies.kind === 'ok') {
      for (const policy of hostPolicies.value.policies) {
        this.reconcileDraft(origin, organizationId, { kind: 'host', policyId: policy.policyId }, readPolicy(policy, 'host'))
      }
    }
  }

  /** Changes the owner's draft. A member, a save in flight, or an open conflict changes nothing. */
  edit(origin: string, organizationId: string, target: PolicyEditorTarget, text: string): void {
    const draft = this.draftFor(origin, organizationId, target)
    if (!draft || draft.saving || draft.conflict || !this.ready(origin, organizationId)?.organization.canManage) return
    draft.text = text
    draft.error = null
  }

  /** Cancel: the text returns to what was last read. */
  cancel(origin: string, organizationId: string, target: PolicyEditorTarget): void {
    const draft = this.draftFor(origin, organizationId, target)
    if (!draft || draft.saving) return
    draft.text = draft.saved.text
    draft.error = null
    draft.conflict = null
  }

  /**
   * After a conflict: `use-theirs` drops the edit for what the other owner saved;
   * `keep-mine` keeps the edit over their revision, to be saved again on purpose.
   */
  resolveConflict(origin: string, organizationId: string, target: PolicyEditorTarget, choice: 'use-theirs' | 'keep-mine'): void {
    const draft = this.draftFor(origin, organizationId, target)
    if (!draft?.conflict) return
    const theirs = draft.conflict
    draft.saved = theirs
    if (choice === 'use-theirs') draft.text = theirs.text
    draft.conflict = null
    draft.error = null
  }

  /** Saves the draft against the revision read. The document is checked here first, so a bad one never leaves the client. */
  async save(origin: string, organizationId: string, target: PolicyEditorTarget): Promise<void> {
    const draft = this.draftFor(origin, organizationId, target)
    const requests = this.requests()
    if (!draft || !requests || draft.saving || draft.conflict || !this.ready(origin, organizationId)?.organization.canManage) return
    const checked = checkPolicyText(draft.text, target.kind)
    if (!checked.ok) {
      draft.error = checked.issues.join('\n')
      return
    }
    draft.saving = true
    draft.error = null
    const request = { expectedRevision: draft.saved.revision, document: checked.document }
    const result: PolicyApiResult<Pick<OrganizationPolicyResponse, 'revision' | 'document'>> = target.kind === 'organization'
      ? await requests.organizationPolicyPut(organizationId, request)
      : await requests.hostPolicyPut(organizationId, target.policyId, request)
    draft.saving = false
    if (result.kind === 'ok') {
      draft.saved = readPolicy(result.value, target.kind)
      draft.text = draft.saved.text
      void this.load(origin, organizationId)
      return
    }
    if (result.kind === 'conflict') {
      draft.conflict = readPolicy(result, target.kind)
      return
    }
    if (result.kind === 'forbidden') {
      // Permission lost while editing: the drafts go, and the page says so.
      this.views.set(viewKey(origin, organizationId), { status: 'forbidden' })
      return
    }
    draft.error = policyResultMessage(result)
  }

  /** A new host policy from a document: its id, or the reason it was refused. */
  async createHostPolicy(origin: string, organizationId: string, name: string, text: string): Promise<{ policyId: string } | { error: string }> {
    const requests = this.requests()
    if (!requests) return { error: 'Sign in to Solus again to change policies.' }
    const checked = checkPolicyText(text, 'host')
    if (!checked.ok) return { error: checked.issues.join('\n') }
    const result = await requests.hostPolicyCreate(organizationId, { name: name.trim(), document: { ...checked.document, name: name.trim() } })
    if (result.kind !== 'ok') return { error: policyResultMessage(result) ?? 'Solus Cloud did not create the policy.' }
    await this.load(origin, organizationId)
    return { policyId: result.value.policyId }
  }

  async deleteHostPolicy(origin: string, organizationId: string, policyId: string): Promise<string | null> {
    const requests = this.requests()
    if (!requests) return 'Sign in to Solus again to change policies.'
    const result = await requests.hostPolicyDelete(organizationId, policyId)
    if (result.kind !== 'ok') return policyResultMessage(result)
    this.drafts.delete(draftKey(origin, organizationId, { kind: 'host', policyId }))
    await this.load(origin, organizationId)
    return null
  }

  /** Assigns `policyId` to a host, or removes this organization's assignment with null. */
  async assign(origin: string, organizationId: string, hostId: string, policyId: string | null): Promise<void> {
    const requests = this.requests()
    const view = this.ready(origin, organizationId)
    if (!requests || !view || view.assigning || !view.organization.canManage) return
    view.assigning = hostId
    view.assignmentError = null
    const result = policyId
      ? await requests.hostPolicyAssign(organizationId, hostId, { policyId })
      : await requests.hostPolicyUnassign(organizationId, hostId)
    const current = this.ready(origin, organizationId)
    if (!current) return
    current.assigning = null
    if (result.kind !== 'ok') {
      current.assignmentError = policyResultMessage(result)
      return
    }
    const hosts = current.hostPolicies?.hosts
    const index = hosts?.findIndex((host) => host.hostId === hostId) ?? -1
    if (hosts && index >= 0) hosts[index] = result.value
    // Each policy's host list changed too.
    void this.load(origin, organizationId)
  }

  setBuilder(builder: Partial<PolicyBuilder>): void {
    if (builder.kind !== undefined) this.builder.kind = builder.kind
    if (builder.text !== undefined) this.builder.text = builder.text
  }

  private ready(origin: string, organizationId: string): ReadyView | null {
    const view = this.views.get(viewKey(origin, organizationId))
    return view?.status === 'ready' ? view : null
  }

  /** A fresh read replaces what was read; an edit in progress stays, and a revision change under it is a conflict. */
  private reconcileDraft(origin: string, organizationId: string, target: PolicyEditorTarget, read: ReadPolicy): void {
    const key = draftKey(origin, organizationId, target)
    const draft = this.drafts.get(key)
    if (!draft) {
      // A proxy, so each keystroke changes one field.
      const created = $state<PolicyDraft>({ saved: read, text: read.text, saving: false, error: null, conflict: null })
      this.drafts.set(key, created)
      return
    }
    if (draft.saving || draft.saved.revision === read.revision) return
    if (draft.text !== draft.saved.text) {
      draft.conflict = read
      return
    }
    draft.saved = read
    draft.text = read.text
  }
}

function viewKey(origin: string, organizationId: string): string {
  return `${origin}|${organizationId}`
}

function draftKey(origin: string, organizationId: string, target: PolicyEditorTarget): string {
  return `${viewKey(origin, organizationId)}|${target.kind === 'organization' ? 'organization' : `host:${target.policyId}`}`
}

function failedView(result: Exclude<PolicyApiResult<unknown>, { kind: 'ok' }>): OrganizationPoliciesView {
  switch (result.kind) {
    case 'forbidden': return { status: 'forbidden' }
    case 'signed-out': return { status: 'signed-out' }
    case 'offline': return { status: 'offline' }
    default: return { status: 'error', message: policyResultMessage(result) ?? 'Solus could not read these policies.' }
  }
}

export const policyStore = new PolicyStore()
