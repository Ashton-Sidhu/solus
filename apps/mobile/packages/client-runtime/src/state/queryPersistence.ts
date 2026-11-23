import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class EnvironmentQueryStore extends Context.Reference<{
  readonly load: (
    environmentId: EnvironmentId,
    key: string,
  ) => Effect.Effect<Option.Option<string>>;
  readonly save: (
    environmentId: EnvironmentId,
    key: string,
    payload: string,
  ) => Effect.Effect<void>;
} | null>("@t3tools/client-runtime/EnvironmentQueryStore", {
  defaultValue: () => null,
}) {}

export interface QueryPersistence<A> {
  readonly load: (environmentId: EnvironmentId, key: string) => Effect.Effect<Option.Option<A>>;
  readonly save: (environmentId: EnvironmentId, key: string, value: A) => Effect.Effect<void>;
}

export function persistQuery<A, I>(schema: Schema.Codec<A, I>): QueryPersistence<A> {
  const codec = Schema.fromJsonString(Schema.toCodecJson(schema));
  return {
    load: Effect.fn("queryPersistence.load")(function* (environmentId, key) {
      const store = yield* EnvironmentQueryStore;
      if (store === null) return Option.none<A>();
      const stored = yield* store.load(environmentId, key);
      if (Option.isNone(stored)) return Option.none<A>();
      return yield* Schema.decodeEffect(codec)(stored.value).pipe(
        Effect.asSome,
        Effect.catch(() => Effect.succeedNone),
      );
    }),
    save: Effect.fn("queryPersistence.save")(
      function* (environmentId, key, value) {
        const store = yield* EnvironmentQueryStore;
        if (store === null) return;
        const payload = yield* Schema.encodeEffect(codec)(value);
        yield* store.save(environmentId, key, payload);
      },
      Effect.catch(() => Effect.logWarning("Offline query cache save failed")),
    ),
  };
}

/** Show a saved answer on mount and replace it when the connected host answers. */
export function readPersistedQuery<A, E, R>(options: {
  readonly persistence: QueryPersistence<A>;
  readonly environmentId: EnvironmentId;
  readonly key: string;
  readonly previous: Option.Option<A>;
  readonly connected: boolean;
  readonly emit: (value: A) => Effect.Effect<void>;
  readonly answer: () => Effect.Effect<A, E, R>;
}) {
  return Effect.gen(function* () {
    const { persistence, environmentId, key, previous } = options;
    const cached = Option.isSome(previous) ? previous : yield* persistence.load(environmentId, key);
    if (Option.isSome(cached)) {
      if (!options.connected) return cached.value;
      if (Option.isNone(previous)) yield* options.emit(cached.value);
    }
    // Saving must not delay the response. The write belongs to the query's scope.
    return yield* options
      .answer()
      .pipe(
        Effect.tap((value) => persistence.save(environmentId, key, value).pipe(Effect.forkScoped)),
      );
  });
}
