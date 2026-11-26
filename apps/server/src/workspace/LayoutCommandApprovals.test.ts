import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LayoutCommandApprovals from "./LayoutCommandApprovals.ts";

const projectId = ProjectId.make("project:layout-approvals");

const layer = LayoutCommandApprovals.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tmp = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-layout-approvals-" }),
  );
  const project = path.join(tmp, "project");
  yield* fileSystem.makeDirectory(path.join(project, "scripts"), { recursive: true });
  yield* fileSystem.writeFileString(path.join(project, "scripts", "setup.sh"), "echo setup\n");
  yield* fileSystem.writeFileString(path.join(tmp, "outside.sh"), "echo outside\n");
  return { fileSystem, path, tmp, project };
});

it("takes the words of a command that may name a file", () => {
  assert.deepEqual(
    LayoutCommandApprovals.commandPathCandidates(
      `sh "./scripts/my setup.sh" --config=t3/layout.json && node $HOME/x.js 'b.sh';c.sh|d.sh *.sh`,
    ),
    // A word with a variable or a glob names nothing knowable, so `$HOME/x.js` and `*.sh` go.
    ["sh", "./scripts/my setup.sh", "t3/layout.json", "node", "b.sh", "c.sh", "d.sh"],
  );
});

it.effect("records only the files inside the project root that the command names", () =>
  Effect.gen(function* () {
    const { fileSystem, path, tmp, project } = yield* fixture;
    yield* fileSystem.symlink(path.join(tmp, "outside.sh"), path.join(project, "out.sh"));
    const command = "sh scripts/setup.sh ../outside.sh scripts missing.sh out.sh";
    const before = yield* LayoutCommandApprovals.repositoryFileHashes(project, command);
    assert.deepEqual(Object.keys(before), ["out.sh", "scripts/setup.sh"]);

    // A link that leads out of the project is recorded by where it leads, never read.
    yield* fileSystem.writeFileString(path.join(tmp, "outside.sh"), "echo changed\n");
    const after = yield* LayoutCommandApprovals.repositoryFileHashes(project, command);
    assert.equal(after["out.sh"], before["out.sh"]);
    assert.equal(after["scripts/setup.sh"], before["scripts/setup.sh"]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("keeps an approval from before files were recorded only for a command naming none", () =>
  Effect.gen(function* () {
    const { project } = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const digest = yield* Digest.Digest;
    const approvals = yield* LayoutCommandApprovals.LayoutCommandApprovals;
    // As an approval recorded before files counted: the hash of the text alone.
    const approveAsBefore = Effect.fnUntraced(function* (
      kind: "create" | "remove",
      command: string,
    ) {
      const hash = yield* LayoutCommandApprovals.commandHash(digest, command);
      yield* sql`
        INSERT INTO layout_command_approvals (project_id, kind, command_hash, approved_at)
        VALUES (${projectId}, ${kind}, ${hash}, '2026-01-01T00:00:00.000Z')
      `;
    });
    const plain = 'git worktree add -q -b "$T3_WORKTREE_BRANCH" "$T3_WORKTREE_PROJECT_PATH"';
    const script = "sh scripts/setup.sh";
    yield* approveAsBefore("create", plain);
    yield* approveAsBefore("remove", script);

    const isApproved = (kind: "create" | "remove", command: string) =>
      approvals.isApproved({ projectId, projectRoot: project, kind, command });
    assert.isTrue(yield* isApproved("create", plain));
    assert.isFalse(yield* isApproved("remove", script));
  }).pipe(Effect.provide(layer), Effect.scoped),
);
