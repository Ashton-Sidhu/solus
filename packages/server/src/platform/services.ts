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
  safeStorage?: PlatformSafeStorage
}

let services: PlatformServices = {}

export function configurePlatformServices(next: PlatformServices): void {
  services = next
}

export function platformServices(): PlatformServices {
  return services
}
