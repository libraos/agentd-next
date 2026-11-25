// @effect-diagnostics nodeBuiltinImport:off - the scripted hook reads its file as a hook process would.
import * as NodeFS from "node:fs";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Command,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as AgentdPlugins from "./AgentdPlugins.ts";
import { PLUGIN_CATALOG_URL } from "./pluginCatalog.ts";
import { gitBlobId } from "./skillCatalog.ts";

const COMMIT = "c".repeat(40);
const text = (value: string) => new TextEncoder().encode(value);
const reply = (json: object) => `#!/bin/sh\ncat >/dev/null\necho '${JSON.stringify(json)}'\n`;
const HOOKS: Record<string, string> = {
  pass: reply({ decision: "pass" }),
  rewrite: reply({ decision: "rewrite", message: { text: "[redacted]" } }),
  block: reply({ decision: "block", reason: "  contains a secret  " }),
  fails: "#!/bin/sh\ncat >/dev/null\nexit 3\n",
  junk: "#!/bin/sh\ncat >/dev/null\necho 'not json'\n",
  files: reply({ decision: "pass" }),
};
const manifest = (id: string) =>
  JSON.stringify({
    schemaVersion: 1,
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    hooks: {
      "before-send": {
        command: ["./hook.sh"],
        ...(id === "files" ? { attachmentFiles: true } : {}),
      },
    },
  });
// Its setup runs in the plugin's folder: it writes to the plugin's data folder what it saw, and
// fails while the test has put a `fail` file there.
const SETUP_SCRIPT = `#!/bin/sh
data=../../../../data/setup
mkdir -p "$data"
cat > "$data/stdin"
echo "Step 1 of 1: writing the marker"
if [ -f "$data/fail" ]; then echo "error: told to fail" >&2; exit 4; fi
pwd > "$data/marker"
`;
const SETUP_DESCRIPTION = "Downloads nothing and needs no disk.";
const REPO_FILES: Record<string, Uint8Array> = {
  ...Object.fromEntries(
    Object.entries(HOOKS).flatMap(([id, script]) => [
      [`plugins/${id}/agentd-plugin.json`, text(manifest(id))],
      [`plugins/${id}/hook.sh`, text(script)],
    ]),
  ),
  "plugins/setup/agentd-plugin.json": text(
    JSON.stringify({
      ...JSON.parse(manifest("setup")),
      setup: { command: ["./setup.sh"], description: SETUP_DESCRIPTION },
    }),
  ),
  "plugins/setup/hook.sh": text(HOOKS.pass!),
  "plugins/setup/setup.sh": text(SETUP_SCRIPT),
  // The outreach shape: a URL setting as env, its API key as a file.
  "plugins/mcp/agentd-plugin.json": text(
    JSON.stringify({
      schemaVersion: 1,
      id: "mcp",
      name: "Plugin mcp",
      version: "1.0.0",
      settings: [
        { name: "outreach_url", label: "Outreach URL", secret: false },
        { name: "outreach_token", label: "API key", secret: true },
      ],
      contributes: {
        mcpServers: {
          outreach: {
            command: "./server.sh",
            args: ["mcp"],
            env: { OUTREACH_LOG: "quiet" },
            settings: {
              OUTREACH_URL: "outreach_url",
              OUTREACH_API_KEY_FILE: { setting: "outreach_token", file: true },
            },
          },
        },
      },
    }),
  ),
  "plugins/mcp/server.sh": text("#!/bin/sh\nexit 0\n"),
};
const entry = (id: string) => ({
  id,
  name: `Plugin ${id}`,
  description: "A test plugin",
  author: "Owner",
  licence: "MIT",
  reviewedAt: "2026-11-01",
  version: "1.0.0",
  source: { url: "https://github.com/owner/repo", path: `plugins/${id}`, sha: COMMIT },
});
const CATALOG = JSON.stringify({
  version: 1,
  plugins: [...Object.keys(HOOKS), "setup", "mcp"].map(entry),
});
const TREE_URL = `https://api.github.com/repos/owner/repo/git/trees/${COMMIT}?recursive=1`;
const rawUrl = (path: string) => `https://raw.githubusercontent.com/owner/repo/${COMMIT}/${path}`;
const TREE = JSON.stringify({
  sha: "t".repeat(40),
  truncated: false,
  tree: Object.entries(REPO_FILES).map(([path, bytes]) => ({
    path,
    mode: "100644",
    type: "blob",
    sha: gitBlobId(bytes),
    size: bytes.byteLength,
  })),
});

const PROJECT = ProjectId.make("project-1");
const THREAD = ThreadId.make("thread-1");
const MESSAGE = MessageId.make("message-1");

const TIMED_OUT: ProcessRunner.ProcessRunOutput = {
  stdout: "",
  stderr: "",
  code: null,
  timedOut: true,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};
const timedOutRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: () => Effect.succeed(TIMED_OUT),
});

const harness = (
  runner: Layer.Layer<
    ProcessRunner.ProcessRunner,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  > = ProcessRunner.layer,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const routes = new Map<string, string | Uint8Array>([
      [PLUGIN_CATALOG_URL, CATALOG],
      [TREE_URL, TREE],
      ...Object.entries(REPO_FILES).map(([file, body]): [string, Uint8Array] => [
        rawUrl(file),
        body,
      ]),
    ]);
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const body = routes.get(request.url);
        return HttpClientResponse.fromWeb(
          request,
          new Response(body ?? "", { status: body === undefined ? 404 : 200 }),
        );
      }),
    );
    // Built in the test's scope, so a setup it forks runs until the test ends.
    const context = yield* Layer.build(
      AgentdPlugins.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, client),
            Layer.succeed(HostProcess.HomeDirectory, config.baseDir),
            Layer.succeed(HostProcess.Environment, {}),
            runner,
          ),
        ),
      ),
    );
    const service = Context.get(context, AgentdPlugins.AgentdPluginsService);
    const cache = path.join(config.stateDir, "plugins", "cache", "libraos");
    const enable = (id: string) =>
      service
        .install({ id })
        .pipe(Effect.andThen(service.setEnabled({ id, enabled: true })), Effect.orDie);
    const send = (overrides: Partial<AgentdPlugins.BeforeSendRequest> = {}) =>
      service
        .checkBeforeSend({
          projectId: PROJECT,
          threadId: THREAD,
          messageId: MESSAGE,
          text: "my password is hunter2",
          attachments: [],
          source: "web",
          ...overrides,
        })
        .pipe(Effect.flip);
    return { fs, path, config, service, cache, enable, send };
  });

const dependencies = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: "agentd-plugins-" })),
  Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
);

const dispatch = {
  type: "message.dispatch",
  commandId: CommandId.make("command-1"),
  threadId: THREAD,
  messageId: MESSAGE,
  text: "my password is hunter2",
  attachments: [],
  createdBy: "user",
  creationSource: "web",
} as unknown as OrchestrationV2Command;

it.effect("installs per version with a record, and remove deletes only what it wrote", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const listed = yield* h.service.install({ id: "pass" });
    expect(listed.plugins.find((plugin) => plugin.id === "pass")).toMatchObject({
      installedVersion: "1.0.0",
      hooks: ["before-send"],
      enabled: false,
      state: "off",
    });
    expect(listed.plugins.find((plugin) => plugin.id === "pass")).not.toHaveProperty("setup");
    expect(listed.beforeSend).toBe(false);
    const folder = h.path.join(h.cache, "pass", "1.0.0");
    expect((yield* h.fs.readDirectory(folder)).toSorted()).toEqual([
      ".agentd-plugin-install.json",
      "agentd-plugin.json",
      "hook.sh",
    ]);
    expect(((yield* h.fs.stat(h.path.join(folder, "hook.sh"))).mode & 0o111) !== 0).toBe(true);

    const enabled = yield* h.service.setEnabled({ id: "pass", enabled: true });
    expect(enabled.beforeSend).toBe(true);
    const off = yield* h.service.setEnabled({ id: "pass", enabled: false, projectId: PROJECT });
    expect(off.plugins.find((plugin) => plugin.id === "pass")).toMatchObject({
      enabled: true,
      projectEnabled: false,
      state: "off",
    });
    expect(off.beforeSend).toBe(false);
    expect(yield* h.service.hasBeforeSend(PROJECT)).toBe(false);
    expect(yield* h.service.hasBeforeSend(ProjectId.make("project-2"))).toBe(true);

    yield* h.fs.writeFileString(h.path.join(folder, "mine.txt"), "not the install's");
    const removed = yield* h.service.remove({ id: "pass" });
    expect(removed.plugins.find((plugin) => plugin.id === "pass")?.state).toBe("absent");
    expect(yield* h.fs.readDirectory(folder)).toEqual(["mine.txt"]);
    expect(yield* h.service.hasBeforeSend(ProjectId.make("project-2"))).toBe(false);

    expect(
      (yield* h.service.setEnabled({ id: "pass", enabled: true }).pipe(Effect.flip)).reason,
    ).toBe("unknown");
    expect((yield* h.service.install({ id: "nope" }).pipe(Effect.flip)).reason).toBe("unknown");
  }).pipe(Effect.provide(dependencies)),
);

it.live("runs no hook and changes nothing when no plugin is enabled", () =>
  Effect.gen(function* () {
    const h = yield* harness(
      Layer.succeed(ProcessRunner.ProcessRunner, { run: () => Effect.die("no hook should run") }),
    );
    yield* h.service.install({ id: "block" });
    expect(yield* h.service.hasBeforeSend(PROJECT)).toBe(false);
    yield* h.service.checkBeforeSend({
      projectId: PROJECT,
      threadId: THREAD,
      messageId: MESSAGE,
      text: "hello",
      attachments: [],
      source: "web",
    });
  }).pipe(Effect.provide(dependencies)),
);

it.live("a pass hook lets the message go as it is", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.enable("pass");
    yield* h.service.checkBeforeSend({
      projectId: PROJECT,
      threadId: THREAD,
      messageId: MESSAGE,
      text: "hello",
      attachments: [],
      source: "web",
    });
  }).pipe(Effect.provide(dependencies)),
);

it.live("the hook reads text attachments and is told which attachments it cannot read", () =>
  Effect.gen(function* () {
    const stdin: string[] = [];
    const h = yield* harness(
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) => {
          stdin.push(input.stdin ?? "");
          return Effect.succeed({
            stdout: JSON.stringify({ decision: "pass" }),
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          });
        },
      }),
    );
    yield* h.enable("pass");
    const textId = createPendingAttachmentId("txt");
    const binaryId = createPendingAttachmentId("bin");
    const attachments = [
      { type: "file", id: textId, name: "notes.txt", mimeType: "text/plain", sizeBytes: 5 },
      { type: "file", id: binaryId, name: "scan.pdf", mimeType: "application/pdf", sizeBytes: 3 },
    ] as unknown as ReadonlyArray<ChatAttachment>;
    for (const [attachment, bytes] of [
      [attachments[0]!, text("notes")],
      [attachments[1]!, new Uint8Array([0, 1, 2])],
    ] as const) {
      const file = resolveAttachmentPath({ attachmentsDir: h.config.attachmentsDir, attachment })!;
      yield* h.fs.makeDirectory(h.path.dirname(file), { recursive: true });
      yield* h.fs.writeFile(file, bytes);
    }
    yield* h.service.checkBeforeSend({
      projectId: PROJECT,
      threadId: THREAD,
      messageId: MESSAGE,
      text: "hello",
      attachments,
      source: "web",
    });
    expect(JSON.parse(stdin[0]!)).toMatchObject({
      message: { text: "hello", attachments: [{ id: textId, name: "notes.txt", text: "notes" }] },
    });
    // A hook that does not declare attachmentFiles gets the name only, as before.
    expect(JSON.parse(stdin[0]!).unshownAttachments).toEqual([{ id: binaryId, name: "scan.pdf" }]);
  }).pipe(Effect.provide(dependencies)),
);

it.live("block, a failed exit, invalid output and a missing hook stop the send with a reason", () =>
  Effect.gen(function* () {
    const cases = [
      ["block", "Plugin block: contains a secret"],
      ["fails", "Plugin fails failed (exit 3), so the message was not sent."],
      ["junk", "Plugin junk gave no usable answer, so the message was not sent."],
    ] as const;
    for (const [id, message] of cases) {
      const h = yield* harness();
      yield* h.enable(id);
      expect(yield* h.send()).toMatchObject({ reason: "blocked", message });
      yield* h.service.remove({ id });
    }
    const h = yield* harness();
    yield* h.enable("pass");
    yield* h.fs.remove(h.path.join(h.cache, "pass", "1.0.0", "hook.sh"));
    expect((yield* h.service.list({})).plugins.find((plugin) => plugin.id === "pass")?.state).toBe(
      "missing",
    );
    expect((yield* h.send()).message).toContain("its hook cannot be found");
  }).pipe(Effect.provide(dependencies)),
);

it.effect("a hook that does not answer in time stops the send", () =>
  Effect.gen(function* () {
    const h = yield* harness(timedOutRunner);
    yield* h.enable("pass");
    expect(yield* h.send()).toMatchObject({
      reason: "blocked",
      message: "Plugin pass did not answer in time, so the message was not sent.",
    });
  }).pipe(Effect.provide(dependencies)),
);

it.live("a rewrite without a person to review it stops the send", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.enable("rewrite");
    const error = yield* h.send({ source: "mcp" });
    expect(error.reason).toBe("blocked");
    expect(yield* h.service.review({ threadId: THREAD, messageId: MESSAGE })).toBeNull();
  }).pipe(Effect.provide(dependencies)),
);

it.live(
  "a rewrite is held for review, and confirm returns the send with the confirmed content",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.enable("rewrite");
      const attachmentId = createPendingAttachmentId("txt");
      const attachments = [
        { type: "file", id: attachmentId, name: "notes.txt", mimeType: "text/plain", sizeBytes: 9 },
      ] as unknown as ReadonlyArray<ChatAttachment>;
      const file = resolveAttachmentPath({
        attachmentsDir: h.config.attachmentsDir,
        attachment: attachments[0]!,
      })!;
      yield* h.fs.makeDirectory(h.path.dirname(file), { recursive: true });
      yield* h.fs.writeFileString(file, "token=abc");
      const error = yield* h.send({ attachments, resend: { kind: "dispatch", command: dispatch } });
      expect(error.reason).toBe("review");

      const review = yield* h.service.review({ threadId: THREAD, messageId: MESSAGE });
      expect(review).toMatchObject({
        reviewId: error.reviewId,
        plugins: ["Plugin rewrite"],
        original: {
          text: "my password is hunter2",
          attachments: [{ id: attachmentId, name: "notes.txt", text: "token=abc" }],
        },
        proposed: { text: "[redacted]" },
        placeholders: [],
      });

      const resend = yield* h.service.confirm({
        reviewId: review!.reviewId,
        content: {
          text: "my password is [edited]",
          attachments: [{ id: attachmentId, name: "notes.txt", text: "token=***" }],
        },
      });
      expect(resend.kind === "dispatch" && resend.command).toMatchObject({
        type: "message.dispatch",
        text: "my password is [edited]",
        attachments: [{ id: attachmentId, sizeBytes: 9 }],
      });
      expect(yield* h.fs.readFileString(file)).toBe("token=***");
      expect(yield* h.service.review({ threadId: THREAD, messageId: MESSAGE })).toBeNull();
      // A hook that returns no map leaves the thread without one.
      expect(yield* h.service.placeholders(THREAD)).toEqual({});
      expect(
        (yield* h.service
          .confirm({ reviewId: review!.reviewId, content: review!.proposed })
          .pipe(Effect.flip)).reason,
      ).toBe("blocked");
    }).pipe(Effect.provide(dependencies)),
);

it.live("discard drops the held review", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.enable("rewrite");
    const error = yield* h.send({ resend: { kind: "dispatch", command: dispatch } });
    yield* h.service.discard(error.reviewId!);
    expect(yield* h.service.review({ threadId: THREAD, messageId: MESSAGE })).toBeNull();
  }).pipe(Effect.provide(dependencies)),
);

it.live(
  "a plugin with setup is not ready until its setup exits 0, and cannot be turned on before",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const folder = h.path.join(h.cache, "setup", "1.0.0");
      const data = h.path.join(h.config.stateDir, "plugins", "data", "setup");
      const setupOf = (listed: { plugins: ReadonlyArray<{ id: string; setup?: unknown }> }) =>
        listed.plugins.find((plugin) => plugin.id === "setup")?.setup;

      const installed = yield* h.service.install({ id: "setup" });
      expect(setupOf(installed)).toEqual({ description: SETUP_DESCRIPTION, status: "needed" });
      expect(
        yield* h.service.setEnabled({ id: "setup", enabled: true }).pipe(Effect.flip),
      ).toMatchObject({ reason: "setup" });
      expect(
        (yield* h.service
          .setEnabled({ id: "setup", enabled: true, projectId: PROJECT })
          .pipe(Effect.flip)).reason,
      ).toBe("setup");

      yield* h.fs.makeDirectory(data, { recursive: true });
      yield* h.fs.writeFileString(h.path.join(data, "fail"), "");
      yield* h.service.setup({ id: "setup" });
      yield* h.service.setupDone("setup");
      expect(setupOf(yield* h.service.list({}))).toEqual({
        description: SETUP_DESCRIPTION,
        status: "failed",
        reason: "Plugin setup's setup failed (exit 4): error: told to fail",
      });
      expect(
        (yield* h.service.setEnabled({ id: "setup", enabled: true }).pipe(Effect.flip)).reason,
      ).toBe("setup");

      yield* h.fs.remove(h.path.join(data, "fail"));
      yield* h.service.setup({ id: "setup" });
      yield* h.service.setupDone("setup");
      expect(setupOf(yield* h.service.list({}))).toEqual({
        description: SETUP_DESCRIPTION,
        status: "ready",
      });
      expect((yield* h.fs.readFileString(h.path.join(data, "marker"))).trim()).toBe(
        yield* h.fs.realPath(folder),
      );
      expect(yield* h.fs.readFileString(h.path.join(data, "stdin"))).toBe("");
      const enabled = yield* h.service.setEnabled({ id: "setup", enabled: true });
      expect(enabled.plugins.find((plugin) => plugin.id === "setup")?.state).toBe("on");
      yield* h.service.checkBeforeSend({
        projectId: PROJECT,
        threadId: THREAD,
        messageId: MESSAGE,
        text: "hello",
        attachments: [],
        source: "web",
      });

      const other = h.path.join(h.config.stateDir, "plugins", "data", "other");
      yield* h.fs.makeDirectory(other, { recursive: true });
      yield* h.service.remove({ id: "setup", deleteData: true });
      expect(yield* h.fs.exists(data)).toBe(false);
      expect(yield* h.fs.exists(other)).toBe(true);
    }).pipe(Effect.provide(dependencies)),
);

it.live("removing keeps the data folder unless asked, and a reinstall needs setup again", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const data = h.path.join(h.config.stateDir, "plugins", "data", "setup");
    yield* h.service.install({ id: "setup" });
    yield* h.service.setup({ id: "setup" });
    yield* h.service.setupDone("setup");
    yield* h.service.remove({ id: "setup" });
    expect(yield* h.fs.exists(h.path.join(data, "marker"))).toBe(true);
    const again = yield* h.service.install({ id: "setup" });
    expect(again.plugins.find((plugin) => plugin.id === "setup")?.setup).toMatchObject({
      status: "needed",
    });
  }).pipe(Effect.provide(dependencies)),
);

it.effect("setup runs like a hook but without the message, and a timeout leaves it not ready", () =>
  Effect.gen(function* () {
    const inputs: ProcessRunner.ProcessRunInput[] = [];
    const h = yield* harness(
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) => {
          inputs.push(input);
          return Effect.succeed(TIMED_OUT);
        },
      }),
    );
    yield* h.service.install({ id: "setup" });
    yield* h.service.setup({ id: "setup" });
    yield* h.service.setupDone("setup");
    const listed = yield* h.service.list({});
    expect(listed.plugins.find((plugin) => plugin.id === "setup")?.setup).toMatchObject({
      status: "failed",
      reason: "Plugin setup's setup did not finish within 60 minutes. Set it up again to continue.",
    });
    const folder = h.path.join(h.cache, "setup", "1.0.0");
    expect(inputs[0]).toMatchObject({ cwd: folder, stdin: "", timeout: Duration.minutes(60) });
    expect(inputs[0]?.env).toBeUndefined();
    expect(
      (yield* h.service.setEnabled({ id: "setup", enabled: true }).pipe(Effect.flip)).reason,
    ).toBe("setup");
  }).pipe(Effect.provide(dependencies)),
);

it.effect("a plugin turned on before it declared setup stops sends until it is set up", () =>
  Effect.gen(function* () {
    const h = yield* harness(
      Layer.succeed(ProcessRunner.ProcessRunner, { run: () => Effect.die("no hook should run") }),
    );
    yield* h.service.install({ id: "setup" });
    yield* h.fs.writeFileString(
      h.path.join(h.config.stateDir, "plugins", "settings.json"),
      JSON.stringify({ enabled: { setup: true }, projects: {} }),
    );
    const listed = yield* h.service.list({});
    expect(listed.plugins.find((plugin) => plugin.id === "setup")?.state).toBe("missing");
    expect((yield* h.send()).message).toBe(
      "Plugin setup is turned on but not set up, so the message was not sent. Set it up in Settings, Plugins.",
    );
  }).pipe(Effect.provide(dependencies)),
);

const scriptedRunner = (answer: (stdin: Record<string, unknown>) => object, seen: unknown[]) =>
  Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input) => {
      const stdin = JSON.parse(input.stdin ?? "{}") as Record<string, unknown>;
      seen.push(stdin);
      return Effect.succeed({
        stdout: JSON.stringify(answer(stdin)),
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
    },
  });

// Replaces each known name with its placeholder, numbering new ones after the map's, as redact does.
const NAMES = ["Maren Holloway", "Jonas Brekke"];
const namingHook = (stdin: Record<string, unknown>) => {
  const known = { ...(stdin.placeholders as Record<string, string>) };
  let text = (stdin.message as { text: string }).text;
  for (const name of NAMES) {
    if (!text.includes(name)) continue;
    const placeholder =
      Object.keys(known).find((key) => known[key] === name) ??
      `[PERSON_${Object.keys(known).length + 1}]`;
    known[placeholder] = name;
    text = text.replaceAll(name, placeholder);
  }
  return { decision: "rewrite", message: { text }, placeholders: known };
};

it.live(
  "a thread keeps one placeholder per person across sends, stored mode 600 until it is forgotten",
  () =>
    Effect.gen(function* () {
      const seen: Array<Record<string, unknown>> = [];
      const h = yield* harness(scriptedRunner(namingHook, seen));
      yield* h.enable("rewrite");
      const sendAndConfirm = Effect.fn("test.sendAndConfirm")(function* (
        text: string,
        messageId: string,
      ) {
        const id = MessageId.make(messageId);
        yield* h.send({ text, messageId: id, resend: { kind: "dispatch", command: dispatch } });
        const review = (yield* h.service.review({ threadId: THREAD, messageId: id }))!;
        const resend = yield* h.service.confirm({
          reviewId: review.reviewId,
          content: review.proposed,
        });
        return { review, resend };
      });

      const first = yield* sendAndConfirm("Lease for Maren Holloway.", "m-1");
      expect(seen[0]!.placeholders).toEqual({});
      expect(first.review.placeholders).toEqual([
        { placeholder: "[PERSON_1]", value: "Maren Holloway", new: true },
      ]);

      const second = yield* sendAndConfirm("Jonas Brekke owes Maren Holloway.", "m-2");
      expect(seen[1]!.placeholders).toEqual({ "[PERSON_1]": "Maren Holloway" });
      expect(second.review.proposed.text).toBe("[PERSON_2] owes [PERSON_1].");
      expect(second.review.placeholders).toEqual([
        { placeholder: "[PERSON_2]", value: "Jonas Brekke", new: true },
        { placeholder: "[PERSON_1]", value: "Maren Holloway", new: false },
      ]);
      // What goes on to the provider carries placeholders only.
      const sent = JSON.stringify(second.resend);
      for (const name of NAMES) expect(sent).not.toContain(name);

      expect(yield* h.service.placeholders(THREAD)).toEqual({
        "[PERSON_1]": "Maren Holloway",
        "[PERSON_2]": "Jonas Brekke",
      });
      expect(yield* h.service.placeholderThreads).toEqual([THREAD]);
      const folder = h.path.join(h.config.stateDir, "plugins", "placeholders");
      const [file] = yield* h.fs.readDirectory(folder);
      expect((yield* h.fs.stat(h.path.join(folder, file!))).mode & 0o777).toBe(0o600);
      const settings = yield* h.fs.readFileString(
        h.path.join(h.config.stateDir, "plugins", "settings.json"),
      );
      expect(settings).not.toContain("Maren");

      yield* h.service.forgetPlaceholders(THREAD);
      expect(yield* h.service.placeholders(THREAD)).toEqual({});
      expect(yield* h.fs.readDirectory(folder)).toEqual([]);
    }).pipe(Effect.provide(dependencies)),
);

it.live("a review numbered before another confirm took its placeholder must be sent again", () =>
  Effect.gen(function* () {
    const h = yield* harness(scriptedRunner(namingHook, []));
    yield* h.enable("rewrite");
    const held = [];
    for (const [text, id] of [
      ["Maren Holloway", "m-1"],
      ["Jonas Brekke", "m-2"],
    ] as const) {
      const messageId = MessageId.make(id);
      yield* h.send({ text, messageId, resend: { kind: "dispatch", command: dispatch } });
      held.push((yield* h.service.review({ threadId: THREAD, messageId }))!);
    }
    yield* h.service.confirm({ reviewId: held[0]!.reviewId, content: held[0]!.proposed });
    const error = yield* h.service
      .confirm({ reviewId: held[1]!.reviewId, content: held[1]!.proposed })
      .pipe(Effect.flip);
    expect(error.message).toContain("Send this message again");
    expect(yield* h.service.placeholders(THREAD)).toEqual({ "[PERSON_1]": "Maren Holloway" });
  }).pipe(Effect.provide(dependencies)),
);

// Reads the file the host points it at and answers with its text redacted, as redact does.
const SECRETS = ["Maren Holloway", "110105194912310021"];
const fileHook = (stdin: Record<string, unknown>) => {
  const placeholders = { "[PERSON_1]": SECRETS[0]!, "[ID_1]": SECRETS[1]! };
  const redact = (value: string) =>
    value.replaceAll(SECRETS[0]!, "[PERSON_1]").replaceAll(SECRETS[1]!, "[ID_1]");
  const unshown = stdin.unshownAttachments as Array<{ id: string; name: string; path?: string }>;
  return {
    decision: "rewrite",
    message: {
      text: redact((stdin.message as { text: string }).text),
      attachments: unshown.map((file) => ({
        id: file.id,
        name: `${file.name}.txt`,
        // A hook told no path still tries to answer with some text for the file.
        text:
          file.path === undefined
            ? "unread"
            : redact(NodeFS.readFileSync(file.path, "utf8").replace("\u0000", "")),
      })),
    },
    placeholders,
  };
};

it.live(
  "a file a hook replaced goes on as a new text upload and the file itself is deleted, not sent",
  () =>
    Effect.gen(function* () {
      const seen: Array<Record<string, unknown>> = [];
      const h = yield* harness(scriptedRunner(fileHook, seen));
      yield* h.enable("files");
      const cases = [
        ["lease.docx", "docx", "application/octet-stream"],
        ["intake.pdf", "pdf", "application/pdf"],
      ] as const;
      const attachments: ChatAttachment[] = [];
      const files: string[] = [];
      for (const [name, extension, mimeType] of cases) {
        const body = `Tenant ${SECRETS[0]}, ID ${SECRETS[1]}.`;
        const attachment = {
          type: "file",
          id: createPendingAttachmentId(extension),
          name,
          mimeType,
          sizeBytes: body.length,
        } as unknown as ChatAttachment;
        const file = resolveAttachmentPath({
          attachmentsDir: h.config.attachmentsDir,
          attachment,
        })!;
        yield* h.fs.makeDirectory(h.path.dirname(file), { recursive: true });
        // Stands for a binary file; the NUL keeps it from being shown as text.
        yield* h.fs.writeFileString(file, `${body}\u0000`);
        // Text the server extracted beside the upload must go too.
        yield* h.fs.writeFileString(`${file}.txt`, body);
        attachments.push(attachment);
        files.push(file);
      }
      const error = yield* h.send({
        text: `Summarise these for ${SECRETS[0]}.`,
        attachments,
        resend: { kind: "dispatch", command: dispatch },
      });
      expect(error.reason).toBe("review");
      expect((seen[0]!.unshownAttachments as unknown[])[0]).toEqual({
        id: attachments[0]!.id,
        name: "lease.docx",
        mimeType: "application/octet-stream",
        sizeBytes: attachments[0]!.sizeBytes,
        path: files[0],
      });

      const review = (yield* h.service.review({ threadId: THREAD, messageId: MESSAGE }))!;
      expect(review.original.attachments).toEqual([]);
      expect(review.replacedFiles).toEqual([
        { id: attachments[0]!.id, name: "lease.docx" },
        { id: attachments[1]!.id, name: "intake.pdf" },
      ]);
      expect(review.proposed).toEqual({
        text: "Summarise these for [PERSON_1].",
        attachments: [
          { id: attachments[0]!.id, name: "lease.docx.txt", text: "Tenant [PERSON_1], ID [ID_1]." },
          { id: attachments[1]!.id, name: "intake.pdf.txt", text: "Tenant [PERSON_1], ID [ID_1]." },
        ],
      });
      expect(review.placeholders.map((item) => item.placeholder)).toEqual(["[PERSON_1]", "[ID_1]"]);

      // The person edits the first file's text and leaves the second as proposed.
      const resend = yield* h.service.confirm({
        reviewId: review.reviewId,
        content: {
          text: review.proposed.text,
          attachments: [{ ...review.proposed.attachments[0]!, text: "Tenant [PERSON_1]." }],
        },
      });
      const sent =
        resend.kind === "dispatch" && resend.command.type === "message.dispatch"
          ? (resend.command.attachments ?? [])
          : [];
      expect(sent.map(({ type, name, mimeType }) => ({ type, name, mimeType }))).toEqual([
        { type: "file", name: "lease.docx.txt", mimeType: "text/plain" },
        { type: "file", name: "intake.pdf.txt", mimeType: "text/plain" },
      ]);
      const texts = [];
      for (const attachment of sent) {
        expect(attachment.id).toMatch(/^pending-[0-9a-f-]+-txt$/);
        const file = resolveAttachmentPath({
          attachmentsDir: h.config.attachmentsDir,
          attachment,
        })!;
        texts.push(yield* h.fs.readFileString(file));
        expect(attachment.sizeBytes).toBe(texts.at(-1)!.length);
      }
      expect(texts).toEqual(["Tenant [PERSON_1].", "Tenant [PERSON_1], ID [ID_1]."]);
      const out = JSON.stringify(resend) + texts.join("");
      for (const secret of SECRETS) expect(out).not.toContain(secret);
      for (const file of files) {
        expect(yield* h.fs.exists(file)).toBe(false);
        expect(yield* h.fs.exists(`${file}.txt`)).toBe(false);
      }
      expect(yield* h.service.placeholders(THREAD)).toEqual({
        "[PERSON_1]": SECRETS[0],
        "[ID_1]": SECRETS[1],
      });
    }).pipe(Effect.provide(dependencies)),
);

it.live("a hook that does not read files cannot replace one, and the send stops", () =>
  Effect.gen(function* () {
    const h = yield* harness(scriptedRunner(fileHook, []));
    yield* h.enable("rewrite");
    const attachment = {
      type: "file",
      id: createPendingAttachmentId("docx"),
      name: "lease.docx",
      mimeType: "application/octet-stream",
      sizeBytes: 3,
    } as unknown as ChatAttachment;
    const file = resolveAttachmentPath({ attachmentsDir: h.config.attachmentsDir, attachment })!;
    yield* h.fs.makeDirectory(h.path.dirname(file), { recursive: true });
    yield* h.fs.writeFile(file, new Uint8Array([0, 1, 2]));
    const error = yield* h.send({
      attachments: [attachment],
      resend: { kind: "dispatch", command: dispatch },
    });
    expect(error).toMatchObject({
      reason: "blocked",
      message: expect.stringContaining("no usable answer"),
    });
  }).pipe(Effect.provide(dependencies)),
);

it.effect("python3 falls back to py -3, then python, on Windows only, past a Store stub", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agentd-hook-path-" });
    const stubs = path.join(root, "Microsoft", "WindowsApps");
    const store = path.join(root, "store", "Microsoft", "WindowsApps");
    yield* fs.makeDirectory(path.join(store, "PythonSoftwareFoundation.Python.3.12_x"), {
      recursive: true,
    });
    const file = Effect.fnUntraced(function* (dir: string, name: string) {
      const target = path.join(dir, name);
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(target, "");
      yield* fs.chmod(target, 0o755);
      return target;
    });
    const python3 = yield* file(path.join(root, "python3"), "python3.exe");
    const py = yield* file(path.join(root, "py"), "py.exe");
    const python = yield* file(path.join(root, "python"), "python.exe");
    const posix = yield* file(path.join(root, "posix"), "python3");
    yield* file(stubs, "python3.exe");
    yield* file(stubs, "python.exe");
    const storePython3 = yield* file(store, "python3.exe");
    const find = (platform: NodeJS.Platform, dirs: ReadonlyArray<string>) =>
      AgentdPlugins.findHookProgram(
        platform,
        { PATH: dirs.join(platform === "win32" ? ";" : ":"), PATHEXT: ".EXE" },
        "python3",
        ["hook.py"],
      );
    const dir = (name: string) => path.join(root, name);
    const cases: ReadonlyArray<
      readonly [NodeJS.Platform, ReadonlyArray<string>, { command: string; args: string[] } | null]
    > = [
      ["win32", [dir("py")], { command: py, args: ["-3", "hook.py"] }],
      ["win32", [dir("py"), dir("python3")], { command: python3, args: ["hook.py"] }],
      ["win32", [stubs, dir("py")], { command: py, args: ["-3", "hook.py"] }],
      ["win32", [stubs, dir("python")], { command: python, args: ["hook.py"] }],
      ["win32", [store, dir("py")], { command: storePython3, args: ["hook.py"] }],
      ["win32", [stubs], null],
      ["win32", [], null],
      ["linux", [dir("py"), dir("python")], null],
      ["linux", [dir("posix")], { command: posix, args: ["hook.py"] }],
    ];
    for (const [platform, dirs, expected] of cases) {
      expect(yield* find(platform, dirs), `${platform} ${dirs.join(" ")}`).toEqual(expected);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("attaches a plugin's MCP servers to Claude and Codex launches only where it is on", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const SENTINEL = "sentinel-key-6f1e2d";
    const other = ProjectId.make("project-2");
    yield* h.service.install({ id: "mcp" });
    const listed = (yield* h.service.list({})).plugins.find((plugin) => plugin.id === "mcp");
    expect(listed).toMatchObject({
      hooks: [],
      mcpServers: [
        {
          name: "outreach",
          command: "./server.sh",
          args: ["mcp"],
          env: ["OUTREACH_LOG", "OUTREACH_URL", "OUTREACH_API_KEY_FILE"],
          missing: ["outreach_url", "outreach_token"],
        },
      ],
      settings: [
        { name: "outreach_url", secret: false, set: false },
        { name: "outreach_token", secret: true, set: false },
      ],
    });
    yield* h.service.setEnabled({ id: "mcp", enabled: true });
    // On, but a server missing a setting is not given to anyone.
    expect(yield* h.service.mcpServers(PROJECT)).toEqual({});

    const saved = yield* h.service.setSettings({
      id: "mcp",
      values: { outreach_url: "https://outreach.example", outreach_token: SENTINEL },
    });
    expect(saved.plugins.find((plugin) => plugin.id === "mcp")?.settings).toEqual([
      {
        name: "outreach_url",
        label: "Outreach URL",
        secret: false,
        value: "https://outreach.example",
        set: true,
      },
      { name: "outreach_token", label: "API key", secret: true, set: true },
    ]);
    expect(
      (yield* h.service.setSettings({ id: "mcp", values: { nope: "x" } }).pipe(Effect.flip)).reason,
    ).toBe("invalid");
    yield* h.service.setEnabled({ id: "mcp", enabled: false, projectId: other });

    const servers = yield* h.service.mcpServers(PROJECT);
    const keyFile = h.path.join(
      h.config.stateDir,
      "plugins",
      "secret-files",
      "mcp",
      "outreach_token",
    );
    expect(servers).toEqual({
      outreach: {
        command: h.path.join(h.cache, "mcp", "1.0.0", "server.sh"),
        args: ["mcp"],
        env: {
          OUTREACH_LOG: "quiet",
          OUTREACH_URL: "https://outreach.example",
          OUTREACH_API_KEY_FILE: keyFile,
        },
      },
    });
    expect(yield* h.fs.readFileString(keyFile)).toBe(SENTINEL);
    expect((yield* h.fs.stat(keyFile)).mode & 0o777).toBe(0o600);
    expect(yield* h.service.mcpServers(other)).toEqual({});

    const mcpSession = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: THREAD,
      providerSessionId: "mcp-session-1",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer t",
      browserToolsAvailable: true,
    };
    const launches = (pluginMcpServers: typeof servers) => ({
      claude: ClaudeAdapterV2.claudeMcpQueryOverrides({
        mcpSession,
        readOnlySandbox: false,
        pluginMcpServers,
      }).mcpServers,
      codex: CodexAdapterV2.codexThreadRuntimeParams({
        threadId: THREAD,
        mcpSession,
        pluginMcpServers,
      }).config,
    });
    const on = launches(servers);
    expect(on.claude?.outreach).toEqual({ type: "stdio", ...servers.outreach });
    expect(on.codex["mcp_servers.outreach"]).toEqual({
      ...servers.outreach,
      env: { ...servers.outreach!.env, T3CODE_THREAD_ID: THREAD },
    });
    const off = launches(yield* h.service.mcpServers(other));
    expect(off.claude).not.toHaveProperty("outreach");
    expect(off.codex).not.toHaveProperty("mcp_servers.outreach");

    // The key is only in the secret store and the server's key file: not in a setting, the
    // listing a client gets, or what either provider is launched with.
    const settingsText = yield* h.fs.readFileString(
      h.path.join(h.config.stateDir, "plugins", "settings.json"),
    );
    for (const seen of [
      settingsText,
      JSON.stringify(yield* h.service.list({ projectId: PROJECT })),
      JSON.stringify(on),
    ]) {
      expect(seen).not.toContain(SENTINEL);
    }
    // Nothing is written to the user's own agent configuration in this run's home.
    for (const file of [".claude.json", ".claude/settings.json", ".codex/config.toml"]) {
      expect(yield* h.fs.exists(h.path.join(h.config.baseDir, file))).toBe(false);
    }

    yield* h.service.remove({ id: "mcp" });
    expect(yield* h.fs.exists(keyFile)).toBe(false);
    yield* h.service.install({ id: "mcp" });
    expect(
      (yield* h.service.list({})).plugins.find((plugin) => plugin.id === "mcp")?.settings,
    ).toMatchObject([{ set: false }, { set: false }]);
  }).pipe(Effect.provide(dependencies)),
);
