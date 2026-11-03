import { z } from 'zod'
import {
  MAX_PERSONAL_SETTINGS_BYTES,
  PERSONAL_SETTING_KEYS,
  personalSettingsByteLength,
  personalSettingsDocumentSchema,
  type AccountSettingsResponse,
  type PersonalSettingKey,
  type PersonalSettingsDocument,
} from '@solus/contracts/settings'
import type { AccountSettingsResult, SettingsCloudRequests } from './settings-requests'
import {
  DocumentSync,
  type ClearOutcome as DocumentClearOutcome,
  type DocumentChange,
  type DocumentConflict,
  type DocumentSyncPorts,
  type DocumentSyncRequests,
  type DocumentSyncResult,
  type DocumentSyncStatus,
  type SyncedDocument,
  type SyncedDocumentContract,
} from './document-sync'

/**
 * Personal settings sync (plans/018 §5): the document sync engine
 * (`document-sync.ts`) bound to the personal settings document. The local
 * personal profile is the source of truth on each client; the account document
 * is its replica while signed in. The key set is fixed: every personal setting key.
 */

export type SettingConflict = DocumentConflict<PersonalSettingsDocument, PersonalSettingKey>
export type SettingsSyncStatus = DocumentSyncStatus<PersonalSettingsDocument, PersonalSettingKey>
/** A change for the personal profile: keys to set, and keys to return to their default. */
export type PersonalSettingsChange = DocumentChange<PersonalSettingsDocument, PersonalSettingKey>
export type ClearOutcome = DocumentClearOutcome<PersonalSettingKey>

export interface SettingsSyncPorts extends Omit<DocumentSyncPorts<PersonalSettingsDocument, PersonalSettingKey>, 'requests'> {
  requests: Pick<SettingsCloudRequests, 'accountSettingsGet' | 'accountSettingsPatch' | 'accountSettingsDelete'>
}

// SAFETY: `PERSONAL_SETTING_KEYS` is derived from the exhaustive owner table and is never empty.
const settingKeySchema = z.enum(PERSONAL_SETTING_KEYS as [PersonalSettingKey, ...PersonalSettingKey[]])

const PERSONAL_SETTINGS_CONTRACT: SyncedDocumentContract<PersonalSettingsDocument, PersonalSettingKey> = {
  storageKey: (accountKey) => `solus.settings-sync.v1:${accountKey}`,
  keySchema: settingKeySchema,
  documentSchema: personalSettingsDocumentSchema,
  keysOf: () => [...PERSONAL_SETTING_KEYS],
  empty: () => ({}),
  byteLength: personalSettingsByteLength,
  maxBytes: MAX_PERSONAL_SETTINGS_BYTES,
  retriesExhaustedMessage: 'The synced settings kept changing. Sync tries again later.',
}

function syncedSettings(response: AccountSettingsResponse): SyncedDocument<PersonalSettingsDocument> {
  return { generation: response.generation, revision: response.revision, document: response.settings, updatedAt: response.updatedAt }
}

function settingsResult(result: AccountSettingsResult): DocumentSyncResult<PersonalSettingsDocument> {
  switch (result.kind) {
    case 'ok':
      return { kind: 'ok', document: syncedSettings(result.settings) }
    case 'conflict':
      return { kind: 'conflict', reason: result.reason === 'settings_conflict' ? 'revision' : 'generation', code: result.reason, current: syncedSettings(result.current) }
    default:
      return result
  }
}

/** The settings calls as the engine asks for them. */
export function settingsDocumentRequests(requests: SettingsSyncPorts['requests']): DocumentSyncRequests<PersonalSettingsDocument, PersonalSettingKey> {
  return {
    get: async () => settingsResult(await requests.accountSettingsGet()),
    patch: async (request) => settingsResult(await requests.accountSettingsPatch(request)),
    delete: async () => settingsResult(await requests.accountSettingsDelete()),
  }
}

export class SettingsSync extends DocumentSync<PersonalSettingsDocument, PersonalSettingKey> {
  constructor(ports: SettingsSyncPorts) {
    super({ ...ports, requests: settingsDocumentRequests(ports.requests) }, PERSONAL_SETTINGS_CONTRACT)
  }
}
