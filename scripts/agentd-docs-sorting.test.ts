// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

// Patch 142 sorts the inherited maintainer docs; agentd/patches/142-docs-sorting.md is the record.
const root = NodePath.resolve(import.meta.dirname, "..");
const read = (relative: string) => NodeFS.readFileSync(NodePath.join(root, relative), "utf8");
const CLASSES = ["applies", "upstream-only", "misleading"] as const;
const UPSTREAM_NOTE = "> This page describes upstream T3 Code";

const sortedDirs = ["docs/operations", "docs/internals"];
const pagesOnDisk = sortedDirs
  .flatMap((dir) =>
    NodeFS.readdirSync(NodePath.join(root, dir))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `${dir}/${name}`),
  )
  .toSorted();

const sorting = [
  ...read("agentd/patches/142-docs-sorting.md").matchAll(/^\| `([^`]+)` +\| (\S+) +\|/gm),
].map(([, page, cls]) => ({ page: page!, cls: cls! }));
const classOf = new Map(sorting.map(({ page, cls }) => [page, cls]));

const opensWithUpstreamNote = (page: string) =>
  read(page)
    .split("\n")
    .find((line, index) => index > 0 && line.trim() !== "")
    ?.startsWith(UPSTREAM_NOTE) ?? false;

const indexLinks = [...read("docs/README.md").matchAll(/\]\(\.\/([^)#]+\.md)(?:#[^)]*)?\)/g)].map(
  ([, link]) => `docs/${link}`,
);

describe("142 docs sorting", () => {
  it("records every operations and internals page once, with a known class", () => {
    assert.deepStrictEqual(sorting.map(({ page }) => page).toSorted(), pagesOnDisk);
    assert.deepStrictEqual(
      sorting.filter(({ cls }) => !(CLASSES as readonly string[]).includes(cls)),
      [],
    );
  });

  it("marks upstream-only and misleading pages at their top", () => {
    assert.deepStrictEqual(
      sorting.filter(({ page, cls }) => cls !== "applies" && !opensWithUpstreamNote(page)),
      [],
    );
  });

  it("keeps misleading pages out of the index", () => {
    assert.deepStrictEqual(
      indexLinks.filter((page) => classOf.get(page) === "misleading"),
      [],
    );
  });

  it("links only pages that describe LibraOS Next or say they describe upstream", () => {
    assert.isNotEmpty(indexLinks);
    assert.notInclude(read("docs/README.md"), "T3 Code");
    assert.deepStrictEqual(
      indexLinks.filter((page) => !opensWithUpstreamNote(page) && read(page).includes("T3 Code")),
      [],
    );
    assert.deepStrictEqual(
      sorting.filter(({ page, cls }) => cls === "applies" && read(page).includes("T3 Code")),
      [],
    );
  });
});
