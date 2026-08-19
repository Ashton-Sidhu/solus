import { z } from 'zod'

/**
 * Wire codec for server→client arrays whose element set grows over time.
 * Decoding drops elements this build cannot decode instead of failing the
 * whole payload: the client must keep decoding data sent by hosts newer than
 * itself, and rejecting everything would disable a feature — or a whole
 * connection — over records the client could not act on anyway.
 */
export function forwardCompatibleArray<Schema extends z.ZodTypeAny>(element: Schema) {
  return z.array(z.unknown()).transform((values) =>
    values.flatMap((value) => {
      const parsed = element.safeParse(value)
      // SAFETY: `parsed.data` came from `element` itself; zod only fails to
      // carry the schema's output type through the generic `safeParse`.
      return parsed.success ? [parsed.data as z.output<Schema>] : []
    }),
  )
}
