export function isUnconfiguredCwd(cwd: string | null | undefined): boolean {
  return !cwd || cwd === '~'
}
