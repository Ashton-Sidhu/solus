/** Capture is a local desktop capability, independent of the session host. */
export function desktopCaptureSupport(platform: string) {
  return {
    screenshot: platform === 'linux' || platform === 'darwin' || platform === 'win32',
  }
}
