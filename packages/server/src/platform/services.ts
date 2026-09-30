export interface PlatformAppInfo {
  appPath: string
  isPackaged: boolean
  logsPath: string
  userDataPath: string
  version: string
}

export interface PlatformSafeStorage {
  decryptString(buffer: Buffer): string
  encryptString(value: string): Buffer
  isEncryptionAvailable(): boolean
}

export interface PlatformServices {
  appInfo?: PlatformAppInfo
  openExternal?: (url: string) => Promise<void>
  /** The OS Trash through the shell that hosts the server, with "Put Back" metadata. */
  trashItem?: (path: string) => Promise<void>
  safeStorage?: PlatformSafeStorage
}

let services: PlatformServices = {}

export function configurePlatformServices(next: PlatformServices): void {
  services = next
}

export function platformServices(): PlatformServices {
  return services
}
