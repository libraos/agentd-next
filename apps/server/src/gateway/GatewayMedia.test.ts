// @effect-diagnostics nodeBuiltinImport:off -- The paths under test are the host OS's.
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { chooseGateway, resolveOutputPath } from "./GatewayMedia.ts";

const gateways = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];

const workspace = NodePath.resolve("workspace-root");

const failureOf = <A, E>(result: Result.Result<A, E>) => {
  assert.isTrue(Result.isFailure(result));
  return (result as Result.Failure<A, E>).failure;
};

it("chooses the gateway the thread runs on", () => {
  assert.deepStrictEqual(chooseGateway(gateways, undefined, "gw-b-codex"), Result.succeed("b"));
});

it("names every gateway when it cannot choose", () => {
  const error = failureOf(chooseGateway(gateways, undefined, "codex"));
  assert.strictEqual(error.code, "ambiguous_gateway");
  assert.include(error.message, "Alpha");
  assert.include(error.message, "Beta");
});

it("a path outside the workspace is refused", () => {
  assert.strictEqual(
    failureOf(resolveOutputPath(workspace, "../x.mp4", "a.mp4", () => false)).code,
    "invalid_request",
  );
  const sibling = NodePath.resolve(workspace, "..", "elsewhere", "x.mp4");
  assert.strictEqual(
    failureOf(resolveOutputPath(workspace, sibling, "a.mp4", () => false)).code,
    "invalid_request",
  );
});

it("a taken name gets a number", () => {
  const taken = new Set([NodePath.join(workspace, "generated-media", "a.mp4")]);
  assert.deepStrictEqual(
    resolveOutputPath(workspace, undefined, "a.mp4", (file) => taken.has(file)),
    Result.succeed(NodePath.join(workspace, "generated-media", "a-1.mp4")),
  );
});
