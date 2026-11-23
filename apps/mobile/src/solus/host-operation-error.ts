import * as Schema from "effect/Schema";

export class HostOperationError extends Schema.TaggedError<HostOperationError>()(
  "HostOperationError",
  {
    message: Schema.String,
  },
) {
  static from(cause: unknown) {
    return new HostOperationError({
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
