import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const gateway = Schema.optional(
  TrimmedNonEmptyString.annotate({
    description:
      "Custom gateway name or id. Default: the gateway this thread runs on, else the only one.",
  }),
);

const outputPath = Schema.optional(
  TrimmedNonEmptyString.annotate({
    description:
      "File path inside this thread's workspace. Default: generated-media/. A taken name gets -1, -2.",
  }),
);

const model = TrimmedNonEmptyString.annotate({
  description:
    "Model id on the gateway; `media_list_models` lists them. When the person named none and more than one fits, ask them which before calling.",
});

const usedModel = Schema.String.annotate({
  description: "The model that did this. Tell the person which it was.",
});

const seconds = Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3600));

export const GatewayMediaVideoInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.annotate({ description: "What the video shows." }),
  model,
  seconds: Schema.optional(seconds.annotate({ description: "Length in seconds." })),
  size: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isPattern(/^\d+x\d+$/)).annotate({
      description: "WIDTHxHEIGHT, such as 1280x720.",
    }),
  ),
  resolution: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Such as 720p or 1080p. Turned into a size when the gateway needs one.",
    }),
  ),
  aspectRatio: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Such as 16:9, 9:16 or 1:1. Turned into a size when the gateway needs one.",
    }),
  ),
  audio: Schema.optional(
    Schema.Boolean.annotate({
      description: "Ask for sound. Gateways that cannot do it ignore this.",
    }),
  ),
  outputPath,
  gateway,
});
export type GatewayMediaVideoInput = typeof GatewayMediaVideoInput.Type;

export const GatewayMediaVideoStatusInput = Schema.Struct({
  jobId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "`jobId` from `media_generate_video`. Leave out if lost: the newest video is used.",
    }),
  ),
  outputPath,
  gateway,
});
export type GatewayMediaVideoStatusInput = typeof GatewayMediaVideoStatusInput.Type;

export const GatewayMediaSpeechInput = Schema.Struct({
  text: TrimmedNonEmptyString.annotate({ description: "What to say." }),
  model,
  voice: Schema.optional(TrimmedNonEmptyString.annotate({ description: "Voice name." })),
  format: Schema.optional(
    Schema.Literals(["mp3", "wav", "opus", "aac", "flac", "pcm"]).annotate({
      description: "Default mp3.",
    }),
  ),
  outputPath,
  gateway,
});
export type GatewayMediaSpeechInput = typeof GatewayMediaSpeechInput.Type;

export const GatewayMediaTranscribeInput = Schema.Struct({
  path: TrimmedNonEmptyString.annotate({
    description: "Audio file inside this thread's workspace.",
  }),
  model,
  language: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "Spoken language, such as en." }),
  ),
  translate: Schema.optional(
    Schema.Boolean.annotate({ description: "True: translate to English." }),
  ),
  gateway,
});
export type GatewayMediaTranscribeInput = typeof GatewayMediaTranscribeInput.Type;

export const GatewayMediaAudioInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.annotate({ description: "The music or sound to make." }),
  model,
  seconds: Schema.optional(seconds.annotate({ description: "Length in seconds." })),
  outputPath,
  gateway,
});
export type GatewayMediaAudioInput = typeof GatewayMediaAudioInput.Type;

export const GatewayMediaModelsInput = Schema.Struct({ gateway });
export type GatewayMediaModelsInput = typeof GatewayMediaModelsInput.Type;

export const GatewayMediaJobResult = Schema.Struct({
  status: Schema.Literals(["completed", "in_progress"]).annotate({
    description: "in_progress: call again with `jobId` to wait more.",
  }),
  jobId: Schema.String,
  path: Schema.NullOr(Schema.String).annotate({ description: "Saved file, workspace-relative." }),
  seconds: Schema.NullOr(Schema.Number),
  model: Schema.NullOr(usedModel),
  costUsd: Schema.NullOr(Schema.Number),
  gateway: Schema.String,
});
export type GatewayMediaJobResult = typeof GatewayMediaJobResult.Type;

export const GatewayMediaFileResult = Schema.Struct({
  path: Schema.String.annotate({ description: "Saved file, workspace-relative." }),
  model: usedModel,
  gateway: Schema.String,
});
export type GatewayMediaFileResult = typeof GatewayMediaFileResult.Type;

export const GatewayMediaTranscriptResult = Schema.Struct({
  text: Schema.String,
  model: usedModel,
  gateway: Schema.String,
});
export type GatewayMediaTranscriptResult = typeof GatewayMediaTranscriptResult.Type;

export const GatewayMediaModelsResult = Schema.Struct({
  models: Schema.Array(Schema.String),
  videoModels: Schema.Boolean.annotate({
    description: "True: these are the gateway's video models. False: all its models.",
  }),
  gateway: Schema.String,
});
export type GatewayMediaModelsResult = typeof GatewayMediaModelsResult.Type;

export class GatewayMediaFailure extends Schema.TaggedError<GatewayMediaFailure>()(
  "GatewayMediaFailure",
  {
    code: Schema.Literals([
      "no_gateway",
      "ambiguous_gateway",
      "unsupported",
      "gateway_error",
      "invalid_request",
      "thread_required",
    ]),
    message: Schema.String,
  },
) {}
