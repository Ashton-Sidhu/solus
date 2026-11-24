import { describe, expect, it } from "vite-plus/test";

import { buildPairingUrl, extractPairingUrlFromQrPayload, parsePairingUrl } from "./pairing";

describe("buildPairingUrl", () => {
  it("uses HTTP for a schemeless IP address", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("uses the Solus port for a hostname without a scheme", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "http://remote.example.com:3000/#token=pairing-token",
    );
  });

  it("preserves an explicit scheme for an IP address", () => {
    expect(buildPairingUrl("https://192.168.1.100:3773", "pairing-token")).toBe(
      "https://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("uses the typed address for a code even if its query names another host", () => {
    const pairingUrl = buildPairingUrl(
      "https://app.solus.sh/pair?host=other.tailnet.ts.net",
      "pairing-token",
    );
    expect(parsePairingUrl(pairingUrl)).toEqual({
      host: "https://app.solus.sh",
      code: "pairing-token",
    });
  });
});

describe("extractPairingUrlFromQrPayload", () => {
  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    expect(
      extractPairingUrlFromQrPayload(
        "solus://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });
});

describe("parsePairingUrl", () => {
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl("https://app.solus.sh/pair?host=desktop.tailnet.ts.net#token=pairing-token"),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});
