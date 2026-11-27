import { describe, expect, it } from "vite-plus/test";

import { createStartupLinks } from "./startupLinks";

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

  it("does not open the launch URL a second time", () => {
    const app = harness();
    app.emit("t3code://pair?code=ABC");
    expect(app.links.takeLaunchUrl("t3code://pair?code=ABC", null)).toBe("t3code://pair?code=ABC");
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual([]);

    // The same link tapped again after startup is a new request.
    app.emit("t3code://pair?code=ABC");
    expect(app.opened).toEqual(["t3code://pair?code=ABC"]);
  });

  it("opens with a link native code kept from before any listener, when there is no launch URL", () => {
    // iOS: a link reaching the running app before JS listens fires no url event at all.
    const app = harness();
    const kept = "t3code://settings/environments/env-1";
    expect(app.links.takeLaunchUrl(null, kept)).toBe(kept);
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual([]);
  });

  it("opens a kept link that also reached the listener only once", () => {
    const app = harness();
    const kept = "t3code://settings/environments/env-1";
    app.emit(kept);
    expect(app.links.takeLaunchUrl(undefined, kept)).toBe(kept);
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual([]);
  });

  it("prefers the launch URL to a kept link and still opens the later link", () => {
    const app = harness();
    app.emit("t3code://settings");
    expect(app.links.takeLaunchUrl("t3code://pair?code=ABC", "t3code://settings")).toBe(
      "t3code://pair?code=ABC",
    );
    app.subscribe();
    app.becomeReady();
    expect(app.opened).toEqual(["t3code://settings"]);
  });

  it("has no launch URL when neither the launch nor native code has a link", () => {
    expect(harness().links.takeLaunchUrl(undefined, null)).toBeNull();
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
