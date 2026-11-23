import { createProjectFaviconUrlAtomFamily } from "@t3tools/client-runtime/state/assets";
import type { AssetCreateUrlResult, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { projectFaviconDatabaseCache } from "../lib/projectFaviconDatabaseCache";
import { findProjectFavicon } from "../solus/project-favicon";

import { mobileHost } from "./mobile-host";

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconDatabaseCache,
  preparedConnection: (id) => Atom.make((get) => Option.fromNullOr(get(mobileHost(id)))),
  createUrl: ({ environmentId, input: { resource } }) =>
    Atom.make((get): Effect.Effect<AssetCreateUrlResult, string> => {
      const host = get(mobileHost(environmentId));
      if (!host || resource._tag !== "project-favicon") return Effect.fail("Host unavailable");
      return Effect.tryPromise({
        try: () => findProjectFavicon(host.api, resource.cwd, resource.path),
        catch: () => "Project icon unavailable",
      });
    }),
});
