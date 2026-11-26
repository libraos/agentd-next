import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    // app.config.ts copies this into process.env, where undefined would become "undefined".
    ...(process.env.T3CODE_MOBILE_BUILD_NUMBER
      ? { T3CODE_MOBILE_BUILD_NUMBER: process.env.T3CODE_MOBILE_BUILD_NUMBER }
      : {}),
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.libraos.next"],
  ["development", "com.libraos.next.dev"],
  ["preview", "com.libraos.next.preview"],
  ["production", "com.libraos.next"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  // Neither the hosted relay's sign-in domain nor a hosted web app is linked by default.
  expect(config.ios?.associatedDomains).toEqual([]);
  expect(config.android?.intentFilters).toEqual([]);
  expect(config.ios?.appleTeamId).toBe("3NP2A75X35");
  // Nothing of upstream's EAS project, update feed, trace endpoint or sign-in reaches a build.
  expect(config.owner).toBeUndefined();
  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
  expect(config.extra?.eas?.projectId).toBe("00000000-0000-0000-0000-000000000000");
  expect(config.extra?.observability?.tracesUrl).toBeNull();
  expect(JSON.stringify(config.plugins)).not.toContain("@clerk/expo");
});

it("links copied thread URLs of a hosted web app only when HOSTED_APP_HOST names one", async () => {
  vi.stubEnv("HOSTED_APP_HOST", "app.example.test");
  const config = await loadConfig("production");
  expect(config.ios?.associatedDomains).toEqual(["applinks:app.example.test"]);
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host: "app.example.test", pathPrefix: "/threads/" },
  ]);
});

it("numbers a store build from T3CODE_MOBILE_BUILD_NUMBER on both platforms, and only then", async () => {
  const unnumbered = await loadConfig("production");
  expect(unnumbered.ios?.buildNumber).toBeUndefined();
  expect(unnumbered.android?.versionCode).toBeUndefined();
  vi.stubEnv("T3CODE_MOBILE_BUILD_NUMBER", "42");
  const numbered = await loadConfig("production");
  expect(numbered.ios?.buildNumber).toBe("42");
  expect(numbered.android?.versionCode).toBe(42);
});
