import type { NativeSolusAPI, SolusAPI } from '../preload'
import type { Attachment } from '../shared/types'
import type { IpcContext } from '../shared/types'
import type { NativeOnlySolusMethod } from './native-api-overlay'

declare const hostApiBrand: unique symbol

export type HostApi = SolusAPI & {
  readonly [hostApiBrand]: true
  /** Web transport upload. Desktop file selection uses `attachFiles` instead. */
  uploadFiles(files: File[], ctx: IpcContext): Promise<Attachment[] | null>
}

/**
 * The API for the client shell. Never a proxy for "whatever host the user is
 * targeting".
 */
export interface LocalApi extends Pick<SolusAPI & NativeSolusAPI, NativeOnlySolusMethod | 'isVisible'> {}

/** @internal The only widening point from a raw RPC API to a host API. */
export function asHostApi(api: object): HostApi {
  return api as HostApi
}
