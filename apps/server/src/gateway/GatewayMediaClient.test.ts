import { assert, it } from "@effect/vitest";
import type { GatewayMediaFailure } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  detectVideoDialect,
  latestVideo,
  pollVideo,
  submitVideo,
  videoRequestBody,
  waitForJob,
} from "./GatewayMediaClient.ts";

const KEY = "sk-secret";

const fakeGateway = (routes: Record<string, () => Response>) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const route = routes[`${request.method} ${path}`];
      return HttpClientResponse.fromWeb(
        request,
        route?.() ?? Response.json({ error: { message: "Not found" } }, { status: 404 }),
      );
    }),
  );

const connection = (host: string) => ({
  name: "Gateway",
  base: `https://${host}/v1`,
  key: KEY,
});

it.effect("detects openrouter from a video model list", () =>
  Effect.gen(function* () {
    const openRouter = yield* detectVideoDialect(connection("router.test")).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        fakeGateway({
          "GET /v1/videos/models": () =>
            Response.json({ data: [{ id: "veo", supported_durations: [4, 8] }] }),
        }),
      ),
    );
    assert.strictEqual(openRouter, "openrouter");
    const openAi = yield* detectVideoDialect(connection("compute.test")).pipe(
      Effect.provideService(HttpClient.HttpClient, fakeGateway({})),
    );
    assert.strictEqual(openAi, "openai");
  }),
);

it("openai body turns 720p 9:16 into a size and drops audio", () => {
  assert.deepStrictEqual(
    videoRequestBody("openai", {
      model: "m",
      prompt: "p",
      seconds: 8,
      resolution: "720p",
      aspectRatio: "9:16",
      audio: true,
    }),
    { model: "m", prompt: "p", seconds: "8", size: "720x1280" },
  );
});

it("openrouter body keeps duration, resolution and generate_audio", () => {
  assert.deepStrictEqual(
    videoRequestBody("openrouter", {
      model: "m",
      prompt: "p",
      seconds: 8,
      resolution: "720p",
      aspectRatio: "9:16",
      audio: true,
    }),
    {
      model: "m",
      prompt: "p",
      duration: 8,
      resolution: "720p",
      aspect_ratio: "9:16",
      generate_audio: true,
    },
  );
});

it.effect("a gateway error message is passed through without the key", () =>
  Effect.gen(function* () {
    const error = yield* submitVideo(connection("compute.test"), "openai", {
      model: "m",
      prompt: "p",
    }).pipe(
      Effect.flip,
      Effect.provideService(
        HttpClient.HttpClient,
        fakeGateway({
          "POST /v1/videos": () =>
            Response.json(
              { error: { message: "budget_exceeded: monthly cap reached" } },
              { status: 402 },
            ),
        }),
      ),
    );
    assert.strictEqual(error.code, "gateway_error");
    assert.strictEqual(error.message, "budget_exceeded: monthly cap reached");
    assert.notInclude(error.message, KEY);

    const echoed = yield* submitVideo(connection("compute.test"), "openai", {
      model: "m",
      prompt: "p",
    }).pipe(
      Effect.flip,
      Effect.provideService(
        HttpClient.HttpClient,
        fakeGateway({
          "POST /v1/videos": () =>
            Response.json({ error: `key ${KEY} is over budget` }, { status: 402 }),
        }),
      ),
    );
    assert.notInclude(echoed.message, KEY);
  }),
);

it.effect("openrouter expired becomes a failure", () =>
  Effect.gen(function* () {
    const c = connection("router.test");
    const http = fakeGateway({
      "GET /v1/videos/job-1": () => Response.json({ id: "job-1", status: "expired" }),
    });
    const job = yield* pollVideo(c, "job-1").pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    assert.strictEqual(job.status, "failed");
    assert.strictEqual(job.error, "expired");
    const error: GatewayMediaFailure = yield* waitForJob(
      job,
      (id) => pollVideo(c, id).pipe(Effect.provideService(HttpClient.HttpClient, http)),
      { maxWait: Duration.minutes(1), pollEvery: Duration.seconds(30) },
    ).pipe(Effect.flip);
    assert.include(error.message, "expired");
  }),
);

it.effect("a job still running at the wait cap comes back in progress", () =>
  Effect.gen(function* () {
    const c = connection("compute.test");
    const http = fakeGateway({
      "GET /v1/videos/job-2": () => Response.json({ id: "job-2", status: "in_progress" }),
    });
    const job = yield* pollVideo(c, "job-2").pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    const result = yield* waitForJob(
      job,
      (id) => pollVideo(c, id).pipe(Effect.provideService(HttpClient.HttpClient, http)),
      { maxWait: Duration.zero, pollEvery: Duration.seconds(10) },
    );
    assert.strictEqual(result.status, "in_progress");
    assert.strictEqual(result.id, "job-2");
  }),
);

it.effect("the newest video stands in for a lost job id", () =>
  Effect.gen(function* () {
    const http = fakeGateway({
      "GET /v1/videos": () =>
        Response.json({
          object: "list",
          data: [{ id: "video_9", status: "completed", seconds: "3", model: "veo-fast" }],
          has_more: true,
        }),
    });
    const job = yield* latestVideo(connection("compute.test")).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    assert.strictEqual(job.id, "video_9");
    assert.strictEqual(job.status, "completed");
    assert.strictEqual(job.model, "veo-fast");
  }),
);
