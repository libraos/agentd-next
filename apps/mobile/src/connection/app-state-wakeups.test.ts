import { expect, it } from "vite-plus/test";

import { createAppStateWakeups } from "./app-state-wakeups";

it("probes the connection on a quick return from the background", () => {
  const wakeupFor = createAppStateWakeups("active", 0);
  expect(wakeupFor("inactive", 100)).toBeNull();
  expect(wakeupFor("background", 200)).toBeNull();
  expect(wakeupFor("active", 3_000)).toBe("application-active-probe");
});

it("treats a return after a long background as a long resume", () => {
  const wakeupFor = createAppStateWakeups("active", 0);
  wakeupFor("background", 1_000);
  expect(wakeupFor("active", 11_000)).toBe("application-active-long");
});

it("does not probe when the app was only inactive", () => {
  // CI run 45985856017: iOS's "Open in …?" alert for a link left the app inactive, and the quick
  // probe that followed replaced a working socket to a busy host, which then did not answer.
  const wakeupFor = createAppStateWakeups("active", 0);
  expect(wakeupFor("inactive", 100)).toBeNull();
  expect(wakeupFor("active", 2_000)).toBeNull();
});

it("probes once per return from the background", () => {
  const wakeupFor = createAppStateWakeups("active", 0);
  wakeupFor("background", 100);
  expect(wakeupFor("active", 200)).toBe("application-active-probe");
  expect(wakeupFor("inactive", 300)).toBeNull();
  expect(wakeupFor("active", 400)).toBeNull();
});

it("counts the background from launch when the app starts there", () => {
  const wakeupFor = createAppStateWakeups("background", 0);
  expect(wakeupFor("active", 12_000)).toBe("application-active-long");
});
