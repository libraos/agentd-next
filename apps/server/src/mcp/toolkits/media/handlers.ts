import * as Effect from "effect/Effect";

import * as GatewayMedia from "../../../gateway/GatewayMedia.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MediaToolkit } from "./tools.ts";

const call = <Input, A, E>(
  operation: (
    service: GatewayMedia.GatewayMedia["Service"],
    scope: McpInvocationContext.McpInvocationScope,
    input: Input,
  ) => Effect.Effect<A, E>,
) =>
  McpToolAccess.actsAsCaller((input: Input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* GatewayMedia.GatewayMedia;
      return yield* operation(service, scope, input);
    }),
  );

const handlers = {
  media_generate_video: call((service, scope, input) => service.video(scope, input)),
  media_video_status: call((service, scope, input) => service.videoStatus(scope, input)),
  media_generate_speech: call((service, scope, input) => service.speech(scope, input)),
  media_transcribe: call((service, scope, input) => service.transcribe(scope, input)),
  media_generate_audio: call((service, scope, input) => service.audio(scope, input)),
  media_list_models: call((service, scope, input) => service.models(scope, input)),
} satisfies McpToolAccess.Handlers<typeof MediaToolkit.tools>;

export const layer = McpToolAccess.toLayer(MediaToolkit, handlers);
