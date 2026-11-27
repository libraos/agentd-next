// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  findBundleProblems,
  findForbiddenReferences,
  findReleaseEnvProblems,
} from "./mobile-release-check.ts";

const tempDirs: string[] = [];

function bundleDir(files: Record<string, string>) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mobile-release-check-"));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const path = NodePath.join(dir, name);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, text, "latin1");
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("findReleaseEnvProblems", () => {
  it("refuses a release environment that names the hosted relay, Clerk or a trace endpoint", () => {
    expect(findReleaseEnvProblems({ T3CODE_RELAY_URL: "https://r.example" }, false)).toEqual([
      "T3CODE_RELAY_URL is set",
    ]);
    expect(findReleaseEnvProblems({ EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_x" }, false)).toEqual([
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is set",
    ]);
    expect(
      findReleaseEnvProblems({ EXPO_PUBLIC_OTLP_TRACES_URL: "https://t.example" }, false),
    ).toEqual(["EXPO_PUBLIC_OTLP_TRACES_URL is set"]);
    expect(findReleaseEnvProblems({}, true)).toEqual(["HOSTED_RELAY_ENABLED is true"]);
    expect(findReleaseEnvProblems({ T3CODE_RELAY_URL: "" }, false)).toEqual([]);
    expect(findReleaseEnvProblems({ T3CODE_RELAY_URL: "  " }, false)).toEqual([]);
  });
});

describe("findForbiddenReferences", () => {
  it("finds upstream endpoints and ids in a bundle", () => {
    expect(
      findForbiddenReferences('a="https://clerk.t3.codes/x";b="ARK85ZXQ4Z.com.t3tools.t3code"'),
    ).toEqual(["clerk.t3.codes", "ARK85ZXQ4Z", "com.t3tools"]);
    expect(findForbiddenReferences("https://libraos.com/docs/next/")).toEqual([]);
  });

  it("still reports t3.codes when it appears outside the Clerk host", () => {
    expect(findForbiddenReferences("clerk.t3.codes and https://t3.codes/")).toEqual([
      "clerk.t3.codes",
      "t3.codes",
    ]);
  });
});

describe("findBundleProblems", () => {
  it("reports forbidden strings per file and ignores other file types", () => {
    const dir = bundleDir({
      "_expo/static/js/ios/entry.hbc": "\u0000https://u.expo.dev/abc\u0000",
      "metadata.json": "{}",
      "assets/readme.txt": "https://t3.codes",
    });
    expect(findBundleProblems(dir, {})).toEqual(["_expo/static/js/ios/entry.hbc: u.expo.dev"]);
  });

  it("lets an allowlisted occurrence through only in files its glob names", () => {
    const allow = {
      "**/*.hbc": [["github.com/pingdotgg/fork-docs", "third-party comment, never shown"]],
    } as const;
    const dir = bundleDir({
      "_expo/static/js/ios/entry.hbc": "see github.com/pingdotgg/fork-docs",
      "other.js": "see github.com/pingdotgg/fork-docs",
    });
    expect(findBundleProblems(dir, allow)).toEqual(["other.js: pingdotgg"]);
  });

  it("still reports a second occurrence the allowlist does not cover", () => {
    const allow = {
      "**/*.js": [["github.com/pingdotgg/fork-docs", "third-party comment, never shown"]],
    } as const;
    const dir = bundleDir({ "entry.js": "github.com/pingdotgg/fork-docs pingdotgg/t3code" });
    expect(findBundleProblems(dir, allow)).toEqual(["entry.js: pingdotgg"]);
  });
});
