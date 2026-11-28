import { describe, expect, it } from "vite-plus/test";

import {
  readRelayRouteFromUrl,
  relayBaseUrl,
  relayDeviceEndpoint,
  relayHostLabelOfUrl,
  type RelayRoute,
  setRelayRouteOnUrl,
} from "./route.ts";

const ROUTE: RelayRoute = {
  relayUrl: "https://relay.example.test",
  hostId: "0123456789abcdef0123456789abcdef",
  hostKey: "A".repeat(43),
  deviceToken: "device-token",
};

describe("relay route", () => {
  it("reads back the route a pairing link carries", () => {
    const url = setRelayRouteOnUrl("https://computer.example.test/pair#token=one-time", ROUTE);
    expect(readRelayRouteFromUrl(url)).toEqual(ROUTE);
    expect(readRelayRouteFromUrl("https://computer.example.test/pair#token=one-time")).toBeNull();
  });

  it("refuses a plain http relay unless it is on this machine", () => {
    const remote = setRelayRouteOnUrl("https://c.example.test/pair#token=t", {
      ...ROUTE,
      relayUrl: "http://relay.example.test",
    });
    const local = setRelayRouteOnUrl("https://c.example.test/pair#token=t", {
      ...ROUTE,
      relayUrl: "http://127.0.0.1:8787",
    });
    expect(readRelayRouteFromUrl(remote)).toBeNull();
    expect(readRelayRouteFromUrl(local)?.relayUrl).toBe("http://127.0.0.1:8787");
  });

  it("names a host by an address only the relay transport carries", () => {
    const base = relayBaseUrl(ROUTE);
    expect(base).toBe(`https://${ROUTE.hostId}.relay.invalid/`);
    expect(relayHostLabelOfUrl(`${base}api/x`)).toBe(ROUTE.hostId);
    expect(relayHostLabelOfUrl(base.replace("https", "wss"))).toBe(ROUTE.hostId);
    expect(relayHostLabelOfUrl("https://computer.example.test/")).toBeNull();
    expect(relayDeviceEndpoint(ROUTE)).toBe(
      `wss://relay.example.test/relay/v1/device?host=${ROUTE.hostId}`,
    );
  });
});
