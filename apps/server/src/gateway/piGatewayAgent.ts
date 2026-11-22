import type { LibraosGatewayModel, ProviderInstanceId } from "@t3tools/contracts";
import { CommandAvailability } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { ServerSettingsService } from "../serverSettings.ts";
import { piGatewayFiles, type PiGatewayTarget } from "./gatewaySetup.ts";

// A gateway's Pi agent reads its models.json and settings.json from a directory the server owns,
// one per instance, so neither ~/.pi nor the user's own Pi instance is touched.

/** The agent directory of a gateway's Pi instance, below the server's state directory. */
export const piGatewayAgentDir = (path: Path.Path, stateDir: string, instanceId: string) =>
  path.join(stateDir, "pi-gateway", instanceId);

/** Writes the directory for `models`; settings Pi saved there stay. */
export const writePiGatewayAgentDir = Effect.fn("PiGatewayAgent.write")(function* (
  dir: string,
  target: PiGatewayTarget,
  models: ReadonlyArray<LibraosGatewayModel>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
  const settingsFile = path.join(dir, "settings.json");
  const current = yield* fs.readFileString(settingsFile).pipe(Effect.option);
  const files = piGatewayFiles(target, models, Option.getOrUndefined(current));
  // Renamed into place: a Pi starting meanwhile reads the old file or the new, never half of one.
  const replace = (file: string, text: string) =>
    fs
      .writeFileString(`${file}.tmp`, text, { mode: 0o600 })
      .pipe(Effect.andThen(fs.rename(`${file}.tmp`, file)));
  yield* replace(path.join(dir, "models.json"), files.models);
  yield* replace(settingsFile, files.settings);
});

export const removePiGatewayAgentDir = Effect.fn("PiGatewayAgent.remove")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(dir, { recursive: true, force: true });
});

/** The agents whose presence leaves the first-run default alone. */
const OTHER_AGENTS = ["claude", "codex", "opencode"] as const;

/**
 * On first run (no default model chosen yet) with no other agent on this host, a gateway's Pi
 * instance becomes the default. Pi's "default" model is the gateway's, from its settings.json.
 */
export const choosePiFirstRunDefault = Effect.fn("PiGatewayAgent.chooseFirstRunDefault")(function* (
  settings: ServerSettingsService["Service"],
  instanceId: ProviderInstanceId,
) {
  if ((yield* settings.getSettings).defaultModelSelection !== null) return false;
  const available = yield* CommandAvailability;
  for (const command of OTHER_AGENTS) {
    if (yield* available(command)) return false;
  }
  yield* settings.updateSettings({ defaultModelSelection: { instanceId, model: "default" } });
  return true;
});

/** A default left pointing at a removed Pi instance goes with it. */
export const clearPiDefault = Effect.fn("PiGatewayAgent.clearDefault")(function* (
  settings: ServerSettingsService["Service"],
  instanceId: ProviderInstanceId,
) {
  if ((yield* settings.getSettings).defaultModelSelection?.instanceId !== instanceId) return;
  yield* settings.updateSettings({ defaultModelSelection: null });
});
