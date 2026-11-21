import {
  GatewayMediaAudioInput,
  GatewayMediaFailure,
  GatewayMediaFileResult,
  GatewayMediaJobResult,
  GatewayMediaModelsInput,
  GatewayMediaModelsResult,
  GatewayMediaSpeechInput,
  GatewayMediaTranscribeInput,
  GatewayMediaTranscriptResult,
  GatewayMediaVideoInput,
  GatewayMediaVideoStatusInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as GatewayMedia from "../../../gateway/GatewayMedia.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  GatewayMedia.GatewayMedia,
];

const MediaToolFailure = Schema.Union([GatewayMediaFailure, OrchestratorMcpFailure]);

const mediaTool = <
  const Name extends string,
  Parameters extends Schema.Constraint,
  Success extends Schema.Constraint,
>(
  name: Name,
  options: {
    readonly title: string;
    readonly description: string;
    readonly parameters: Parameters;
    readonly success: Success;
    readonly readonly: boolean;
  },
) =>
  Tool.make(name, {
    description: options.description,
    parameters: options.parameters,
    success: options.success,
    failure: MediaToolFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, options.title)
    .annotate(Tool.Readonly, options.readonly)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, options.readonly)
    .annotate(Tool.OpenWorld, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const MediaToolkit = Toolkit.make(
  mediaTool("media_generate_video", {
    title: "Make a video",
    description:
      "Make a video with the custom gateway and save it in this thread's workspace. Waits until it is done (up to 55 minutes); if it is still running, call `media_video_status` with the job id. Costs money on the gateway. A gateway can have several video models: when the person named none, list them and ask which, and say which model made the video.",
    parameters: GatewayMediaVideoInput,
    success: GatewayMediaJobResult,
    readonly: false,
  }),
  mediaTool("media_video_status", {
    title: "Check a video",
    description: "Wait for a video from `media_generate_video` and save it when done.",
    parameters: GatewayMediaVideoStatusInput,
    success: GatewayMediaJobResult,
    readonly: false,
  }),
  mediaTool("media_generate_speech", {
    title: "Make speech",
    description:
      "Turn text into speech with the custom gateway and save the audio in this thread's workspace. Say which model made it.",
    parameters: GatewayMediaSpeechInput,
    success: GatewayMediaFileResult,
    readonly: false,
  }),
  mediaTool("media_transcribe", {
    title: "Transcribe audio",
    description:
      "Transcribe (or translate to English) an audio file in this thread's workspace with the custom gateway.",
    parameters: GatewayMediaTranscribeInput,
    success: GatewayMediaTranscriptResult,
    readonly: true,
  }),
  mediaTool("media_generate_audio", {
    title: "Make audio",
    description:
      "Make music or sound effects with the custom gateway and save them in this thread's workspace. Not every gateway offers this. Say which model made it.",
    parameters: GatewayMediaAudioInput,
    success: GatewayMediaJobResult,
    readonly: false,
  }),
  mediaTool("media_list_models", {
    title: "List gateway models",
    description:
      "List the custom gateway's models, to pick one for a video, speech or transcription. People using AgentD Next for marketing may not know model names; offer them the list.",
    parameters: GatewayMediaModelsInput,
    success: GatewayMediaModelsResult,
    readonly: true,
  }),
);
