export function formatVoiceModelBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  const kilobytes = Math.round(bytes / 1024)
  if (kilobytes < 1024) return `${kilobytes} KB`
  return `${Math.round(bytes / 1024 / 1024)} MB`
}
