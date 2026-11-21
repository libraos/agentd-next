import {
  GatewayMediaFailure,
  type GatewayMediaAudioInput,
  type GatewayMediaSpeechInput,
  type GatewayMediaVideoInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import { redactGatewayText } from "./gatewaySetup.ts";

export interface MediaGatewayConnection {
  readonly name: string;
  readonly base: string;
  readonly key: string | null;
}

export type VideoDialect = "openai" | "openrouter";

export interface MediaWaitOptions {
  readonly maxWait: Duration.Duration;
  readonly pollEvery: Duration.Duration;
}

export interface MediaJob {
  readonly id: string;
  readonly status: "queued" | "in_progress" | "completed" | "failed";
  readonly seconds: number | null;
  /** As the gateway names it; null when its job does not say. */
  readonly model: string | null;
  readonly costUsd: number | null;
  readonly error: string | null;
}

export const MEDIA_MAX_WAIT = Duration.minutes(55);

export const pollInterval = (dialect: VideoDialect) =>
  dialect === "openrouter" ? Duration.seconds(30) : Duration.seconds(10);

const failure = (code: GatewayMediaFailure["code"], message: string) =>
  new GatewayMediaFailure({ code, message });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MESSAGE_LIMIT = 500;

/** The gateway's own reason for a refused request, else its status; never the key. */
function gatewayErrorMessage(c: MediaGatewayConnection, status: number, body: unknown): string {
  let text = "";
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.message === "string") text = error.message;
    else if (typeof error === "string") text = error;
    else if (typeof body.message === "string") text = body.message;
  } else if (typeof body === "string") {
    text = body;
  }
  const message = redactGatewayText(text.trim(), c.key);
  if (message === "") return `${c.name} answered HTTP ${status}.`;
  return message.length > MESSAGE_LIMIT ? `${message.slice(0, MESSAGE_LIMIT - 1)}…` : message;
}

const authorized = (c: MediaGatewayConnection, request: HttpClientRequest.HttpClientRequest) =>
  c.key === null ? request : HttpClientRequest.bearerToken(request, c.key);

const unreachable = (c: MediaGatewayConnection) => () =>
  failure("gateway_error", `Couldn't reach ${c.name} at ${new URL(c.base).host}.`);

/** Sends with the key; a redirect is not followed, since it could carry the key elsewhere. */
const send = Effect.fn("GatewayMedia.send")(function* (
  c: MediaGatewayConnection,
  request: HttpClientRequest.HttpClientRequest,
) {
  const http = yield* HttpClient.HttpClient;
  return yield* http
    .execute(authorized(c, request))
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(unreachable(c)),
    );
});

const readBody = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.map((text): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }),
    Effect.orElseSucceed((): unknown => undefined),
  );

const refused = (c: MediaGatewayConnection, response: HttpClientResponse.HttpClientResponse) =>
  readBody(response).pipe(
    Effect.flatMap((body) =>
      Effect.fail(failure("gateway_error", gatewayErrorMessage(c, response.status, body))),
    ),
  );

const isOk = (status: number) => status >= 200 && status < 300;

const requestJson = Effect.fn("GatewayMedia.requestJson")(function* (
  c: MediaGatewayConnection,
  request: HttpClientRequest.HttpClientRequest,
  options: { readonly notFound?: string } = {},
) {
  const response = yield* send(c, HttpClientRequest.acceptJson(request));
  if (response.status === 404 && options.notFound !== undefined) {
    return yield* failure("unsupported", options.notFound);
  }
  if (!isOk(response.status)) return yield* refused(c, response);
  return yield* readBody(response);
});

const dialects = new Map<string, VideoDialect>();

const isOpenRouterVideoModel = (entry: unknown) =>
  isRecord(entry) && ("supported_durations" in entry || "supported_resolutions" in entry);

const modelEntries = (body: unknown): ReadonlyArray<unknown> | null =>
  Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : null;

/** OpenRouter lists video models with their durations and resolutions; the OpenAI shape does not. */
export const detectVideoDialect = Effect.fn("GatewayMedia.detectVideoDialect")(function* (
  c: MediaGatewayConnection,
) {
  const known = dialects.get(c.base);
  if (known !== undefined) return known;
  const body = yield* requestJson(c, HttpClientRequest.get(`${c.base}/videos/models`)).pipe(
    Effect.orElseSucceed(() => null),
  );
  const entries = modelEntries(body);
  const dialect: VideoDialect =
    entries !== null && entries.some(isOpenRouterVideoModel) ? "openrouter" : "openai";
  dialects.set(c.base, dialect);
  return dialect;
});

const RESOLUTION_SHORT_SIDE: Record<string, number> = {
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
  "1440p": 1440,
  "2160p": 2160,
  "4k": 2160,
};

/** `720p` + `9:16` → `720x1280`: the resolution names the short side. */
function sizeOf(resolution: string | undefined, aspectRatio: string | undefined) {
  if (resolution === undefined) return undefined;
  const short = RESOLUTION_SHORT_SIDE[resolution.toLowerCase()];
  if (short === undefined) return undefined;
  const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio ?? "16:9");
  if (ratio === null) return undefined;
  const width = Number(ratio[1]);
  const height = Number(ratio[2]);
  if (!(width > 0 && height > 0)) return undefined;
  const even = (value: number) => Math.round(value / 2) * 2;
  return width >= height
    ? `${even((short * width) / height)}x${short}`
    : `${short}x${even((short * height) / width)}`;
}

const defined = (entries: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

export function videoRequestBody(
  dialect: VideoDialect,
  input: GatewayMediaVideoInput,
): Record<string, unknown> {
  if (dialect === "openrouter") {
    return defined({
      model: input.model,
      prompt: input.prompt,
      duration: input.seconds,
      resolution: input.resolution,
      aspect_ratio: input.aspectRatio,
      size: input.size,
      generate_audio: input.audio,
    });
  }
  // The OpenAI shape refuses duration, resolution and audio.
  return defined({
    model: input.model,
    prompt: input.prompt,
    seconds: String(input.seconds ?? 4),
    size: input.size ?? sizeOf(input.resolution, input.aspectRatio),
  });
}

const numberOf = (value: unknown): number | null => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
};

function readJob(body: unknown, fallbackId?: string): MediaJob | null {
  if (!isRecord(body)) return null;
  const id = typeof body.id === "string" ? body.id : fallbackId;
  if (id === undefined || id === "") return null;
  const raw = typeof body.status === "string" ? body.status.toLowerCase() : "queued";
  const errorText = isRecord(body.error)
    ? typeof body.error.message === "string"
      ? body.error.message
      : null
    : typeof body.error === "string"
      ? body.error
      : null;
  const status: MediaJob["status"] =
    raw === "completed" || raw === "succeeded"
      ? "completed"
      : raw === "failed" || raw === "cancelled" || raw === "canceled" || raw === "expired"
        ? "failed"
        : raw === "queued" || raw === "pending"
          ? "queued"
          : "in_progress";
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    id,
    status,
    seconds: numberOf(body.seconds) ?? numberOf(body.duration),
    model: typeof body.model === "string" && body.model !== "" ? body.model : null,
    costUsd: numberOf(usage.cost) ?? numberOf(body.cost),
    error: status === "failed" ? (errorText ?? raw) : null,
  };
}

const jobOf = (c: MediaGatewayConnection, fallbackId?: string) => (body: unknown) => {
  const job = readJob(body, fallbackId);
  return job === null
    ? Effect.fail(failure("gateway_error", `${c.name} answered with an unreadable job.`))
    : Effect.succeed(job);
};

export const submitVideo = Effect.fn("GatewayMedia.submitVideo")(function* (
  c: MediaGatewayConnection,
  dialect: VideoDialect,
  input: GatewayMediaVideoInput,
) {
  const request = HttpClientRequest.post(`${c.base}/videos`).pipe(
    HttpClientRequest.bodyJsonUnsafe(videoRequestBody(dialect, input)),
  );
  return yield* requestJson(c, request).pipe(Effect.flatMap(jobOf(c)));
});

const jobPath = (id: string) => encodeURIComponent(id);

export const pollVideo = Effect.fn("GatewayMedia.pollVideo")(function* (
  c: MediaGatewayConnection,
  id: string,
) {
  return yield* requestJson(c, HttpClientRequest.get(`${c.base}/videos/${jobPath(id)}`)).pipe(
    Effect.flatMap(jobOf(c, id)),
  );
});

/** This key's newest video, for a wait that ended before the job id reached the agent. */
export const latestVideo = Effect.fn("GatewayMedia.latestVideo")(function* (
  c: MediaGatewayConnection,
) {
  const body = yield* requestJson(
    c,
    HttpClientRequest.get(`${c.base}/videos`).pipe(
      HttpClientRequest.setUrlParams({ limit: "1", order: "desc" }),
    ),
  );
  const newest = modelEntries(body)?.[0];
  if (newest === undefined) {
    return yield* failure(
      "invalid_request",
      `${c.name} has no video for this key. Pass its job id.`,
    );
  }
  return yield* jobOf(c)(newest);
});

export const videoContentPath = (id: string) => `/videos/${jobPath(id)}/content`;

const AUDIO_UNSUPPORTED = "This gateway does not make music or sound effects.";

export const submitAudio = Effect.fn("GatewayMedia.submitAudio")(function* (
  c: MediaGatewayConnection,
  input: GatewayMediaAudioInput,
) {
  const request = HttpClientRequest.post(`${c.base}/audio/generations`).pipe(
    HttpClientRequest.bodyJsonUnsafe(
      defined({ model: input.model, prompt: input.prompt, seconds: input.seconds }),
    ),
  );
  return yield* requestJson(c, request, { notFound: AUDIO_UNSUPPORTED }).pipe(
    Effect.flatMap(jobOf(c)),
  );
});

export const pollAudio = Effect.fn("GatewayMedia.pollAudio")(function* (
  c: MediaGatewayConnection,
  id: string,
) {
  return yield* requestJson(
    c,
    HttpClientRequest.get(`${c.base}/audio/generations/${jobPath(id)}`),
    { notFound: AUDIO_UNSUPPORTED },
  ).pipe(Effect.flatMap(jobOf(c, id)));
});

export const audioContentPath = (id: string) => `/audio/generations/${jobPath(id)}/content`;

/**
 * Polls until the job is done. A failed job is a failure with the gateway's reason; one still
 * running at `maxWait` comes back as it is, so a later call can wait again.
 */
export const waitForJob = Effect.fn("GatewayMedia.waitForJob")(function* <R>(
  first: MediaJob,
  poll: (id: string) => Effect.Effect<MediaJob, GatewayMediaFailure, R>,
  options: MediaWaitOptions,
) {
  const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(options.maxWait);
  let job = first;
  while (true) {
    if (job.status === "failed") {
      return yield* failure("gateway_error", `The job failed: ${job.error ?? "failed"}`);
    }
    if (job.status === "completed") return job;
    if ((yield* Clock.currentTimeMillis) >= deadline) return job;
    yield* Effect.sleep(options.pollEvery);
    job = yield* poll(job.id);
  }
});

const saveResponse = Effect.fn("GatewayMedia.saveResponse")(function* (
  c: MediaGatewayConnection,
  response: HttpClientResponse.HttpClientResponse,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // `wx`: a file that appeared meanwhile is never overwritten.
  yield* response.stream.pipe(
    Stream.run(fs.sink(file, { flag: "wx" })),
    Effect.mapError(() => failure("gateway_error", `Could not save the file from ${c.name}.`)),
  );
});

/**
 * Saves `{base}{path}` to `file`. A redirect (a signed storage link) is followed once without the
 * key.
 */
export const downloadTo = Effect.fn("GatewayMedia.downloadTo")(function* (
  c: MediaGatewayConnection,
  path: string,
  file: string,
) {
  const response = yield* send(c, HttpClientRequest.get(`${c.base}${path}`));
  const location = response.headers.location;
  if (response.status >= 300 && response.status < 400 && location !== undefined) {
    const http = yield* HttpClient.HttpClient;
    const target = new URL(location, `${c.base}${path}`);
    const moved = yield* http
      .execute(HttpClientRequest.get(target))
      .pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(unreachable(c)),
      );
    if (!isOk(moved.status)) return yield* refused(c, moved);
    return yield* saveResponse(c, moved, file);
  }
  if (!isOk(response.status)) return yield* refused(c, response);
  return yield* saveResponse(c, response, file);
});

export const speech = Effect.fn("GatewayMedia.speech")(function* (
  c: MediaGatewayConnection,
  input: GatewayMediaSpeechInput,
  file: string,
) {
  const request = HttpClientRequest.post(`${c.base}/audio/speech`).pipe(
    HttpClientRequest.bodyJsonUnsafe(
      defined({
        model: input.model,
        input: input.text,
        voice: input.voice ?? "alloy",
        response_format: input.format,
      }),
    ),
  );
  const response = yield* send(c, request);
  if (!isOk(response.status)) return yield* refused(c, response);
  yield* saveResponse(c, response, file);
});

export const transcribe = Effect.fn("GatewayMedia.transcribe")(function* (
  c: MediaGatewayConnection,
  input: {
    readonly bytes: Uint8Array;
    readonly fileName: string;
    readonly model: string;
    readonly language?: string | undefined;
    readonly translate?: boolean | undefined;
  },
) {
  const form = new FormData();
  form.append("file", new Blob([input.bytes]), input.fileName);
  form.append("model", input.model);
  if (input.language !== undefined) form.append("language", input.language);
  const endpoint = input.translate === true ? "translations" : "transcriptions";
  const request = HttpClientRequest.post(`${c.base}/audio/${endpoint}`).pipe(
    HttpClientRequest.bodyFormData(form),
  );
  const body = yield* requestJson(c, request);
  if (isRecord(body) && typeof body.text === "string") return body.text;
  if (typeof body === "string") return body;
  return yield* failure("gateway_error", `${c.name} answered with an unreadable transcript.`);
});

const modelIds = (entries: ReadonlyArray<unknown>) =>
  entries.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string" && entry.id !== "" ? [entry.id] : [],
  );

export const listModels = Effect.fn("GatewayMedia.listModels")(function* (
  c: MediaGatewayConnection,
) {
  if ((yield* detectVideoDialect(c)) === "openrouter") {
    const body = yield* requestJson(c, HttpClientRequest.get(`${c.base}/videos/models`));
    return { models: modelIds(modelEntries(body) ?? []), videoModels: true };
  }
  const body = yield* requestJson(c, HttpClientRequest.get(`${c.base}/models`));
  return { models: modelIds(modelEntries(body) ?? []), videoModels: false };
});
