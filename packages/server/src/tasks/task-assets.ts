export function containsLocalAsset(body: string): boolean {
  return /(?:^|[\s(])asset:\/\/[a-f0-9]{64}\.[a-z0-9][a-z0-9+_-]{0,15}(?:$|[\s)])/i.test(body)
}
