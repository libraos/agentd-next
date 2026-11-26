import { describe, expect, it } from "vite-plus/test";

import { deviceHostFor, parseFlags } from "./mobile-ui-host.ts";

describe("mobile-ui-host", () => {
  it("reads --flag value pairs and refuses a flag without a value", () => {
    expect(
      Object.fromEntries(parseFlags(["--bind", "0.0.0.0", "--device-host", "10.0.2.2"])),
    ).toEqual({ bind: "0.0.0.0", "device-host": "10.0.2.2" });
    expect(() => parseFlags(["--bind"])).toThrow();
    expect(() => parseFlags(["--bind", "--base-dir", "x"])).toThrow();
  });

  it("gives a phone the bound address, or the first LAN address for a wildcard", () => {
    const interfaces = {
      lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
      eth0: [
        { family: "IPv6", internal: false, address: "fe80::1" },
        { family: "IPv4", internal: false, address: "192.0.2.10" },
      ],
    } as unknown as Parameters<typeof deviceHostFor>[1];
    expect(deviceHostFor("192.0.2.99", interfaces)).toBe("192.0.2.99");
    expect(deviceHostFor("0.0.0.0", interfaces)).toBe("192.0.2.10");
    expect(deviceHostFor("0.0.0.0", {})).toBe("127.0.0.1");
  });
});
