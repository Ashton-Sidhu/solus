import type { EnvironmentId } from "@t3tools/contracts";
import type { HostConnections } from "@solus-mobile/features/hosts/host-connections";
import { Atom } from "effect/reactivity";

export const mobileHostConnections = Atom.make<HostConnections | null>(null).pipe(Atom.keepAlive);

export const mobileHost = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const hosts = get(mobileHostConnections);
    if (!hosts) return null;
    const read = () => {
      const connection = hosts.connection(environmentId);
      if (connection?.state.readiness !== "ready") return null;
      return {
        api: connection.api,
        events: connection.events,
        httpBaseUrl: connection.transport.serverUrl,
        generation: connection.state.sessionGeneration,
        canProjectCheckout: connection.facts.value("capabilities")?.checkoutStatus === true,
        canReadFiles: hosts.may(environmentId, "host.files.read"),
      };
    };
    let current = read();
    get.addFinalizer(
      hosts.changes.subscribe(() => {
        const next = read();
        if (
          next?.api === current?.api &&
          next?.events === current?.events &&
          next?.httpBaseUrl === current?.httpBaseUrl &&
          next?.generation === current?.generation &&
          next?.canProjectCheckout === current?.canProjectCheckout &&
          next?.canReadFiles === current?.canReadFiles
        )
          return;
        current = next;
        get.setSelf(next);
      }),
    );
    return current;
  }),
);

export const fileAccountScope = Atom.make({ key: "", organizationId: null as string | null }).pipe(
  Atom.keepAlive,
);
