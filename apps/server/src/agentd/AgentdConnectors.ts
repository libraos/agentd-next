import {
  type AgentdConnectorAddInput,
  type AgentdConnectorRef,
  type AgentdConnectors,
  type AgentdConnectorSetEnabledInput,
  type AgentdConnectorsListInput,
  AgentdCustomizeError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The agents' own connectors (MCP servers), read from and written to each agent's configuration. */
export class AgentdConnectorsService extends Context.Service<
  AgentdConnectorsService,
  {
    readonly list: (
      input: AgentdConnectorsListInput,
    ) => Effect.Effect<AgentdConnectors, AgentdCustomizeError>;
    readonly setEnabled: (
      input: AgentdConnectorSetEnabledInput,
    ) => Effect.Effect<AgentdConnectors, AgentdCustomizeError>;
    readonly add: (
      input: AgentdConnectorAddInput,
    ) => Effect.Effect<AgentdConnectors, AgentdCustomizeError>;
    readonly remove: (
      input: AgentdConnectorRef,
    ) => Effect.Effect<AgentdConnectors, AgentdCustomizeError>;
  }
>()("t3/agentd/AgentdConnectors/AgentdConnectorsService") {}

const unsupported = new AgentdCustomizeError({
  reason: "unsupported",
  message: "Connectors are not available yet.",
});

const make = Effect.succeed(
  AgentdConnectorsService.of({
    list: Effect.fn("AgentdConnectors.list")(function* () {
      return { agents: [] } satisfies AgentdConnectors;
    }),
    setEnabled: Effect.fn("AgentdConnectors.setEnabled")(function* () {
      return yield* unsupported;
    }),
    add: Effect.fn("AgentdConnectors.add")(function* () {
      return yield* unsupported;
    }),
    remove: Effect.fn("AgentdConnectors.remove")(function* () {
      return yield* unsupported;
    }),
  }),
);

export const layer = Layer.effect(AgentdConnectorsService, make);
