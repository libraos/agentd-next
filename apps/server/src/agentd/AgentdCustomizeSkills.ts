import {
  AgentdCustomizeError,
  type AgentdSkillDetail,
  type AgentdSkillRef,
  type AgentdSkillSetEnabledInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Reads a skill the provider listed and writes the agent's own switch for it. */
export class AgentdCustomizeSkillsService extends Context.Service<
  AgentdCustomizeSkillsService,
  {
    readonly read: (
      input: AgentdSkillRef,
    ) => Effect.Effect<AgentdSkillDetail, AgentdCustomizeError>;
    readonly setEnabled: (
      input: AgentdSkillSetEnabledInput,
    ) => Effect.Effect<AgentdSkillDetail, AgentdCustomizeError>;
  }
>()("t3/agentd/AgentdCustomizeSkills/AgentdCustomizeSkillsService") {}

const unsupported = new AgentdCustomizeError({
  reason: "unsupported",
  message: "Skill details are not available yet.",
});

const make = Effect.succeed(
  AgentdCustomizeSkillsService.of({
    read: Effect.fn("AgentdCustomizeSkills.read")(function* () {
      return yield* unsupported;
    }),
    setEnabled: Effect.fn("AgentdCustomizeSkills.setEnabled")(function* () {
      return yield* unsupported;
    }),
  }),
);

export const layer = Layer.effect(AgentdCustomizeSkillsService, make);
