import { join } from 'path'
import { app, ipcMain, safeStorage, shell } from 'electron'
import { z } from 'zod'
import type { AccountState } from '@solus/contracts/account-types'
import type { SettingsRequestFailure } from '@solus/contracts/host-api'
import { accountAgentProfilePatchRequestSchema } from '@solus/contracts/agent-profile'
import { vaultSaveKeyRequestSchema, vaultConnectRequestSchema, vaultDisconnectRequestSchema } from '@solus/contracts/vault'
import { accountSettingsPatchRequestSchema } from '@solus/contracts/settings'
import { hostPolicyAssignRequestSchema, hostPolicyCreateRequestSchema, policyWriteRequestSchema } from '@solus/contracts/policy-api'
import { desktopAgentProfileRequests } from './agent-profile-client'
import { secureStorage } from '../secure-storage'
import { AccountStore } from './account-store'
import { AccountSession } from './account-session'
import { loopbackAuthorizer } from './loopback-authorizer'
import { desktopSettingsRequests } from './settings-client'
import { issueEnrollmentTicket, listDirectory, loadOrganizationDirectory, removeHost, startManagedHost } from './uplink-client'

export const ACCOUNT_CHANNELS = {
  state: 'solus:account-state',
  signIn: 'solus:account-sign-in',
  cancelSignIn: 'solus:account-cancel-sign-in',
  signOut: 'solus:account-sign-out',
  retryVerify: 'solus:account-retry-verify',
  stateChanged: 'solus:account-state-changed',
  uplinkDirectory: 'solus:uplink-directory',
  accountAccessToken: 'solus:account-access-token',
  uplinkStartManagedHost: 'solus:uplink-start-managed-host',
  uplinkRemoveHost: 'solus:uplink-remove-host',
  uplinkTicket: 'solus:uplink-enrollment-ticket',
  uplinkOrganizationDirectory: 'solus:uplink-organization-directory',
  accountSettingsGet: 'solus:account-settings-get',
  accountSettingsPatch: 'solus:account-settings-patch',
  accountSettingsDelete: 'solus:account-settings-delete',
  accountAgentProfileGet: 'solus:account-agent-profile-get',
  accountAgentProfilePatch: 'solus:account-agent-profile-patch',
  accountAgentProfileDelete: 'solus:account-agent-profile-delete',
  accountVault: 'solus:account-vault',
  accountVaultConnect: 'solus:account-vault-connect',
  accountVaultSaveKey: 'solus:account-vault-save-key',
  accountVaultDisconnect: 'solus:account-vault-disconnect',
  organizationPolicyGet: 'solus:organization-policy-get',
  organizationPolicyPut: 'solus:organization-policy-put',
  hostPoliciesGet: 'solus:host-policies-get',
  hostPolicyCreate: 'solus:host-policy-create',
  hostPolicyPut: 'solus:host-policy-put',
  hostPolicyDelete: 'solus:host-policy-delete',
  hostPolicyAssign: 'solus:host-policy-assign',
  hostPolicyUnassign: 'solus:host-policy-unassign',
} as const

/** A renderer request that fails its schema never reaches the website. */
const INVALID_REQUEST: SettingsRequestFailure = { kind: 'error', code: 'invalid_request', message: null }

const hostIdSchema = z.string().min(1).max(64)
const organizationIdSchema = z.string().min(1).max(128)
const policyIdSchema = z.string().min(1).max(128)
/** What a renderer may get a token for: one host or the Solus API, never the account plane. */
const connectionTokenResourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host'), hostId: hostIdSchema }).strict(),
  z.object({ kind: z.literal('api') }).strict(),
])

/** Production origin; `SOLUS_CLOUD_URL` overrides it for development and staging. */
export const DEFAULT_CLOUD_ORIGIN = 'https://app.solus.sh'

export function resolveCloudOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.SOLUS_CLOUD_URL?.trim()
  if (!candidate) return DEFAULT_CLOUD_ORIGIN
  const url = new URL(candidate)
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !isLoopback) {
    throw new Error('SOLUS_CLOUD_URL must use https unless it points at loopback')
  }
  return url.origin
}

/**
 * Wires the account session into Electron: IPC for the renderer, the keychain for
 * the refresh token, the system browser and a loopback callback for the sign-in. Returns the session so the
 * app can verify on boot and on window focus.
 */
export function registerAccountIpc(broadcast: (channel: string, state: AccountState) => void): AccountSession {
  const session = new AccountSession({
    cloudOrigin: resolveCloudOrigin(),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    store: new AccountStore(join(app.getPath('userData'), 'account.bin'), secureStorage(safeStorage)),
    authorizer: loopbackAuthorizer({ openExternal: (url) => shell.openExternal(url) }),
    onStateChange: (state) => broadcast(ACCOUNT_CHANNELS.stateChanged, state),
  })

  ipcMain.handle(ACCOUNT_CHANNELS.state, () => session.current())
  ipcMain.handle(ACCOUNT_CHANNELS.signIn, () => session.signIn())
  ipcMain.on(ACCOUNT_CHANNELS.cancelSignIn, () => session.cancelSignIn())
  ipcMain.handle(ACCOUNT_CHANNELS.signOut, () => session.signOut())
  ipcMain.handle(ACCOUNT_CHANNELS.retryVerify, () => session.verify('retry'))
  // Personal Uplink on the account's behalf; the renderer gets answers, never the token.
  ipcMain.handle(ACCOUNT_CHANNELS.uplinkDirectory, () => listDirectory(session))
  ipcMain.handle(ACCOUNT_CHANNELS.accountAccessToken, (_event, rawResource, rawOptions) => {
    const resource = connectionTokenResourceSchema.safeParse(rawResource)
    const options = z.object({ refused: z.string().min(1).max(16_384).optional() }).strict().optional().safeParse(rawOptions)
    if (!resource.success || !options.success) return null
    return session.accessToken(resource.data, options.data)
  })
  ipcMain.handle(ACCOUNT_CHANNELS.uplinkStartManagedHost, (_event, rawHostId) => {
    const hostId = hostIdSchema.safeParse(rawHostId)
    return hostId.success ? startManagedHost(session, hostId.data) : null
  })
  ipcMain.handle(ACCOUNT_CHANNELS.uplinkRemoveHost, (_event, rawHostId) => {
    const hostId = hostIdSchema.safeParse(rawHostId)
    return hostId.success ? removeHost(session, hostId.data) : false
  })
  ipcMain.handle(ACCOUNT_CHANNELS.uplinkTicket, () => issueEnrollmentTicket(session))
  ipcMain.handle(ACCOUNT_CHANNELS.uplinkOrganizationDirectory, (_event, rawOrganizationId) => {
    const organizationId = organizationIdSchema.safeParse(rawOrganizationId)
    return organizationId.success ? loadOrganizationDirectory(session, organizationId.data) : null
  })

  // Settings sync and the policy API: typed calls only, decoded here.
  const settings = desktopSettingsRequests(session)
  ipcMain.handle(ACCOUNT_CHANNELS.accountSettingsGet, () => settings.accountSettingsGet())
  ipcMain.handle(ACCOUNT_CHANNELS.accountSettingsPatch, (_event, rawRequest) => {
    const request = accountSettingsPatchRequestSchema.safeParse(rawRequest)
    return request.success ? settings.accountSettingsPatch(request.data) : INVALID_REQUEST
  })
  ipcMain.handle(ACCOUNT_CHANNELS.accountSettingsDelete, () => settings.accountSettingsDelete())
  // The agent profile document (plans/020-agent-profile.md §3): the same three narrow calls.
  const agentProfile = desktopAgentProfileRequests(session)
  ipcMain.handle(ACCOUNT_CHANNELS.accountAgentProfileGet, () => agentProfile.accountAgentProfileGet())
  ipcMain.handle(ACCOUNT_CHANNELS.accountAgentProfilePatch, (_event, rawRequest) => {
    const request = accountAgentProfilePatchRequestSchema.safeParse(rawRequest)
    return request.success ? agentProfile.accountAgentProfilePatch(request.data) : INVALID_REQUEST
  })
  ipcMain.handle(ACCOUNT_CHANNELS.accountAgentProfileDelete, () => agentProfile.accountAgentProfileDelete())
  ipcMain.handle(ACCOUNT_CHANNELS.accountVault, () => agentProfile.accountVault())
  ipcMain.handle(ACCOUNT_CHANNELS.accountVaultConnect, (_event, rawRequest) => {
    const request = vaultConnectRequestSchema.safeParse(rawRequest)
    return request.success ? agentProfile.accountVaultConnect(request.data) : INVALID_REQUEST
  })
  ipcMain.handle(ACCOUNT_CHANNELS.accountVaultSaveKey, (_event, rawRequest) => {
    const request = vaultSaveKeyRequestSchema.safeParse(rawRequest)
    return request.success ? agentProfile.accountVaultSaveKey(request.data) : INVALID_REQUEST
  })
  ipcMain.handle(ACCOUNT_CHANNELS.accountVaultDisconnect, (_event, rawRequest) => {
    const request = vaultDisconnectRequestSchema.safeParse(rawRequest)
    return request.success ? agentProfile.accountVaultDisconnect(request.data) : INVALID_REQUEST
  })
  // The policy API (plans/030 §5.2): owners' reads and writes, each id and body decoded here.
  ipcMain.handle(ACCOUNT_CHANNELS.organizationPolicyGet, (_event, rawOrganizationId) => {
    const organizationId = organizationIdSchema.safeParse(rawOrganizationId)
    return organizationId.success ? settings.organizationPolicyGet(organizationId.data) : INVALID_REQUEST
  })
  ipcMain.handle(ACCOUNT_CHANNELS.organizationPolicyPut, (_event, rawOrganizationId, rawRequest) => {
    const organizationId = organizationIdSchema.safeParse(rawOrganizationId)
    const request = policyWriteRequestSchema.safeParse(rawRequest)
    return organizationId.success && request.success ? settings.organizationPolicyPut(organizationId.data, request.data) : INVALID_REQUEST
  })
  ipcMain.handle(ACCOUNT_CHANNELS.hostPoliciesGet, (_event, rawOrganizationId) => {
    const organizationId = organizationIdSchema.safeParse(rawOrganizationId)
    return organizationId.success ? settings.hostPoliciesGet(organizationId.data) : INVALID_REQUEST
  })
  ipcMain.handle(ACCOUNT_CHANNELS.hostPolicyCreate, (_event, rawOrganizationId, rawRequest) => {
    const organizationId = organizationIdSchema.safeParse(rawOrganizationId)
    const request = hostPolicyCreateRequestSchema.safeParse(rawRequest)
    return organizationId.success && request.success ? settings.hostPolicyCreate(organizationId.data, request.data) : INVALID_REQUEST
  })
  ipcMain.handle(ACCOUNT_CHANNELS.hostPolicyPut, (_event, rawOrganizationId, rawPolicyId, rawRequest) => {
    const organizationId = organizationIdSchema.safeParse(rawOrganizationId)
    const policyId = policyIdSchema.safeParse(rawPolicyId)
    const request = policyWriteRequestSchema.safeParse(rawRequest)
    return organizationId.success && policyId.success && request.success
      ? settings.hostPolicyPut(organizationId.data, policyId.data, request.data)
      : INVALID_REQUEST
  })
  ipcMain.handle(ACCOUNT_CHANNELS.hostPolicyDelete, (_event, rawOrganizationId, rawPolicyId) => {
    const organizationId = organizationIdSchema.safeParse(rawOrganizationId)
    const policyId = policyIdSchema.safeParse(rawPolicyId)
    return organizationId.success && policyId.success ? settings.hostPolicyDelete(organizationId.data, policyId.data) : INVALID_REQUEST
  })
  ipcMain.handle(ACCOUNT_CHANNELS.hostPolicyAssign, (_event, rawOrganizationId, rawHostId, rawRequest) => {
    const organizationId = organizationIdSchema.safeParse(rawOrganizationId)
    const hostId = hostIdSchema.safeParse(rawHostId)
    const request = hostPolicyAssignRequestSchema.safeParse(rawRequest)
    return organizationId.success && hostId.success && request.success
      ? settings.hostPolicyAssign(organizationId.data, hostId.data, request.data)
      : INVALID_REQUEST
  })
  ipcMain.handle(ACCOUNT_CHANNELS.hostPolicyUnassign, (_event, rawOrganizationId, rawHostId) => {
    const organizationId = organizationIdSchema.safeParse(rawOrganizationId)
    const hostId = hostIdSchema.safeParse(rawHostId)
    return organizationId.success && hostId.success ? settings.hostPolicyUnassign(organizationId.data, hostId.data) : INVALID_REQUEST
  })

  // The keychain is not reliably readable before `ready`, and this module is
  // evaluated earlier: load the stored account when it is, then confirm it.
  void app.whenReady().then(() => {
    session.reloadFromDisk()
    void session.verify('boot')
  })
  return session
}
