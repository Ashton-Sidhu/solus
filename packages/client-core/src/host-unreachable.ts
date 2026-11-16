import { z } from 'zod'

/**
 * Why an address did not answer, from the error its request failed with
 * (docs/plans/tailscale-support.md D2). A browser hides most of the reason
 * ("Failed to fetch"); a native client keeps the system's text, so the same
 * error can name more on mobile than on web.
 */
export type UnreachableCause =
  /** The platform refused a plain-HTTP request: iOS App Transport Security, or an `https:` page that asks for `http:`. */
  | 'insecure-blocked'
  | 'timeout'
  /** The address answered, but nothing listens on its port. */
  | 'refused'
  | 'other'

/** The parts of a request error that can name a reason; Node puts `ECONNREFUSED` on `error.cause`. */
const errorDetailSchema = z.object({
  code: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
}).catch({})

/** The text of a failed request, with the text of its cause when that adds something. */
export function failureText(error: Error): string {
  const cause = errorDetailSchema.parse(error.cause)
  const causeText = cause.message ?? cause.code
  return causeText && !error.message.includes(causeText) ? `${error.message}: ${causeText}` : error.message
}

export function unreachableCause(error: Error, timedOut: boolean): UnreachableCause {
  if (timedOut || error.name === 'TimeoutError') return 'timeout'
  const text = failureText(error)
  // iOS: NSURLErrorAppTransportSecurityRequiresSecureConnection (-1022).
  if (/App Transport Security|-1022\b/i.test(text)) return 'insecure-blocked'
  const codes = [errorDetailSchema.parse(error).code, errorDetailSchema.parse(error.cause).code]
  if (codes.includes('ECONNREFUSED') || codes.includes('ConnectionRefused') || /ECONNREFUSED|connection refused/i.test(text)) return 'refused'
  return 'other'
}
