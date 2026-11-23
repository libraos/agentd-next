// @effect-diagnostics nodeBuiltinImport:off -- Pure path checks must follow the host OS's rules, which the Effect Path layer does not by default.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  GatewayMediaFailure,
  type GatewayMediaAudioInput,
  type GatewayMediaFileResult,
  type GatewayMediaJobResult,
  type GatewayMediaModelsInput,
  type GatewayMediaModelsResult,
  type GatewayMediaSpeechInput,
  type GatewayMediaTranscribeInput,
  type GatewayMediaTranscriptResult,
  type GatewayMediaVideoInput,
  type GatewayMediaVideoStatusInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { FetchHttpClient, HttpClient } from "effect/http";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { CustomGateway, type CustomGatewayConnection } from "./CustomGateway.ts";
import {
  MEDIA_MAX_WAIT,
  audioContentPath,
  detectVideoDialect,
  downloadTo,
  listModels,
  pollAudio,
  pollInterval,
  latestVideo,
  pollVideo,
  speech as requestSpeech,
  submitAudio,
  submitVideo,
  transcribe as requestTranscript,
  videoContentPath,
  waitForJob,
  type MediaJob,
} from "./GatewayMediaClient.ts";
import { customGatewayInstanceIds } from "./gatewaySetup.ts";

const failure = (code: GatewayMediaFailure["code"], message: string) =>
  new GatewayMediaFailure({ code, message });

/** The requested gateway, else the one the thread runs on, else the only one. */
export function chooseGateway(
  gateways: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  requested: string | undefined,
  threadInstanceId: string,
): Result.Result<string, GatewayMediaFailure> {
  if (gateways.length === 0) {
    return Result.fail(failure("no_gateway", "Add a custom gateway in Providers first."));
  }
  const names = gateways.map((gateway) => gateway.name).join(", ");
  if (requested !== undefined) {
    const wanted = requested.trim().toLowerCase();
    const match =
      gateways.find((gateway) => gateway.id === requested.trim()) ??
      gateways.find((gateway) => gateway.name.toLowerCase() === wanted);
    return match === undefined
      ? Result.fail(
          failure("no_gateway", `No custom gateway is called ${requested}. Gateways: ${names}.`),
        )
      : Result.succeed(match.id);
  }
  const running = gateways.find((gateway) =>
    Object.values(customGatewayInstanceIds(gateway.id)).some((id) => id === threadInstanceId),
  );
  if (running !== undefined) return Result.succeed(running.id);
  const only = gateways.length === 1 ? gateways[0] : undefined;
  if (only !== undefined) return Result.succeed(only.id);
  return Result.fail(
    failure("ambiguous_gateway", `Pass gateway: this thread runs on none of ${names}.`),
  );
}

const OUTSIDE = "Save media inside the thread's workspace.";

/** `requested` resolved against `workspace`, if it stays inside it. */
function insideWorkspace(
  workspace: string,
  requested: string,
  refusal: string,
): Result.Result<string, GatewayMediaFailure> {
  const target = NodePath.resolve(workspace, requested);
  const relative = NodePath.relative(workspace, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  ) {
    return Result.fail(failure("invalid_request", refusal));
  }
  return Result.succeed(target);
}

/** An unused file inside the workspace: default `generated-media/`, a taken name gets `-1`, `-2`. */
export function resolveOutputPath(
  workspace: string,
  requested: string | undefined,
  fallbackName: string,
  exists: (file: string) => boolean,
): Result.Result<string, GatewayMediaFailure> {
  return Result.map(
    insideWorkspace(
      workspace,
      requested ?? NodePath.join("generated-media", fallbackName),
      OUTSIDE,
    ),
    (target) => {
      const extension = NodePath.extname(target);
      const stem = target.slice(0, target.length - extension.length);
      let candidate = target;
      for (let n = 1; exists(candidate); n += 1) candidate = `${stem}-${n}${extension}`;
      return candidate;
    },
  );
}

const fileSafe = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "media";

export class GatewayMedia extends Context.Service<
  GatewayMedia,
  {
    readonly video: (
      scope: McpInvocationScope,
      input: GatewayMediaVideoInput,
    ) => Effect.Effect<GatewayMediaJobResult, GatewayMediaFailure>;
    readonly videoStatus: (
      scope: McpInvocationScope,
      input: GatewayMediaVideoStatusInput,
    ) => Effect.Effect<GatewayMediaJobResult, GatewayMediaFailure>;
    readonly speech: (
      scope: McpInvocationScope,
      input: GatewayMediaSpeechInput,
    ) => Effect.Effect<GatewayMediaFileResult, GatewayMediaFailure>;
    readonly transcribe: (
      scope: McpInvocationScope,
      input: GatewayMediaTranscribeInput,
    ) => Effect.Effect<GatewayMediaTranscriptResult, GatewayMediaFailure>;
    readonly audio: (
      scope: McpInvocationScope,
      input: GatewayMediaAudioInput,
    ) => Effect.Effect<GatewayMediaJobResult, GatewayMediaFailure>;
    readonly models: (
      scope: McpInvocationScope,
      input: GatewayMediaModelsInput,
    ) => Effect.Effect<GatewayMediaModelsResult, GatewayMediaFailure>;
  }
>()("t3/gateway/GatewayMedia") {}

const make = Effect.fn("GatewayMedia.make")(function* () {
  const gateways = yield* CustomGateway;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;

  const withServices = <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient | FileSystem.FileSystem>,
  ) =>
    effect.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(FileSystem.FileSystem, fs),
    );

  const threadOf = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.fail(
          failure(
            "thread_required",
            "Media tools save into a thread's workspace, so they need an agent running inside AgentD Next.",
          ),
        )
      : Effect.succeed(scope.thread);

  const workspaceOf = Effect.fn("GatewayMedia.workspaceOf")(function* (scope: McpInvocationScope) {
    const caller = yield* threadOf(scope);
    const unreadable = () => failure("invalid_request", "Could not read this thread's workspace.");
    const { thread } = yield* threads
      .getThreadRecords(caller.threadId, [])
      .pipe(Effect.mapError(unreadable));
    if (thread.worktreePath !== null) return thread.worktreePath;
    const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unreadable));
    if (Option.isNone(project)) return yield* unreadable();
    return project.value.workspaceRoot;
  });

  const connectionOf = Effect.fn("GatewayMedia.connectionOf")(function* (
    scope: McpInvocationScope,
    requested: string | undefined,
  ) {
    const caller = yield* threadOf(scope);
    const { gateways: listed } = yield* gateways.list.pipe(
      Effect.mapError((error) => failure("gateway_error", error.message)),
    );
    const id = yield* Effect.fromResult(
      chooseGateway(listed, requested, caller.providerInstanceId),
    );
    return yield* gateways
      .connection(id)
      .pipe(Effect.mapError((error) => failure("gateway_error", error.message)));
  });

  const outputFile = Effect.fn("GatewayMedia.outputFile")(function* (
    workspace: string,
    requested: string | undefined,
    fallbackName: string,
  ) {
    const file = yield* Effect.fromResult(
      resolveOutputPath(workspace, requested, fallbackName, NodeFS.existsSync),
    );
    yield* fs
      .makeDirectory(NodePath.dirname(file), { recursive: true })
      .pipe(Effect.mapError(() => failure("invalid_request", "Could not make the folder.")));
    return file;
  });

  const shown = (workspace: string, file: string) =>
    NodePath.relative(workspace, file).split(NodePath.sep).join("/");

  const timestamp = DateTime.now.pipe(
    Effect.map((now) => DateTime.formatIso(now).replace(/[:.]/g, "-").slice(0, 19)),
  );

  const finishJob = Effect.fn("GatewayMedia.finishJob")(function* (options: {
    readonly connection: CustomGatewayConnection;
    readonly workspace: string;
    readonly job: MediaJob;
    readonly poll: (id: string) => Effect.Effect<MediaJob, GatewayMediaFailure>;
    readonly pollEvery: Duration.Duration;
    readonly contentPath: (id: string) => string;
    readonly extension: string;
    readonly outputPath: string | undefined;
    readonly seconds: number | undefined;
    readonly model: string | undefined;
  }) {
    const job = yield* waitForJob(options.job, options.poll, {
      maxWait: MEDIA_MAX_WAIT,
      pollEvery: options.pollEvery,
    });
    const base = {
      jobId: job.id,
      seconds: job.seconds ?? options.seconds ?? null,
      model: options.model ?? job.model,
      costUsd: job.costUsd,
      gateway: options.connection.name,
    };
    if (job.status !== "completed") return { ...base, status: "in_progress", path: null } as const;
    const file = yield* outputFile(
      options.workspace,
      options.outputPath,
      `${fileSafe(job.id)}.${options.extension}`,
    );
    yield* withServices(downloadTo(options.connection, options.contentPath(job.id), file));
    return { ...base, status: "completed", path: shown(options.workspace, file) } as const;
  });

  const videoJob = Effect.fn("GatewayMedia.videoJob")(function* (
    scope: McpInvocationScope,
    requested: { readonly gateway?: string | undefined; readonly outputPath?: string | undefined },
    start: (
      connection: CustomGatewayConnection,
      dialect: "openai" | "openrouter",
    ) => Effect.Effect<MediaJob, GatewayMediaFailure>,
    seconds: number | undefined,
    model: string | undefined,
  ) {
    const workspace = yield* workspaceOf(scope);
    const connection = yield* connectionOf(scope, requested.gateway);
    // Refused before anything is sent or paid for.
    yield* Effect.fromResult(
      resolveOutputPath(workspace, requested.outputPath, "check.mp4", () => false),
    );
    const dialect = yield* withServices(detectVideoDialect(connection));
    const job = yield* start(connection, dialect);
    return yield* finishJob({
      connection,
      workspace,
      job,
      poll: (id) => withServices(pollVideo(connection, id)),
      pollEvery: pollInterval(dialect),
      contentPath: videoContentPath,
      extension: "mp4",
      outputPath: requested.outputPath,
      seconds,
      model,
    });
  });

  const video: GatewayMedia["Service"]["video"] = (scope, input) =>
    videoJob(
      scope,
      input,
      (connection, dialect) => withServices(submitVideo(connection, dialect, input)),
      input.seconds,
      input.model,
    );

  const videoStatus: GatewayMedia["Service"]["videoStatus"] = (scope, input) =>
    videoJob(
      scope,
      input,
      (connection) =>
        withServices(
          input.jobId === undefined ? latestVideo(connection) : pollVideo(connection, input.jobId),
        ),
      undefined,
      undefined,
    );

  const audio: GatewayMedia["Service"]["audio"] = Effect.fn("GatewayMedia.audio")(
    function* (scope, input) {
      const workspace = yield* workspaceOf(scope);
      const connection = yield* connectionOf(scope, input.gateway);
      yield* Effect.fromResult(
        resolveOutputPath(workspace, input.outputPath, "check.mp3", () => false),
      );
      const job = yield* withServices(submitAudio(connection, input));
      return yield* finishJob({
        connection,
        workspace,
        job,
        poll: (id) => withServices(pollAudio(connection, id)),
        pollEvery: pollInterval("openai"),
        contentPath: audioContentPath,
        extension: "mp3",
        outputPath: input.outputPath,
        seconds: input.seconds,
        model: input.model,
      });
    },
  );

  const speech: GatewayMedia["Service"]["speech"] = Effect.fn("GatewayMedia.speech")(
    function* (scope, input) {
      const workspace = yield* workspaceOf(scope);
      const connection = yield* connectionOf(scope, input.gateway);
      const file = yield* outputFile(
        workspace,
        input.outputPath,
        `speech-${yield* timestamp}.${input.format ?? "mp3"}`,
      );
      yield* withServices(requestSpeech(connection, input, file));
      return { path: shown(workspace, file), model: input.model, gateway: connection.name };
    },
  );

  const transcribe: GatewayMedia["Service"]["transcribe"] = Effect.fn("GatewayMedia.transcribe")(
    function* (scope, input) {
      const workspace = yield* workspaceOf(scope);
      const file = yield* Effect.fromResult(
        insideWorkspace(workspace, input.path, "Transcribe a file inside the thread's workspace."),
      );
      const bytes = yield* fs
        .readFile(file)
        .pipe(Effect.mapError(() => failure("invalid_request", `Could not read ${input.path}.`)));
      const connection = yield* connectionOf(scope, input.gateway);
      const text = yield* withServices(
        requestTranscript(connection, {
          bytes,
          fileName: NodePath.basename(file),
          model: input.model,
          language: input.language,
          translate: input.translate,
        }),
      );
      return { text, model: input.model, gateway: connection.name };
    },
  );

  const models: GatewayMedia["Service"]["models"] = Effect.fn("GatewayMedia.models")(
    function* (scope, input) {
      const connection = yield* connectionOf(scope, input.gateway);
      const listed = yield* withServices(listModels(connection));
      return { ...listed, gateway: connection.name };
    },
  );

  return GatewayMedia.of({ video, videoStatus, speech, transcribe, audio, models });
});

export const layer = Layer.effect(GatewayMedia, make()).pipe(Layer.provide(FetchHttpClient.layer));
