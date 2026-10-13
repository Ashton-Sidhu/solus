// Adapted from T3 Code apps/mobile/src/native/nativeViewResolutionError.ts (MIT, see UPSTREAM.md).
// T3's Effect Schema error is a plain `Error` subclass.
export class NativeViewResolutionError extends Error {
  readonly nativeModuleName: string;

  constructor(input: { readonly nativeModuleName: string; readonly cause: unknown }) {
    super(`Failed to resolve native view ${input.nativeModuleName}.`, { cause: input.cause });
    this.name = "NativeViewResolutionError";
    this.nativeModuleName = input.nativeModuleName;
  }
}
