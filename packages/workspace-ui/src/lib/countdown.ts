/** Time left as m:ss, such as a code's or a request's expiry; 0:00 once it passed. */
export function countdown(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
