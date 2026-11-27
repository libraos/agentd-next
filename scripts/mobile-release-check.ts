#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot CI check; synchronous Node APIs keep it small.
// Release checks for the mobile app (the mobile v1 design): nothing of upstream's hosted services
// may reach a store build.
//
//   node scripts/mobile-release-check.ts env           the build environment names no relay, sign-in or trace endpoint
//   node scripts/mobile-release-check.ts bundle DIR    an `expo export` output holds no upstream endpoint or id
//
// Exit 0 silently when clean; 1 with one problem per line otherwise.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HOSTED_RELAY_ENABLED } from "@t3tools/shared/hostedRelay";

// Ordered so a longer match is found before the shorter one it contains.
const FORBIDDEN = [
  "clerk.t3.codes",
  "t3.codes",
  "u.expo.dev",
  "api.axiom.co",
  "ARK85ZXQ4Z",
  "com.t3tools",
  "pingdotgg",
] as const;

const ENV_PREFIXES = ["EXPO_PUBLIC_CLERK_", "EXPO_PUBLIC_OTLP_"] as const;
const ENV_NAMES = ["T3CODE_RELAY_URL"] as const;

const BUNDLE_EXTENSIONS = new Set([".js", ".json", ".hbc"]);

/** Glob of files under the export → strings allowed there, each with why it is harmless. */
export type ReleaseAllowlist = Readonly<
  Record<string, ReadonlyArray<readonly [allowed: string, reason: string]>>
>;

export function findReleaseEnvProblems(
  env: Readonly<Record<string, string | undefined>>,
  hostedRelayEnabled: boolean,
): string[] {
  const problems = Object.entries(env)
    .filter(
      ([name, value]) =>
        Boolean(value?.trim()) &&
        (ENV_NAMES.some((known) => known === name) ||
          ENV_PREFIXES.some((prefix) => name.startsWith(prefix))),
    )
    .map(([name]) => `${name} is set`)
    .toSorted();
  if (hostedRelayEnabled) problems.push("HOSTED_RELAY_ENABLED is true");
  return problems;
}

export function findForbiddenReferences(text: string): string[] {
  const found: string[] = [];
  let rest = text;
  for (const needle of FORBIDDEN) {
    if (!rest.includes(needle)) continue;
    found.push(needle);
    // Blank it out so `t3.codes` is not reported again for every `clerk.t3.codes`.
    rest = rest.replaceAll(needle, " ");
  }
  return found;
}

function listFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && BUNDLE_EXTENSIONS.has(NodePath.extname(entry.name)))
    .map((entry) =>
      NodePath.relative(dir, NodePath.join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
    )
    .toSorted();
}

export function findBundleProblems(dir: string, allowlist: ReleaseAllowlist): string[] {
  const problems: string[] = [];
  for (const file of listFiles(dir)) {
    let text = NodeFS.readFileSync(NodePath.join(dir, file), "latin1");
    for (const [glob, entries] of Object.entries(allowlist)) {
      if (!NodePath.matchesGlob(file, glob)) continue;
      for (const [allowed] of entries) text = text.replaceAll(allowed, " ");
    }
    for (const needle of findForbiddenReferences(text)) problems.push(`${file}: ${needle}`);
  }
  return problems;
}

function readAllowlist(): ReleaseAllowlist {
  const path = new URL("./mobile-release-check.allow.json", import.meta.url);
  return NodeFS.existsSync(path) ? JSON.parse(NodeFS.readFileSync(path, "utf8")) : {};
}

function main(args: readonly string[]): number {
  const [mode, dir] = args;
  let problems: string[];
  if (mode === "env") {
    problems = findReleaseEnvProblems(process.env, HOSTED_RELAY_ENABLED);
  } else if (mode === "bundle" && dir) {
    if (!NodeFS.existsSync(dir)) {
      console.error(`${dir} does not exist`);
      return 1;
    }
    problems = findBundleProblems(dir, readAllowlist());
  } else {
    console.error("usage: mobile-release-check.ts env | bundle DIR");
    return 1;
  }
  for (const problem of problems) console.error(problem);
  return problems.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
