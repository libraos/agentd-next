import {
  LibraosGatewayError,
  type LibraosGatewayAgentdSetup,
  type LibraosGatewayModel,
  type LibraosGatewayStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/http";

import { AgentdBridge } from "../agentd/AgentdBridge.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { askGatewayModels } from "./gatewayKeyModels.ts";
import {
  GATEWAY_INSTANCE_IDS,
  GATEWAY_KEY_SECRET,
  gatewayProviderInstances,
  LIBRAOS_PI_TARGET,
  opencodeOwnGatewayKey,
  readGatewayKey,
  withGatewayModels,
} from "./gatewaySetup.ts";
import {
  backfillPiOnce,
  choosePiFirstRunDefault,
  clearPiDefault,
  hadPiGatewayAgent,
  piGatewayAgentDir,
  removePiGatewayAgentDir,
  writePiGatewayAgentDir,
} from "./piGatewayAgent.ts";

export class LibraosGateway extends Context.Service<
  LibraosGateway,
  {
    readonly status: Effect.Effect<LibraosGatewayStatus, LibraosGatewayError>;
    /** Checks the key with the Gateway, keeps it, gives it to agentd and adds the Gateway agents. */
    readonly connect: (key: string) => Effect.Effect<LibraosGatewayStatus, LibraosGatewayError>;
    /** Removes the key, its agentd key file and the Gateway agents. */
    readonly disconnect: Effect.Effect<LibraosGatewayStatus, LibraosGatewayError>;
    /**
     * Asks the Gateway for the key's models again and gives the Gateway agents the new list; a
     * refused key leaves them none. An unreachable Gateway leaves the last list.
     */
    readonly refreshModels: Effect.Effect<void>;
    /** Gives a key connected before the Gateway had a Pi agent that agent, once; runs at start. */
    readonly backfillPi: Effect.Effect<void>;
  }
>()("t3/gateway/LibraosGateway") {}

const INIT_TIMEOUT = Duration.minutes(3);
const OUTPUT_LIMIT = 8 * 1024;

/** The Gateway answered that the key may not list models (revoked, deleted, not allowed). */
class KeyRefusedError extends Schema.TaggedError<KeyRefusedError>()("KeyRefusedError", {
  message: Schema.String,
}) {}

class KeyFileError extends Schema.TaggedError<KeyFileError>()("KeyFileError", {
  detail: Schema.String,
}) {}

const fail = (message: string) => new LibraosGatewayError({ message });
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const make = Effect.fn("LibraosGateway.make")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettingsService;
  const bridge = yield* AgentdBridge;
  const runner = yield* ProcessRunner.ProcessRunner;
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;
  const username = yield* HostProcess.Username;
  const lock = yield* Semaphore.make(1);
  const models = yield* Ref.make<ReadonlyArray<LibraosGatewayModel> | null>(null);
  const agentdSetup = yield* Ref.make<LibraosGatewayAgentdSetup | null>(null);
  const refusal = yield* Ref.make<string | null>(null);
  // agentd reads the key from this file, which only it and the app read.
  const keyFile = path.join(stateDir, "agentd", GATEWAY_KEY_SECRET);
  const piDir = piGatewayAgentDir(path, stateDir, GATEWAY_INSTANCE_IDS.pi);
  const withFiles = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const storageFailure = (what: string) => (cause: unknown) =>
    Effect.logWarning(`LibraOS Gateway: failed to ${what}`, { cause }).pipe(
      Effect.andThen(Effect.fail(fail(`Could not ${what} on this host.`))),
    );

  const readKey = secrets
    .get(GATEWAY_KEY_SECRET)
    .pipe(
      Effect.map(Option.map((bytes) => textDecoder.decode(bytes).trim())),
      Effect.map(Option.filter((key) => key !== "")),
      Effect.catch(storageFailure("read the LibraOS Gateway key")),
    );

  const listModels = Effect.fn("LibraosGateway.listModels")(function* (key: string) {
    const answer = yield* askGatewayModels(key).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    if (answer.kind === "refused") return yield* new KeyRefusedError({ message: answer.message });
    if (answer.kind === "unavailable") return yield* fail(answer.message);
    return answer.models;
  });

  // A new file has inherited entries only, so dropping inheritance and granting the person leaves
  // the person alone. Windows ignores the creation mode, hence the ACL before the key goes in.
  const restrictToUser = Effect.fn("LibraosGateway.restrictToUser")(function* (file: string) {
    if (platform !== "win32") return yield* fs.chmod(file, 0o600);
    const user = username ?? env.USERNAME;
    if (!user) return yield* new KeyFileError({ detail: "no user name for its ACL" });
    const result = yield* runner.run({
      command: "icacls",
      args: [file, "/inheritance:r", "/grant:r", `${user}:F`],
      timeout: Duration.seconds(30),
    });
    if (result.code !== 0) {
      return yield* new KeyFileError({ detail: (result.stderr || result.stdout).trim() });
    }
  });

  const writeKeyFile = Effect.fn("LibraosGateway.writeKeyFile")(
    function* (key: string) {
      yield* fs.makeDirectory(path.dirname(keyFile), { recursive: true });
      yield* fs.remove(keyFile, { force: true });
      yield* fs.writeFile(keyFile, new Uint8Array(), { mode: 0o600, flag: "wx" });
      yield* restrictToUser(keyFile);
      yield* fs.writeFile(keyFile, textEncoder.encode(`${key}\n`), { mode: 0o600 });
    },
    Effect.tapError(() => fs.remove(keyFile, { force: true }).pipe(Effect.ignore)),
    Effect.catch(storageFailure("write LibraOS Engine's key file")),
  );

  // agentd writes [gateway], [dispatch] and its price list itself, and leaves a config that has
  // them alone; the app shows what it said either way.
  const runAgentdInit = Effect.gen(function* () {
    const command = yield* bridge.binary;
    const help = yield* runner
      .run({ command, args: ["init", "--help"], timeout: Duration.seconds(30), stdin: "" })
      .pipe(Effect.map((output) => ({ text: `${output.stdout}${output.stderr}` })));
    if (!help.text.includes("--model-key")) {
      return {
        ok: false,
        output:
          "This LibraOS Engine cannot take a model key (init --model-key). Update LibraOS Engine.",
      };
    }
    const home = yield* HostProcess.HomeDirectory;
    const args = [
      "init",
      "--model-key",
      keyFile,
      ...(help.text.includes("--no-services") ? ["--no-services"] : []),
    ];
    const result = yield* runner
      .run({
        command,
        args,
        cwd: home,
        stdin: "",
        timeout: INIT_TIMEOUT,
        maxOutputBytes: 1024 * 1024,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((output) => ({
          ok: !output.timedOut && output.code === 0,
          output: output.timedOut
            ? "libraos-engine init did not finish in time."
            : `${output.stdout}${output.stderr}`.trim().slice(-OUTPUT_LIMIT),
        })),
      );
    return result;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ok: false,
        output:
          "message" in error && error.message ? error.message : "LibraOS Engine could not be run.",
      }),
    ),
  );

  const status: LibraosGateway["Service"]["status"] = Effect.gen(function* () {
    const key = yield* readKey;
    if (Option.isNone(key)) return { connected: false, models: [], agentd: null, refusal: null };
    let list = yield* Ref.get(models);
    // An unreachable Gateway is asked again on the next read rather than remembered as no models.
    if (list === null) {
      list = yield* listModels(key.value).pipe(
        Effect.tap((fetched) => Ref.set(models, fetched)),
        Effect.orElseSucceed((): ReadonlyArray<LibraosGatewayModel> => []),
      );
    }
    return {
      connected: true,
      models: list,
      agentd: yield* Ref.get(agentdSetup),
      refusal: yield* Ref.get(refusal),
    };
  }).pipe(Effect.withSpan("LibraosGateway.status"));

  const connect: LibraosGateway["Service"]["connect"] = (raw) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const parsed = readGatewayKey(raw);
          if ("problem" in parsed) return yield* fail(parsed.problem);
          const key = parsed.key;
          const list = yield* listModels(key).pipe(
            Effect.catchTags({ KeyRefusedError: (error) => fail(error.message) }),
          );
          yield* secrets
            .set(GATEWAY_KEY_SECRET, textEncoder.encode(key))
            .pipe(Effect.catch(storageFailure("store the LibraOS Gateway key")));
          yield* writeKeyFile(key);
          // Before the instance, so its first probe already reads the Gateway's models.
          yield* withFiles(writePiGatewayAgentDir(piDir, LIBRAOS_PI_TARGET, list)).pipe(
            Effect.catch(storageFailure("write the Pi agent's model list")),
          );
          for (const { instanceId, instance } of gatewayProviderInstances(key, list, piDir)) {
            yield* settings
              .updateProviderInstance({ operation: "upsert", instanceId, instance })
              .pipe(Effect.catch(storageFailure("add the LibraOS Gateway agents")));
          }
          yield* withFiles(choosePiFirstRunDefault(settings, GATEWAY_INSTANCE_IDS.pi)).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("LibraOS Gateway: could not make Pi the default agent", { cause }),
            ),
          );
          yield* Ref.set(models, list);
          yield* Ref.set(refusal, null);
          yield* Ref.set(agentdSetup, yield* runAgentdInit);
          return yield* status;
        }),
      )
      .pipe(Effect.withSpan("LibraosGateway.connect"));

  const disconnect: LibraosGateway["Service"]["disconnect"] = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const current = yield* settings.getSettings.pipe(
          Effect.catch(storageFailure("read settings")),
        );
        for (const instanceId of Object.values(GATEWAY_INSTANCE_IDS)) {
          if (!Object.hasOwn(current.providerInstances, instanceId)) continue;
          yield* settings
            .updateProviderInstance({ operation: "remove", instanceId })
            .pipe(Effect.catch(storageFailure("remove the LibraOS Gateway agents")));
        }
        yield* fs
          .remove(keyFile, { force: true })
          .pipe(Effect.catch(storageFailure("remove LibraOS Engine's key file")));
        yield* withFiles(removePiGatewayAgentDir(piDir)).pipe(
          Effect.catch(storageFailure("remove the Pi agent's directory")),
        );
        yield* clearPiDefault(settings, GATEWAY_INSTANCE_IDS.pi).pipe(
          Effect.catch(storageFailure("clear the default agent")),
        );
        yield* secrets
          .remove(GATEWAY_KEY_SECRET)
          .pipe(Effect.catch(storageFailure("remove the LibraOS Gateway key")));
        yield* Ref.set(models, null);
        yield* Ref.set(refusal, null);
        yield* Ref.set(agentdSetup, null);
        return yield* status;
      }),
    )
    .pipe(Effect.withSpan("LibraosGateway.disconnect"));

  // Patches the stored agents in the same write, so an agent removed or edited meanwhile stays so.
  const applyModels = Effect.fn("LibraosGateway.applyModels")(function* (
    key: string,
    list: ReadonlyArray<LibraosGatewayModel> | null,
  ) {
    const snapshot = yield* settings.getSettings;
    // opencode's list is in its config, so a key edited on that agent is asked for its own list.
    const ownKey = opencodeOwnGatewayKey(snapshot.providerInstances, key);
    const opencodeList =
      ownKey === undefined
        ? list
        : yield* askGatewayModels(ownKey).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.map((answer) =>
              answer.kind === "models" ? answer.models : answer.kind === "refused" ? [] : null,
            ),
          );
    const update = (current: typeof snapshot.providerInstances) =>
      withGatewayModels(current, list, opencodeList);
    if (list !== null && snapshot.providerInstances[GATEWAY_INSTANCE_IDS.pi] !== undefined) {
      yield* withFiles(writePiGatewayAgentDir(piDir, LIBRAOS_PI_TARGET, list));
    }
    if (update(snapshot.providerInstances) === snapshot.providerInstances) return;
    yield* settings.updateProviderInstances(update);
  });

  const refreshModels: LibraosGateway["Service"]["refreshModels"] = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const key = yield* readKey;
        if (Option.isNone(key)) return;
        const asked = yield* listModels(key.value).pipe(
          Effect.map((list) => ({ list, refused: null })),
          Effect.catchTags({
            KeyRefusedError: (error) => Effect.succeed({ list: [], refused: error.message }),
          }),
          Effect.tapError((cause) =>
            Effect.logWarning("LibraOS Gateway: could not refresh the key's models", { cause }),
          ),
          Effect.option,
        );
        if (Option.isSome(asked)) {
          yield* Ref.set(models, asked.value.list);
          yield* Ref.set(refusal, asked.value.refused);
        }
        // Unreachable: the agents keep their last list, still limited to it.
        yield* applyModels(key.value, Option.isSome(asked) ? asked.value.list : null);
      }),
    )
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("LibraOS Gateway: could not update the Gateway agents' models", {
          cause,
        }),
      ),
      Effect.withSpan("LibraosGateway.refreshModels"),
    );

  // After a refresh, which leaves the key's models; an unreachable Gateway leaves it for the next start.
  const backfillPi: LibraosGateway["Service"]["backfillPi"] = lock
    .withPermits(1)(
      withFiles(
        backfillPiOnce(
          stateDir,
          "libraos",
          Effect.gen(function* () {
            const key = yield* readKey;
            if (Option.isNone(key)) return true;
            const list = yield* Ref.get(models);
            if (list === null) return false;
            const current = yield* settings.getSettings;
            const present = current.providerInstances[GATEWAY_INSTANCE_IDS.pi] !== undefined;
            if (yield* hadPiGatewayAgent(present, piDir)) return true;
            yield* writePiGatewayAgentDir(piDir, LIBRAOS_PI_TARGET, list);
            for (const { instanceId, instance } of gatewayProviderInstances(
              key.value,
              list,
              piDir,
            )) {
              if (instanceId !== GATEWAY_INSTANCE_IDS.pi) continue;
              yield* settings.updateProviderInstance({ operation: "upsert", instanceId, instance });
            }
            yield* choosePiFirstRunDefault(settings, GATEWAY_INSTANCE_IDS.pi);
            return true;
          }),
        ),
      ),
    )
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("LibraOS Gateway: could not add the Pi agent", { cause }),
      ),
      Effect.withSpan("LibraosGateway.backfillPi"),
    );

  // Agents added by an older build listed the agent's whole catalog; a key changed in Console since the
  // last start shows without waiting for a manual refresh.
  yield* settings.ready.pipe(
    Effect.andThen(refreshModels),
    Effect.andThen(backfillPi),
    Effect.catch((cause) =>
      Effect.logWarning("LibraOS Gateway: startup refresh failed", { cause }),
    ),
    Effect.forkScoped,
  );

  return LibraosGateway.of({ status, connect, disconnect, refreshModels, backfillPi });
});

export const layer = Layer.effect(LibraosGateway, make()).pipe(
  Layer.provide(FetchHttpClient.layer),
);
