import { describe, expect, it, vi } from "vite-plus/test";

import { createStartupLinks } from "./startupLinks";

const launch = (url: string | null | undefined) => async () => url;
const noKept = () => null;

function harness() {
  const queued: Array<() => void> = [];
  let ready = false;
  const links = createStartupLinks((deliver) => {
    if (ready) deliver();
    else queued.push(deliver);
  });
  const opened: string[] = [];
  return {
    links,
    opened,
    emit: (url: string) => links.receive(url),
    subscribe: () => links.subscribe((url) => opened.push(url)),
    becomeReady() {
      ready = true;
      for (const deliver of queued.splice(0)) deliver();
    },
  };
}

describe("createStartupLinks", () => {
  it("keeps a link that arrives before the navigator listens and opens it once it is ready", () => {
    const app = harness();
    app.emit("t3code://settings/environments/env-1");
    app.subscribe();
    expect(app.opened).toEqual([]);

    app.becomeReady();
    expect(app.opened).toEqual(["t3code://settings/environments/env-1"]);
  });

  it("holds a link that arrives after the navigator listens but before it is ready", () => {
    const app = harness();
    app.subscribe();
    app.emit("t3code://pair?code=ABC");
    expect(app.opened).toEqual([]);

    app.becomeReady();
    expect(app.opened).toEqual(["t3code://pair?code=ABC"]);
  });

  it("opens links at once after startup, in order", () => {
    const app = harness();
    app.subscribe();
    app.becomeReady();
    app.emit("t3code://settings");
    app.emit("t3code://settings/environments/env-1");
    expect(app.opened).toEqual(["t3code://settings", "t3code://settings/environments/env-1"]);
  });

  it("does not open the launch URL a second time", async () => {
    const app = harness();
    app.emit("t3code://pair?code=ABC");
    expect(await app.links.initialUrl(launch("t3code://pair?code=ABC"), noKept)).toBe(
      "t3code://pair?code=ABC",
    );
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual([]);

    // The same link tapped again later is a new event and opens.
    app.emit("t3code://pair?code=ABC");
    expect(app.opened).toEqual(["t3code://pair?code=ABC"]);
  });

  it("opens with the launch URL of a cold launch by link without reading a kept link", async () => {
    const app = harness();
    const readKept = vi.fn(() => "t3code://settings");
    const url = "t3code://settings/environments/env-1";
    expect(await app.links.initialUrl(launch(url), readKept)).toBe(url);
    expect(readKept).not.toHaveBeenCalled();
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual([]);
  });

  it("opens with a link native code kept from before any listener, when there is no launch URL", async () => {
    // iOS: a link reaching the running app before JS listens fires no url event at all.
    const app = harness();
    const kept = "t3code://settings/environments/env-1";
    expect(await app.links.initialUrl(launch(null), () => kept)).toBe(kept);
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual([]);
  });

  it("opens a kept link that also reached the listener only once", async () => {
    const app = harness();
    const kept = "t3code://settings/environments/env-1";
    app.emit(kept);
    expect(await app.links.initialUrl(launch(undefined), () => kept)).toBe(kept);
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual([]);
  });

  it("prefers the launch URL to a kept link and still opens the later link", async () => {
    const app = harness();
    app.emit("t3code://settings");
    expect(
      await app.links.initialUrl(launch("t3code://pair?code=ABC"), () => "t3code://settings"),
    ).toBe("t3code://pair?code=ABC");
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual(["t3code://settings"]);
  });

  it("has no launch URL when neither the launch nor native code has a link", async () => {
    expect(await harness().links.initialUrl(launch(undefined), noKept)).toBeNull();
  });

  it("starts without a launch URL when the kept link cannot be read, and opens later links", async () => {
    const app = harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = await app.links.initialUrl(launch(null), () => {
      throw new Error("native module unavailable");
    });
    expect(url).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    app.emit("t3code://settings");
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual(["t3code://settings"]);
  });

  it("keeps links while no navigator listens and hands them to the next one", () => {
    const app = harness();
    const unsubscribe = app.subscribe();
    app.becomeReady();
    unsubscribe();
    app.emit("t3code://settings");
    expect(app.opened).toEqual([]);

    app.subscribe();
    expect(app.opened).toEqual(["t3code://settings"]);
  });
});
