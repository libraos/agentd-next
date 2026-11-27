import { DesktopHomeConfig } from "@t3tools/shared/desktopIdentity";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { WebSocket } from "undici";

import { baseDirFlag } from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import { resolveBaseDir } from "../../os-jank.ts";
import * as ManagedLimits from "../../policy/managedLimits.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import {
  deleteRelayDevice,
  parseRelayUrl,
  RELAY_SUBPROTOCOL,
  relayAuthHeaders,
  relayEndpoint,
} from "./relayApi.ts";
import {
  listRelayDevices,
  loadOrCreateHostKey,
  readRelayConfig,
  removeRelayConfig,
  removeRelayDevice,
  toBase64Url,
  writeRelayConfig,
} from "./relayStore.ts";

const HELLO_TIMEOUT_MS = 10_000;
const DEV_STATE_PLACEHOLDER_URL = new URL("http://localhost");

export class RelayCommandError extends Schema.TaggedError<RelayCommandError>()(
  "RelayCommandError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string) => Effect.fail(new RelayCommandError({ detail }));

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new RelayCommandError({ detail: cause instanceof Error ? cause.message : String(cause) }),
  });

const hasLiveServer = (statePath: string) =>
  readPersistedServerRuntimeState(statePath).pipe(
    Effect.map((state) => Option.isSome(state) && isProcessAlive(state.value.pid)),
    Effect.orElseSucceed(() => false),
  );

/** The state directory the server uses, the same way `theme` finds it. */
const resolveStateDir = Effect.fn("relay.resolveStateDir")(function* (
  explicitBaseDir: Option.Option<string>,
) {
  const envHome = Option.filter(yield* DesktopHomeConfig, (value) => value.trim().length > 0);
  const configuredBaseDir = Option.orElse(explicitBaseDir, () => envHome);
  const baseDir = yield* resolveBaseDir(Option.getOrUndefined(configuredBaseDir));
  const userdata = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
    baseDirIsExplicit: Option.isSome(configuredBaseDir),
  });
  if (
    Option.isNone(configuredBaseDir) &&
    !(yield* hasLiveServer(userdata.serverRuntimeStatePath))
  ) {
    const dev = yield* ServerConfig.deriveServerPaths(baseDir, DEV_STATE_PLACEHOLDER_URL);
    if (yield* hasLiveServer(dev.serverRuntimeStatePath)) return dev.stateDir;
  }
  return userdata.stateDir;
});

type HelloOutcome =
  | { readonly kind: "hello"; readonly hostId: string }
  | { readonly kind: "silent" }
  | { readonly kind: "refused"; readonly code: number }
  | { readonly kind: "unreachable"; readonly detail: string };

/** Opens a control socket once to check the token and learn this host's id. */
const greetRelay = (relayUrl: string, token: string) =>
  new Promise<HelloOutcome>((resolve) => {
    let opened = false;
    const socket = new WebSocket(relayEndpoint(relayUrl, "/relay/v1/host", true), {
      protocols: [RELAY_SUBPROTOCOL],
      headers: relayAuthHeaders({ token }),
    });
    const finish = (outcome: HelloOutcome) => {
      clearTimeout(timer);
      socket.close();
      resolve(outcome);
    };
    // @effect-diagnostics-next-line globalTimers:off -- bounds a socket callback wait, outside Effect.
    const timer = setTimeout(
      () => finish(opened ? { kind: "silent" } : { kind: "unreachable", detail: "timed out" }),
      HELLO_TIMEOUT_MS,
    );
    socket.addEventListener("open", () => (opened = true));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const value = JSON.parse(event.data) as { type?: unknown; hostId?: unknown };
        if (value.type === "hello" && typeof value.hostId === "string" && value.hostId.length > 0) {
          finish({ kind: "hello", hostId: value.hostId });
        }
      } catch {
        // Not a hello.
      }
    });
    socket.addEventListener("close", (event) =>
      finish(
        opened || event.code >= 4000
          ? { kind: "refused", code: event.code }
          : { kind: "unreachable", detail: event.reason || `closed with ${String(event.code)}` },
      ),
    );
  });

const refusalText = (code: number) =>
  code === 4401
    ? "The relay refused the token. Copy it again from the relay's web app."
    : code === 4403
      ? "The relay says this computer is revoked. Add it again in the relay's web app."
      : `The relay closed the connection (code ${String(code)}).`;

const connectCommand = Command.make("connect", {
  baseDir: baseDirFlag,
  url: Argument.String("relay-url").pipe(Argument.withDescription("The relay's HTTPS address.")),
  token: Flag.String("token").pipe(
    Flag.withDescription("The host token the relay's web app showed when you added this computer."),
  ),
  hostId: Flag.String("host-id").pipe(
    Flag.withDescription("This computer's id at the relay, for a relay that does not send it."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Connect this computer to a relay, so paired phones reach it from any network. Sessions are end-to-end encrypted; the relay cannot read them.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const policy = yield* ManagedPolicy.ManagedPolicy.pipe(Effect.provide(ManagedPolicy.layer));
      if (!ManagedLimits.allowsRemoteClients(policy)) {
        return yield* ManagedLimits.refuseRemoteClients(
          policy,
          "so this computer cannot connect to a relay",
        );
      }
      const url = parseRelayUrl(flags.url);
      if (typeof url === "string") return yield* fail(url);
      const relayUrl = url.toString().replace(/\/+$/, "");
      const token = flags.token.trim();
      if (token.length === 0) return yield* fail("--token is empty.");

      const outcome = yield* Effect.promise(() => greetRelay(relayUrl, token));
      if (outcome.kind === "unreachable") {
        return yield* fail(`Could not reach the relay at ${relayUrl}: ${outcome.detail}.`);
      }
      if (outcome.kind === "refused") return yield* fail(refusalText(outcome.code));
      const hostId =
        outcome.kind === "hello" ? outcome.hostId : Option.getOrUndefined(flags.hostId)?.trim();
      if (hostId === undefined || hostId.length === 0) {
        return yield* fail(
          "The relay accepted the token but did not say this computer's id. Run again with --host-id, as shown in the relay's web app.",
        );
      }

      const stateDir = yield* resolveStateDir(flags.baseDir);
      yield* attempt(() => writeRelayConfig(stateDir, { relayUrl, token, hostId }));
      const hostKey = yield* attempt(() => loadOrCreateHostKey(stateDir));
      yield* Console.log(
        [
          `Connected to the relay at ${relayUrl} as host ${hostId}.`,
          `Host key: ${toBase64Url(hostKey.publicKey)}`,
          "A running LibraOS Next server picks this up within a few seconds; one started later connects on its own.",
          "Pair a phone with `libraos-next pair`: its link now carries the relay.",
          "",
        ].join("\n"),
      );
    }),
  ),
);

const statusCommand = Command.make("status", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Show the relay this computer uses and its paired relay devices."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const stateDir = yield* resolveStateDir(flags.baseDir);
      const config = yield* attempt(() => readRelayConfig(stateDir));
      const devices = yield* attempt(() => listRelayDevices(stateDir));
      yield* Console.log(
        config === null
          ? "Relay: not connected. Connect with `libraos-next relay connect <relay-url> --token <token>`.\n"
          : `Relay: ${config.relayUrl}\nHost id: ${config.hostId ?? "not known yet"}\nPaired relay devices: ${String(devices.length)}\n`,
      );
    }),
  ),
);

const devicesCommand = Command.make("devices", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("List the devices paired through the relay."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const stateDir = yield* resolveStateDir(flags.baseDir);
      const devices = yield* attempt(() => listRelayDevices(stateDir));
      yield* Console.log(
        devices.length === 0
          ? "No devices are paired through the relay.\n"
          : `${devices
              .map(
                (device) =>
                  `${device.deviceId}  ${device.label || "(no label)"}  paired ${device.addedAt}`,
              )
              .join("\n")}\n`,
      );
    }),
  ),
);

const revokeCommand = Command.make("revoke", {
  baseDir: baseDirFlag,
  deviceId: Argument.String("device-id").pipe(
    Argument.withDescription("The device id from `libraos-next relay devices`."),
  ),
}).pipe(
  Command.withDescription(
    "Revoke a relay device: this computer deletes its key and the relay closes its connections.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const stateDir = yield* resolveStateDir(flags.baseDir);
      const removed = yield* attempt(() => removeRelayDevice(stateDir, flags.deviceId));
      const config = yield* attempt(() => readRelayConfig(stateDir));
      const relayResult =
        config === null
          ? "not connected to a relay"
          : yield* attempt(() => deleteRelayDevice(config, flags.deviceId)).pipe(
              Effect.as("revoked at the relay"),
              Effect.catch((error) => Effect.succeed(`not revoked at the relay: ${error.detail}`)),
            );
      if (removed === undefined && config === null) {
        return yield* fail(`No relay device ${flags.deviceId}.`);
      }
      yield* Console.log(
        `${removed === undefined ? "No key was stored for" : "Deleted the key of"} ${flags.deviceId}; ${relayResult}. A connected session ends within a few seconds.\n`,
      );
    }),
  ),
);

const disconnectCommand = Command.make("disconnect", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Stop using the relay. Paired relay devices are kept, so connecting again lets them back in.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const stateDir = yield* resolveStateDir(flags.baseDir);
      yield* attempt(() => removeRelayConfig(stateDir));
      yield* Console.log(
        "Disconnected from the relay. A running server closes its relay connection within a few seconds.\n",
      );
    }),
  ),
);

export const relayCommand = Command.make("relay").pipe(
  Command.withDescription("Reach this computer from your phone through a relay."),
  Command.withSubcommands([
    connectCommand,
    statusCommand,
    devicesCommand,
    revokeCommand,
    disconnectCommand,
  ]),
);
