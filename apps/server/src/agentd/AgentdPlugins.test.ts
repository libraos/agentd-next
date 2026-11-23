import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
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
};
const manifest = (id: string) =>
  JSON.stringify({
    schemaVersion: 1,
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    hooks: { "before-send": { command: ["./hook.sh"] } },
  });
const REPO_FILES: Record<string, Uint8Array> = Object.fromEntries(
  Object.entries(HOOKS).flatMap(([id, script]) => [
    [`plugins/${id}/agentd-plugin.json`, text(manifest(id))],
    [`plugins/${id}/hook.sh`, text(script)],
  ]),
);
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
const CATALOG = JSON.stringify({ version: 1, plugins: Object.keys(HOOKS).map(entry) });
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

const timedOutRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: () =>
    Effect.succeed({
      stdout: "",
      stderr: "",
      code: null,
      timedOut: true,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
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
    const service = yield* AgentdPlugins.AgentdPluginsService.pipe(
      Effect.provide(
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
      ),
    );
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

const dependencies = ServerConfig.layerTest("/tmp", { prefix: "agentd-plugins-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
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
      unshownAttachments: [{ id: binaryId, name: "scan.pdf" }],
    });
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
