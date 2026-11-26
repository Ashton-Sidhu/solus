import { describe, expect, it } from "vite-plus/test";
import { sharingAccessHost, sharingAccessHosts } from "./sharing-access";

const office = { id: "office", label: "Office" };
const laptop = { id: "laptop", label: "Laptop" };
const none = { chosen: null, linked: null, scoped: null };

describe("sharingAccessHosts", () => {
  it("lists only the connected hosts, in their order, because a host that is not connected cannot answer", () => {
    expect(
      sharingAccessHosts([
        { environmentId: "office", environmentLabel: "Office", connectionState: "connected" },
        { environmentId: "cloud", environmentLabel: "Cloud", connectionState: "offline" },
        { environmentId: "nas", environmentLabel: "NAS", connectionState: "connecting" },
        { environmentId: "laptop", environmentLabel: "Laptop", connectionState: "connected" },
      ]),
    ).toEqual([office, laptop]);
  });
});

describe("sharingAccessHost", () => {
  const hosts = [office, laptop];

  it("opens on the host that the host page links from", () => {
    expect(sharingAccessHost(hosts, { ...none, linked: "laptop", scoped: "office" })).toBe("laptop");
  });

  it("opens on the host that Settings is scoped to when no host page links to it", () => {
    expect(sharingAccessHost(hosts, { ...none, scoped: "laptop" })).toBe("laptop");
  });

  it("opens on the first connected host when nothing names one", () => {
    expect(sharingAccessHost(hosts, none)).toBe("office");
  });

  it("keeps the host the person chose over the linked host", () => {
    expect(sharingAccessHost(hosts, { chosen: "office", linked: "laptop", scoped: null })).toBe("office");
  });

  it("leaves a chosen or linked host that is no longer connected", () => {
    expect(sharingAccessHost(hosts, { chosen: "cloud", linked: "nas", scoped: "laptop" })).toBe("laptop");
  });

  it("shows no host when none is connected", () => {
    expect(sharingAccessHost([], { chosen: "office", linked: "office", scoped: "office" })).toBeNull();
  });
});
