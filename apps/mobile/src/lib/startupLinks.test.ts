import { describe, expect, it, vi } from "vite-plus/test";

import { createStartupLinks, type KeptLink } from "./startupLinks";

const launch = (url: string | null | undefined) => async () => url;

/** expo-linking's native slot on iOS: the last link received, until cleared. */
function nativeSlot(initial: string | null = null) {
  let url = initial;
  return {
    receive: (next: string) => {
      url = next;
    },
    read: vi.fn(() => url),
    clear: vi.fn(() => {
      url = null;
    }),
  };
}

function harness(keptLink?: KeptLink) {
  const queued: Array<() => void> = [];
  let ready = false;
  const links = createStartupLinks((deliver) => {
    if (ready) deliver();
    else queued.push(deliver);
  }, keptLink);
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
    expect(await app.links.initialUrl(launch("t3code://pair?code=ABC"))).toBe(
      "t3code://pair?code=ABC",
    );
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual([]);

    // The same link tapped again later is a new event and opens.
    app.emit("t3code://pair?code=ABC");
    expect(app.opened).toEqual(["t3code://pair?code=ABC"]);
  });

  it("opens with the launch URL of a cold launch by link without taking the kept link", async () => {
    const url = "t3code://settings/environments/env-1";
    const slot = nativeSlot(url);
    const app = harness(slot);
    expect(await app.links.initialUrl(launch(url))).toBe(url);
    expect(slot.read).not.toHaveBeenCalled();
    expect(slot.clear).not.toHaveBeenCalled();
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual([]);
  });

  it("opens with a link native code kept from before any listener, when there is no launch URL", async () => {
    // iOS: a link reaching the running app before JS listens fires no url event at all.
    const kept = "t3code://settings/environments/env-1";
    const slot = nativeSlot(kept);
    const app = harness(slot);
    expect(await app.links.initialUrl(launch(null))).toBe(kept);
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual([]);
  });

  it("takes the kept link once, so a JS reload does not open it again", async () => {
    const kept = "t3code://settings/environments/env-1";
    const slot = nativeSlot(kept);
    expect(await harness(slot).links.initialUrl(launch(null))).toBe(kept);
    expect(slot.clear).toHaveBeenCalledOnce();

    expect(await harness(slot).links.initialUrl(launch(null))).toBeNull();
  });

  it("does not open a link again after a JS reload when it reached the listener", async () => {
    // Native code keeps every link, including those JS opened as url events.
    const slot = nativeSlot();
    const app = harness(slot);
    expect(await app.links.initialUrl(launch(null))).toBeNull();
    app.subscribe();
    app.becomeReady();
    slot.receive("t3code://pair?code=ABC");
    app.emit("t3code://pair?code=ABC");
    expect(app.opened).toEqual(["t3code://pair?code=ABC"]);

    expect(await harness(slot).links.initialUrl(launch(null))).toBeNull();
  });

  it("opens a link that reached the listener before the initial URL was read only once", async () => {
    const url = "t3code://settings/environments/env-1";
    const slot = nativeSlot();
    const app = harness(slot);
    slot.receive(url);
    app.emit(url);
    expect(await app.links.initialUrl(launch(undefined))).toBeNull();
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual([url]);
  });

  it("opens a kept link whose url event comes after the initial URL was read only once", async () => {
    const url = "t3code://settings/environments/env-1";
    const slot = nativeSlot(url);
    const app = harness(slot);
    expect(await app.links.initialUrl(launch(undefined))).toBe(url);
    app.emit(url);
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual([]);
  });

  it("prefers the launch URL to a kept link and still opens the later link", async () => {
    const slot = nativeSlot();
    const app = harness(slot);
    slot.receive("t3code://settings");
    app.emit("t3code://settings");
    expect(await app.links.initialUrl(launch("t3code://pair?code=ABC"))).toBe(
      "t3code://pair?code=ABC",
    );
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual(["t3code://settings"]);
  });

  it("has no launch URL when neither the launch nor native code has a link", async () => {
    expect(await harness(nativeSlot()).links.initialUrl(launch(undefined))).toBeNull();
    expect(await harness().links.initialUrl(launch(undefined))).toBeNull();
  });

  it("starts without a launch URL when the kept link cannot be read, and opens later links", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = harness({
      read: () => {
        throw new Error("native module unavailable");
      },
      clear: () => {
        throw new Error("native module unavailable");
      },
    });
    const url = await app.links.initialUrl(launch(null));
    expect(url).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    app.emit("t3code://settings");
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
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
