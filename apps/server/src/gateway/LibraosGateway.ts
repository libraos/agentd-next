import {
  LIBRAOS_CLOUD_ORIGIN,
  LIBRAOS_DEVICE_CLIENT_ID,
  LibraosGatewayError,
  type LibraosGatewayAgentdSetup,
  type LibraosGatewayModel,
  type LibraosGatewaySignIn,
  type LibraosGatewaySignInPurpose,
  type LibraosGatewayStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

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
import {
  cloudRefusal,
  DEVICE_GRANT_TYPE,
  gatewayKeyName,
  parseDeviceCode,
  parseGatewayKey,
  parseStoredAccount,
  readTokenAnswer,
  serializeStoredAccount,
  SLOW_DOWN_SECONDS,
  type DeviceCode,
  type StoredAccount,
} from "./deviceSignIn.ts";

export class LibraosGateway extends Context.Service<
  LibraosGateway,
  {
    readonly status: Effect.Effect<LibraosGatewayStatus, LibraosGatewayError>;
    /** Checks the key with the Gateway, keeps it, gives it to agentd and adds the Gateway agents. */
    readonly connect: (key: string) => Effect.Effect<LibraosGatewayStatus, LibraosGatewayError>;
    /** Removes the key, its agentd key file and the Gateway agents, here only. */
    readonly disconnect: Effect.Effect<LibraosGatewayStatus, LibraosGatewayError>;
    /**
     * Asks the Gateway for the key's models again and gives the Gateway agents the new list; a
     * refused key leaves them none. An unreachable Gateway leaves the last list.
     */
    readonly refreshModels: Effect.Effect<void>;
    /** Gives a key connected before the Gateway had a Pi agent that agent, once; runs at start. */
    readonly backfillPi: Effect.Effect<void>;
    /**
     * Starts a LibraOS device sign-in: connect makes a Gateway key and connects it; revoke revokes
     * the connected key in LibraOS, then disconnects. The session token never leaves the flow.
     */
    readonly signInStart: (
      purpose: LibraosGatewaySignInPurpose,
    ) => Effect.Effect<LibraosGatewaySignIn, LibraosGatewayError>;
    /** Waits for the sign-in to end: the status after it, or why it ended (expiry, denial, Cancel). */
    readonly signInWait: Effect.Effect<LibraosGatewayStatus, LibraosGatewayError>;
    readonly signInCancel: Effect.Effect<LibraosGatewayStatus, LibraosGatewayError>;
  }
>()("t3/gateway/LibraosGateway") {}

// The key id and account of a key a sign-in made; absent for a pasted key.
const ACCOUNT_SECRET_NAME = "libraos-gateway-account";
const CLOUD_TIMEOUT = Duration.seconds(20);
const REVOKED_NOTICE = "The key was revoked in LibraOS.";
const REVOKE_IN_CONSOLE = "revoke it on Console's API keys page.";
const STILL_ACTIVE = `The key is still active in LibraOS: ${REVOKE_IN_CONSOLE}`;
const INIT_TIMEOUT = Duration.minutes(3);
const OUTPUT_LIMIT = 8 * 1024;

/** The Gateway answered that the key may not list models (revoked, deleted, not allowed). */
class KeyRefusedError extends Schema.TaggedError<KeyRefusedError>()("KeyRefusedError", {
  message: Schema.String,
}) {}

class SignInEnded extends Schema.TaggedError<SignInEnded>()("SignInEnded", {
  message: Schema.String,
}) {}

interface PendingSignIn {
  readonly info: LibraosGatewaySignIn;
  readonly done: Deferred.Deferred<LibraosGatewayStatus, LibraosGatewayError>;
  readonly fiber: Fiber.Fiber<unknown, unknown>;
}

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
  const hostname = yield* HostProcess.Hostname;
  const scope = yield* Scope.Scope;
  const pending = yield* Ref.make<PendingSignIn | null>(null);
  const notice = yield* Ref.make<string | null>(null);
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

  const readAccount = secrets.get(ACCOUNT_SECRET_NAME).pipe(
    Effect.map((bytes) =>
      Option.isSome(bytes) ? parseStoredAccount(textDecoder.decode(bytes.value)) : null,
    ),
    Effect.catch(storageFailure("read the LibraOS account")),
  );

  // Cloud answers; the body is never logged, since a token answer carries the session token.
  const cloudCall = (request: HttpClientRequest.HttpClientRequest, bearer?: string) =>
    http
      .execute(bearer === undefined ? request : HttpClientRequest.bearerToken(request, bearer))
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.timeout(CLOUD_TIMEOUT),
        Effect.mapError(() =>
          fail("Couldn't reach LibraOS at console.libraos.com. Check your connection."),
        ),
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.orElseSucceed((): unknown => undefined),
            Effect.map((body) => ({ status: response.status, body })),
          ),
        ),
      );

  const cloudForm = (route: string, params: Record<string, string>) =>
    HttpClientRequest.post(`${LIBRAOS_CLOUD_ORIGIN}${route}`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyUrlParams(params),
    );

  const revokeInCloud = Effect.fn("LibraosGateway.revokeInCloud")(function* (
    token: string,
    keyId: string,
  ) {
    const request = HttpClientRequest.make("DELETE")(
      `${LIBRAOS_CLOUD_ORIGIN}/v1/gateway-keys/${encodeURIComponent(keyId)}`,
    ).pipe(HttpClientRequest.acceptJson);
    const answer = yield* cloudCall(request, token);
    if (answer.status < 200 || answer.status >= 300) {
      return yield* fail(cloudRefusal(answer.status, answer.body, "revoke the key"));
    }
  });

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
            ? "libraos-core init did not finish in time."
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
    const signIn = (yield* Ref.get(pending))?.info ?? null;
    const lastNotice = yield* Ref.get(notice);
    if (Option.isNone(key)) {
      return {
        connected: false,
        models: [],
        agentd: null,
        refusal: null,
        account: null,
        signIn,
        notice: lastNotice,
      };
    }
    let list = yield* Ref.get(models);
    // An unreachable Gateway is asked again on the next read rather than remembered as no models.
    if (list === null) {
      list = yield* listModels(key.value).pipe(
        Effect.tap((fetched) => Ref.set(models, fetched)),
        Effect.orElseSucceed((): ReadonlyArray<LibraosGatewayModel> => []),
      );
    }
    const account = yield* readAccount;
    return {
      connected: true,
      models: list,
      agentd: yield* Ref.get(agentdSetup),
      refusal: yield* Ref.get(refusal),
      account: account === null ? null : { email: account.email, workspace: account.workspace },
      signIn,
      notice: lastNotice,
    };
  }).pipe(Effect.withSpan("LibraosGateway.status"));

  const connectKey = (raw: string, account: StoredAccount | null) =>
    lock.withPermits(1)(
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
        yield* (
          account === null
            ? secrets.remove(ACCOUNT_SECRET_NAME)
            : secrets.set(ACCOUNT_SECRET_NAME, textEncoder.encode(serializeStoredAccount(account)))
        ).pipe(Effect.catch(storageFailure("store the LibraOS account")));
        yield* Ref.set(notice, null);
        yield* Ref.set(models, list);
        yield* Ref.set(refusal, null);
        yield* Ref.set(agentdSetup, yield* runAgentdInit);
        return yield* status;
      }),
    );

  const connect: LibraosGateway["Service"]["connect"] = (raw) =>
    connectKey(raw, null).pipe(Effect.withSpan("LibraosGateway.connect"));

  // Everything connect wrote: the Gateway agents, agentd's key file, the key and its account.
  const removeLocal = (lastNotice: string | null) =>
    lock.withPermits(1)(
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
        yield* secrets
          .remove(ACCOUNT_SECRET_NAME)
          .pipe(Effect.catch(storageFailure("remove the LibraOS account")));
        yield* Ref.set(models, null);
        yield* Ref.set(refusal, null);
        yield* Ref.set(agentdSetup, null);
        yield* Ref.set(notice, lastNotice);
        return yield* status;
      }),
    );

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

  const cancelPending = Effect.gen(function* () {
    const current = yield* Ref.get(pending);
    if (current !== null) yield* Fiber.interrupt(current.fiber);
  });

  const disconnect: LibraosGateway["Service"]["disconnect"] = Effect.gen(function* () {
    yield* cancelPending;
    const account = yield* readAccount;
    return yield* removeLocal(account === null ? null : STILL_ACTIVE);
  }).pipe(Effect.withSpan("LibraosGateway.disconnect"));

  // Polls at the interval Cloud gave, five seconds slower after each slow_down, until a token or
  // the code's expiry. A failed request is asked again; the expiry still ends it.
  const pollForToken = Effect.fn("LibraosGateway.pollForToken")(function* (
    code: DeviceCode,
    expiresAt: number,
  ) {
    let interval = code.intervalSeconds;
    while (true) {
      yield* Effect.sleep(Duration.seconds(interval));
      if ((yield* Clock.currentTimeMillis) >= expiresAt) {
        return yield* new SignInEnded({
          message: "The sign-in code expired before it was approved.",
        });
      }
      const answer = yield* cloudCall(
        cloudForm("/v1/device/token", {
          grant_type: DEVICE_GRANT_TYPE,
          device_code: code.deviceCode,
          client_id: LIBRAOS_DEVICE_CLIENT_ID,
        }),
      ).pipe(Effect.option);
      if (Option.isNone(answer)) continue;
      const read = readTokenAnswer(answer.value.status, answer.value.body);
      switch (read._tag) {
        case "Token":
          return read;
        case "Pending":
          continue;
        case "SlowDown":
          interval += SLOW_DOWN_SECONDS;
          continue;
        case "Ended":
          return yield* new SignInEnded({ message: read.message });
      }
    }
  });

  // With the token: make a key and connect it, revoking it again if connecting fails, so a failed
  // sign-in leaves nothing behind here or in LibraOS.
  const connectWithToken = Effect.fn("LibraosGateway.connectWithToken")(function* (
    token: string,
    account: { readonly email: string; readonly workspace: string },
  ) {
    const name = gatewayKeyName(hostname);
    const request = HttpClientRequest.post(`${LIBRAOS_CLOUD_ORIGIN}/v1/gateway-keys`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe({ name, device_name: hostname }),
    );
    const answer = yield* cloudCall(request, token);
    if (answer.status < 200 || answer.status >= 300) {
      return yield* fail(cloudRefusal(answer.status, answer.body, "create a Gateway key"));
    }
    const created = parseGatewayKey(answer.body);
    if (created === null) return yield* fail("LibraOS answered with an unreadable Gateway key.");
    return yield* connectKey(created.key, { keyId: created.id, ...account }).pipe(
      Effect.tapError(() =>
        revokeInCloud(token, created.id).pipe(
          Effect.ignore,
          Effect.andThen(removeLocal(null).pipe(Effect.ignore)),
        ),
      ),
    );
  });

  const revokeWithToken = Effect.fn("LibraosGateway.revokeWithToken")(function* (token: string) {
    const account = yield* readAccount;
    if (account === null) return yield* removeLocal(null);
    const revoked = yield* revokeInCloud(token, account.keyId).pipe(
      Effect.as(REVOKED_NOTICE),
      Effect.catch((error) =>
        Effect.succeed(`${error.message} It was removed here; ${REVOKE_IN_CONSOLE}`),
      ),
    );
    return yield* removeLocal(revoked);
  });

  const signInStart: LibraosGateway["Service"]["signInStart"] = Effect.fn(
    "LibraosGateway.signInStart",
  )(function* (purpose) {
    yield* cancelPending;
    const connected = Option.isSome(yield* readKey);
    if (purpose === "connect" && connected) {
      return yield* fail("LibraOS Gateway is already connected. Disconnect it first.");
    }
    if (purpose === "revoke" && (!connected || (yield* readAccount) === null)) {
      return yield* fail("This key was not made by signing in, so there is nothing to revoke.");
    }
    yield* Ref.set(notice, null);
    const answer = yield* cloudCall(
      cloudForm("/v1/device/code", { client_id: LIBRAOS_DEVICE_CLIENT_ID }),
    );
    if (answer.status < 200 || answer.status >= 300) {
      return yield* fail(cloudRefusal(answer.status, answer.body, "start a sign-in"));
    }
    const code = parseDeviceCode(answer.body);
    if (code === null) return yield* fail("LibraOS answered with an unreadable sign-in code.");
    const expiresAt = (yield* Clock.currentTimeMillis) + code.expiresInSeconds * 1000;
    const info: LibraosGatewaySignIn = {
      purpose,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      verificationUriComplete: code.verificationUriComplete,
      expiresAt,
    };
    const done = yield* Deferred.make<LibraosGatewayStatus, LibraosGatewayError>();
    const cancelled =
      purpose === "connect"
        ? "Sign-in cancelled. Nothing was connected."
        : "Cancelled. The key is still connected.";

    // The wait's answer is the status once this sign-in is no longer pending.
    const settle = (outcome: Effect.Effect<LibraosGatewayStatus, LibraosGatewayError>) =>
      outcome.pipe(
        Effect.map((after): LibraosGatewayStatus => ({ ...after, signIn: null })),
        Effect.exit,
        Effect.tap(() =>
          Ref.update(pending, (current) => (current?.done === done ? null : current)),
        ),
        Effect.flatMap((exit) => Deferred.done(done, exit)),
        // Past the token nothing is interrupted, so a Cancel never leaves a key half-connected.
        Effect.uninterruptible,
      );
    const afterToken = (token: string, account: { email: string; workspace: string }) =>
      settle(purpose === "connect" ? connectWithToken(token, account) : revokeWithToken(token));
    const ended = (message: string) =>
      settle(
        purpose === "connect"
          ? Effect.fail(fail(message))
          : // Revoking could not happen: still disconnect here, and say so.
            removeLocal(
              `LibraOS did not revoke the key: ${message} It was removed here; ${REVOKE_IN_CONSOLE}`,
            ),
      );

    const flow = pollForToken(code, expiresAt).pipe(
      Effect.matchEffect({
        onSuccess: (read) => afterToken(read.token, read.account),
        onFailure: (error) => ended(error.message),
      }),
      Effect.onInterrupt(() => Deferred.fail(done, fail(cancelled))),
      Effect.ensuring(Ref.update(pending, (current) => (current?.done === done ? null : current))),
    );
    const fiber = yield* Effect.forkIn(flow, scope);
    yield* Ref.set(pending, { info, done, fiber });
    return info;
  });

  const signInWait: LibraosGateway["Service"]["signInWait"] = Effect.gen(function* () {
    const current = yield* Ref.get(pending);
    if (current === null) return yield* fail("No sign-in is waiting.");
    return yield* Deferred.await(current.done);
  }).pipe(Effect.withSpan("LibraosGateway.signInWait"));

  const signInCancel: LibraosGateway["Service"]["signInCancel"] = cancelPending.pipe(
    Effect.andThen(status),
    Effect.withSpan("LibraosGateway.signInCancel"),
  );

  return LibraosGateway.of({
    status,
    connect,
    disconnect,
    refreshModels,
    backfillPi,
    signInStart,
    signInWait,
    signInCancel,
  });
});

export const layer = Layer.effect(LibraosGateway, make()).pipe(
  Layer.provide(FetchHttpClient.layer),
);
