import { describe, expect, it } from "@effect/vitest";

import {
  type PinnedSource,
  fetchDue,
  gitBlobId,
  githubRepository,
  parseCatalog,
  planFiles,
  resolveInside,
  safeRelativePath,
  skillsDirectory,
  workerSkillsDirectories,
} from "./skillCatalog.ts";

const COMMIT = "c".repeat(40);
const SHA = "a".repeat(40);

describe("safeRelativePath", () => {
  it.each([
    ["SKILL.md", true],
    ["scripts/run.py", true],
    ["../escape", false],
    ["a/../../escape", false],
    ["a/./b", false],
    ["/etc/passwd", false],
    ["C:/Windows/system.ini", false],
    ["a\\..\\b", false],
    ["a//b", false],
    ["file:stream", false],
    ["con", false],
    ["NUL.txt", false],
    ["trailing.", false],
    ["trailing ", false],
    ["", false],
  ] as const)("%j safe: %s", (path, safe) => {
    expect(safeRelativePath(path) !== null).toBe(safe);
  });
});

describe("resolveInside", () => {
  it.each([
    ["linux", "/usr/u/.claude/skills", "pdf", "/usr/u/.claude/skills/pdf"],
    [
      "darwin",
      "/Users/u/.agents/skills",
      "pdf/LICENSE.txt",
      "/Users/u/.agents/skills/pdf/LICENSE.txt",
    ],
    [
      "win32",
      "C:\\Users\\u\\.claude\\skills",
      "pdf/scripts/a.py",
      "C:\\Users\\u\\.claude\\skills\\pdf\\scripts\\a.py",
    ],
    ["win32", "C:\\Users\\u\\.claude\\skills", "../pdf", null],
    ["linux", "/usr/u/.claude/skills", "../../.bashrc", null],
  ] as const)("%s %s + %s", (platform, root, relative, expected) => {
    expect(resolveInside(platform, root, relative)).toBe(expected);
  });
});

describe("skillsDirectory", () => {
  it.each([
    ["linux", "/usr/u", {}, "/usr/u/.claude/skills", "/usr/u/.agents/skills"],
    ["darwin", "/Users/u", {}, "/Users/u/.claude/skills", "/Users/u/.agents/skills"],
    ["win32", "C:\\Users\\u", {}, "C:\\Users\\u\\.claude\\skills", "C:\\Users\\u\\.agents\\skills"],
    [
      "win32",
      "C:\\Users\\u",
      { CLAUDE_CONFIG_DIR: "D:\\claude" },
      "D:\\claude\\skills",
      "C:\\Users\\u\\.agents\\skills",
    ],
    [
      "linux",
      "/usr/u",
      { CLAUDE_CONFIG_DIR: "/srv/claude" },
      "/srv/claude/skills",
      "/usr/u/.agents/skills",
    ],
  ] as const)("%s %s %j", (platform, home, env, claude, codex) => {
    const host = { platform, home, env };
    expect(skillsDirectory("claude", host)).toBe(claude);
    expect(skillsDirectory("codex", host)).toBe(codex);
    expect(workerSkillsDirectories("claude", host)).toEqual([claude]);
    expect(workerSkillsDirectories("opencode", host).slice(0, 2)).toEqual([claude, codex]);
  });

  it("finds opencode's own Skills under XDG_CONFIG_HOME, else ~/.config", () => {
    const host = { platform: "linux", home: "/usr/u", env: {} } as const;
    expect(workerSkillsDirectories("opencode", host)[2]).toBe("/usr/u/.config/opencode/skills");
    expect(
      workerSkillsDirectories("opencode", { ...host, env: { XDG_CONFIG_HOME: "/x" } })[2],
    ).toBe("/x/opencode/skills");
  });
});

describe("parseCatalog", () => {
  const entry = {
    id: "pdf",
    name: "PDF",
    description: "PDFs",
    group: "documents",
    author: "Anthropic",
    source: { url: "https://github.com/anthropics/skills", path: "skills/pdf", sha: COMMIT },
    licence: "Apache-2.0",
    reviewedAt: "2026-11-01",
    agents: ["claude", "codex"],
  };
  const groups = [{ id: "documents", name: "Documents" }];
  const text = (skills: ReadonlyArray<object>, groupList: ReadonlyArray<object> = groups) =>
    JSON.stringify({ $schema: "./catalog.schema.json", version: 1, groups: groupList, skills });
  it("reads a valid catalogue, with notices and an agent this build does not know", () => {
    const withNotices = {
      ...entry,
      source: { ...entry.source, notices: ["THIRD_PARTY_NOTICES.md"] },
      agents: ["claude", "opencode"],
    };
    expect(parseCatalog(text([withNotices]))).toEqual({
      version: 1,
      groups,
      skills: [withNotices],
    });
  });
  it("reads the published catalogue with no Skills yet", () => {
    expect(parseCatalog(text([]))?.groups).toEqual(groups);
  });
  it.each([
    ["a Skill listed twice", [entry, entry], groups],
    ["a group defined twice", [entry], [...groups, ...groups]],
    ["a Skill in a group not defined", [{ ...entry, group: "other" }], groups],
    [
      "a path leaving the repository",
      [{ ...entry, source: { ...entry.source, path: "../pdf" } }],
      groups,
    ],
    [
      "a notice with an unsafe path",
      [{ ...entry, source: { ...entry.source, notices: ["/etc/passwd"] } }],
      groups,
    ],
    [
      "a branch instead of a commit",
      [{ ...entry, source: { ...entry.source, sha: "main" } }],
      groups,
    ],
    [
      "a source that is not https",
      [{ ...entry, source: { ...entry.source, url: "http://x/y" } }],
      groups,
    ],
    ["an id that is not a folder name", [{ ...entry, id: "../pdf" }], groups],
    ["no agents", [{ ...entry, agents: [] }], groups],
    ["a missing licence", [{ ...entry, licence: undefined }], groups],
  ])("refuses %s", (_label, skills, groupList) => {
    expect(parseCatalog(text(skills, groupList))).toBeNull();
  });
  it("refuses another version and text that is not JSON", () => {
    expect(parseCatalog(JSON.stringify({ version: 2, groups, skills: [] }))).toBeNull();
    expect(parseCatalog("<html>")).toBeNull();
  });
});

describe("githubRepository", () => {
  it.each([
    ["https://github.com/anthropics/skills", "anthropics/skills"],
    ["https://github.com/anthropics/skills.git", "anthropics/skills"],
    ["https://github.com/anthropics/skills/", "anthropics/skills"],
    ["https://gitlab.com/anthropics/skills", null],
    ["https://github.com/anthropics/skills/tree/main", null],
    ["https://github.com/anthropics/..", null],
    ["https://github.com.evil.example/a/b", null],
  ] as const)("%s", (url, repository) => {
    expect(githubRepository(url)).toBe(repository);
  });
});

describe("fetchDue", () => {
  const day = 24 * 60 * 60 * 1000;
  it.each([
    [null, 0, true],
    [{ attemptedAt: "1970-01-01T00:00:00.000Z" }, day - 1, false],
    [{ attemptedAt: "1970-01-01T00:00:00.000Z" }, day, true],
    [{ attemptedAt: "1970-01-11T00:00:00.000Z" }, day, true],
  ] as const)("cache %j at %s: %s", (cache, now, due) => {
    expect(fetchDue(cache, now)).toBe(due);
  });
});

describe("planFiles", () => {
  const entry: PinnedSource = {
    repository: "o/r",
    commit: COMMIT,
    path: "skills/demo",
    notices: ["NOTICE.md"],
  };
  const blob = (path: string, mode = "100644") => ({
    path,
    mode,
    type: "blob",
    sha: SHA,
    size: 10,
  });
  const tree = (...items: ReadonlyArray<ReturnType<typeof blob>>) => ({
    truncated: false,
    tree: [...items],
  });

  it("takes the folder's files and the notices at its top", () => {
    const plan = planFiles(
      entry,
      tree(
        blob("skills/demo/SKILL.md"),
        blob("skills/demo/scripts/a.py", "100755"),
        blob("skills/other/SKILL.md"),
        blob("NOTICE.md"),
      ),
    );
    expect(plan).toEqual({
      _tag: "Files",
      files: [
        { source: "skills/demo/SKILL.md", target: "SKILL.md", sha: SHA },
        { source: "skills/demo/scripts/a.py", target: "scripts/a.py", sha: SHA },
        { source: "NOTICE.md", target: "NOTICE.md", sha: SHA },
      ],
    });
  });
  it.each([
    [
      "a symlink",
      tree(blob("skills/demo/SKILL.md"), blob("skills/demo/link", "120000"), blob("NOTICE.md")),
      "unsafe",
    ],
    [
      "a submodule",
      tree(
        blob("skills/demo/SKILL.md"),
        { ...blob("skills/demo/sub", "160000"), type: "commit" },
        blob("NOTICE.md"),
      ),
      "unsafe",
    ],
    [
      "a path escaping the folder",
      tree(blob("skills/demo/SKILL.md"), blob("skills/demo/a/../../../x"), blob("NOTICE.md")),
      "unsafe",
    ],
    [
      "a file named as the manifest",
      tree(blob("skills/demo/SKILL.md"), blob("skills/demo/.agentd-skill.json"), blob("NOTICE.md")),
      "unsafe",
    ],
    [
      "a notice clashing with a file",
      tree(blob("skills/demo/SKILL.md"), blob("skills/demo/notice.md"), blob("NOTICE.md")),
      "unsafe",
    ],
    ["no SKILL.md", tree(blob("skills/demo/README.md"), blob("NOTICE.md")), "download"],
    ["a missing notice", tree(blob("skills/demo/SKILL.md")), "download"],
  ] as const)("refuses %s", (_label, input, reason) => {
    expect(planFiles(entry, input)).toMatchObject({ _tag: "Refused", reason });
  });
  it("refuses a listing git cut short", () => {
    expect(
      planFiles(entry, { ...tree(blob("skills/demo/SKILL.md")), truncated: true }),
    ).toMatchObject({
      _tag: "Refused",
      reason: "download",
    });
  });
});

describe("gitBlobId", () => {
  it("matches git hash-object", () => {
    // printf 'hello\n' | git hash-object --stdin
    expect(gitBlobId(new TextEncoder().encode("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
  });
});
