import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import type * as ProcessRunner from "../processRunner.ts";
import {
  detectServices,
  dropInDirs,
  isStaleProgram,
  plistProgram,
  repairServices,
  schtasksText,
  serviceAgentd,
  setupAgentd,
  taskEnvFile,
  taskNames,
  taskProgram,
  unitProgram,
  unitsToEnable,
} from "./agentdServices.ts";

const OLD = "/Applications/AgentD Desktop.app/Contents/Resources/bin/agentd";
const NEXT = "/Applications/AgentD Next.app/Contents/Resources/bin/agentd";

const plist = (
  program: string,
  env: Record<string, string> = {},
) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.libraos.agentd.watchdog</string>
<key>ProgramArguments</key>
<array>
  <string>${program.replaceAll("&", "&amp;")}</string>
  <string>watchdog</string>
</array>
<key>EnvironmentVariables</key>
<dict>
  <key>PATH</key><string>/usr/bin:/bin</string>
${Object.entries(env)
  .map(([key, value]) => `  <key>${key}</key><string>${value.replaceAll("&", "&amp;")}</string>`)
  .join("\n")}
</dict>
</dict></plist>`;

const task = (program: string, envFile: string) =>
  `<Actions Context="Author"><Exec><Command>${program}</Command><Arguments>service-run --env &quot;${envFile}&quot; --log x.log -- watchdog</Arguments></Exec></Actions>`;

// What a check or Repair ran besides reading what systemd has loaded.
const acted = (runs: ReadonlyArray<ReadonlyArray<string>>) =>
  runs.filter((run) => run[0] !== "systemctl" || run[2] !== "show");

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

describe("agentd services", () => {
  it("reads the program each kind of service runs", () => {
    expect(plistProgram(plist(OLD))).toBe(OLD);
    expect(plistProgram(plist("/opt/R&D/agentd"))).toBe("/opt/R&D/agentd");
    expect(plistProgram("<plist/>")).toBe(null);
    expect(unitProgram("[Service]\nExecStart=-%h/.local/bin/agentd watchdog\n", "/home/me")).toBe(
      "/home/me/.local/bin/agentd",
    );
    expect(unitProgram('ExecStart="/opt/Agent D/agentd" dash --serve x', "/h")).toBe(
      "/opt/Agent D/agentd",
    );
    // A drop-in's empty ExecStart= clears the unit's, and the next one is what runs.
    expect(
      unitProgram(
        "[Service]\nExecStart=/new/agentd watchdog\n[Service]\nExecStart=\nExecStart=/gone/agentd watchdog\n",
        "/h",
      ),
    ).toBe("/gone/agentd");
    expect(unitProgram("ExecStart=/a/agentd x\nExecStart=\n", "/h")).toBe(null);
    expect(dropInDirs("agentd-watchdog.service")).toEqual([
      "agentd-watchdog.service.d",
      "agentd-.service.d",
      "service.d",
    ]);
    expect(
      taskProgram(
        "<Actions><Exec><Command>&quot;C:\\Program Files\\AgentD Desktop\\resources\\bin\\agentd.exe&quot;</Command></Exec></Actions>",
      ),
    ).toBe("C:\\Program Files\\AgentD Desktop\\resources\\bin\\agentd.exe");
    // schtasks /Query /XML may answer in UTF-16, which the runner decodes as UTF-8.
    const utf16 = Buffer.from(
      `\uFEFF${task("C:\\gone\\agentd.exe", "C:\\R\\services\\agentd-dash.env")}`,
      "utf16le",
    ).toString("utf8");
    expect(taskProgram(utf16)).toBe("C:\\gone\\agentd.exe");
    expect(taskEnvFile(utf16)).toBe("C:\\R\\services\\agentd-dash.env");
    // Decoded from its bytes, a profile folder's non-ASCII name survives.
    const localized = "C:\\Users\\José\\.agentd\\services\\agentd-dash.env";
    for (const bom of ["\uFEFF", ""]) {
      const xml = schtasksText(
        Buffer.from(`${bom}${task("C:\\gone\\agentd.exe", localized)}`, "utf16le"),
      );
      expect(taskEnvFile(xml)).toBe(localized);
    }
    expect(schtasksText(Buffer.from(task("a.exe", localized), "utf8"))).toBe(
      task("a.exe", localized),
    );
    expect(taskNames("dash", undefined)).toEqual(["\\LibraOS\\agentd-dash"]);
    expect(taskNames("dash", "C:\\Users\\Me\\Root\\")[0]).toMatch(
      /^\\LibraOS\\agentd-dash-[0-9a-f]{8}$/,
    );
    // agentd cleans the root before hashing it: one root, one name, however it is spelled.
    expect(taskNames("dash", "C:\\Users\\Me\\Work\\..\\AgentD")).toEqual(
      taskNames("dash", "c:/users/me/./agentd/"),
    );
    // Read as launchd reads a plist: a comment, CDATA or entity doesn't hide the program.
    const commented = plist(OLD).replace(
      "<key>ProgramArguments</key>",
      "<key>ProgramArguments</key><!-- <array></array> -->",
    );
    expect(plistProgram(commented)).toBe(OLD);
    expect(plistProgram(plist("/gone/agentd").replace("/gone/agentd", "<![CDATA[/a&b]]>"))).toBe(
      "/a&b",
    );
    expect(plistProgram(plist("/gone/agentd").replace("/gone/", "/g&#x41;/"))).toBe("/gA/agentd");
    // launchd runs Program over ProgramArguments' first string.
    expect(
      plistProgram(
        plist(OLD).replace(
          "<key>ProgramArguments</key>",
          `<key>Program</key><string>${NEXT}</string><key>ProgramArguments</key>`,
        ),
      ),
    ).toBe(NEXT);
    for (const unknown of [plist(OLD).replace("</plist>", ""), "bplist00"])
      expect(plistProgram(unknown)).toBe(null);
    expect(taskEnvFile(task("agentd.exe", "C:\\R\\services\\agentd-dash.env"))).toBe(
      "C:\\R\\services\\agentd-dash.env",
    );
    expect(
      unitsToEnable(
        "/u: 1 unit(s) changed []\nthen: systemctl --user daemon-reload && systemctl --user enable --now agentd-notify.service agentd-watchdog.timer\n",
      ),
    ).toEqual(["agentd-notify.service", "agentd-watchdog.timer"]);
  });

  it("reports only a service on a missing agentd or the old app's, never the user's own", () => {
    expect(isStaleProgram(OLD, true, NEXT)).toBe(true);
    expect(isStaleProgram("/gone/agentd", false, NEXT)).toBe(true);
    expect(isStaleProgram("/usr/local/bin/agentd", true, NEXT)).toBe(false);
    expect(isStaleProgram(NEXT, true, NEXT)).toBe(false);
    expect(
      isStaleProgram("C:\\Program Files\\AgentD Desktop\\resources\\bin\\agentd.exe", true, NEXT),
    ).toBe(true);
    // A program that exists is never moved, an AppImage's mount while it is up included.
    expect(isStaleProgram("/tmp/.mount_AgentDx1y2z3/resources/agentd/agentd", true, NEXT)).toBe(
      false,
    );
  });

  it("registers an AppImage's agentd only through the copy that outlasts the app", () => {
    const mounted = "/tmp/.mount_AgentDab12/resources/agentd/agentd";
    const record = (action: "installed" | "kept-newer") => ({
      action,
      path: "/home/me/.local/bin/agentd",
      directory: "/home/me/.local/bin",
      onPath: true,
      pathLine: null,
      skills: [],
    });
    expect(serviceAgentd(NEXT, undefined, null)).toBe(NEXT);
    expect(serviceAgentd(mounted, "/tmp/.mount_AgentDab12", record("installed"))).toBe(
      "/home/me/.local/bin/agentd",
    );
    expect(serviceAgentd("/apps/x/agentd", "/apps/x/", record("installed"))).toBe(
      "/home/me/.local/bin/agentd",
    );
    // The person's own agentd kept at the install location, or no install yet: nothing lasting.
    expect(serviceAgentd(mounted, "/tmp/.mount_AgentDab12", record("kept-newer"))).toBe(null);
    expect(serviceAgentd(mounted, undefined, null)).toBe(null);
  });

  it("sets up with the installed copy when the bundled agentd's path has a space", () => {
    const inApp = "/Applications/AgentD Next.app/Contents/Resources/agentd/agentd";
    const record = (action: "unchanged" | "kept-newer", path: string) => ({
      action,
      path,
      directory: "/Users/me/.local/bin",
      onPath: true,
      pathLine: null,
      skills: [],
    });
    const installed = "/Users/me/.local/bin/agentd";
    expect(setupAgentd(inApp, record("unchanged", installed))).toBe(installed);
    expect(setupAgentd("/opt/AgentD/agentd", record("unchanged", installed))).toBe(
      "/opt/AgentD/agentd",
    );
    // The person's own agentd there, no install yet, or a copy clients take no better.
    expect(setupAgentd(inApp, record("kept-newer", installed))).toBe(inApp);
    expect(setupAgentd(inApp, null)).toBe(inApp);
    expect(setupAgentd(inApp, record("unchanged", "/Users/my name/.local/bin/agentd"))).toBe(inApp);
  });

  it.effect("reports stale services, and re-registers them only when Repair is confirmed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const agents = path.join(home, "Library", "LaunchAgents");
      yield* fs.makeDirectory(agents, { recursive: true });
      const watchdogPlist = path.join(agents, "com.libraos.agentd.watchdog.plist");
      const dashPlist = path.join(agents, "com.libraos.agentd.dash.plist");
      yield* fs.writeFileString(watchdogPlist, plist(OLD));
      const bundled = path.join(home, "agentd");
      yield* fs.writeFileString(bundled, "");
      yield* fs.writeFileString(dashPlist, plist(bundled));
      const runs: Array<ReadonlyArray<string>> = [];
      const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
        runs.push([input.command, ...input.args]);
        return Effect.succeed(
          output(
            input.args[0] === "install"
              ? "then: systemctl --user daemon-reload && systemctl --user enable --now agentd-watchdog.timer\n"
              : "",
          ),
        );
      };
      const deps = { bundled, target: bundled, platform: "darwin", home, root: undefined, run };

      // Found, named and left alone: nothing runs until Repair.
      const problem = yield* detectServices(deps);
      expect(problem).toEqual({
        services: [{ name: "watchdog", program: OLD }],
        agentd: bundled,
        moves: ["watchdog", "dash"],
      });
      expect(acted(runs)).toEqual([]);
      expect(yield* repairServices(deps, problem!)).toEqual({ ok: true });
      expect(acted(runs)).toEqual([[bundled, "install"]]);

      // Healthy services: no notice.
      runs.length = 0;
      yield* fs.writeFileString(watchdogPlist, plist(bundled));
      expect(yield* detectServices(deps)).toBe(null);
      // One on an AgentD that exists, the user's own: never a notice either.
      const own = path.join(home, "own-agentd");
      yield* fs.writeFileString(own, "");
      yield* fs.writeFileString(dashPlist, plist(own));
      expect(yield* detectServices(deps)).toBe(null);

      // A stale watchdog beside a dash on the user's own agentd: install would move both, so no
      // Repair is offered, and a Repair asked for anyway runs nothing.
      yield* fs.writeFileString(watchdogPlist, plist(OLD));
      const kept = yield* detectServices(deps);
      expect(kept).toEqual({
        services: [{ name: "watchdog", program: OLD }],
        agentd: bundled,
        moves: [],
        kept: ["dash"],
      });
      expect(yield* repairServices(deps, kept!)).toEqual({ ok: false });
      expect(acted(runs)).toEqual([]);
      // A dash plist that is there but can't be read is not an absent one: install would rewrite it.
      yield* fs.remove(dashPlist);
      yield* fs.makeDirectory(dashPlist);
      expect(yield* detectServices(deps)).toEqual({
        services: [{ name: "watchdog", program: OLD }],
        agentd: bundled,
        moves: [],
        unread: ["dash"],
      });
      yield* fs.remove(dashPlist, { recursive: true });
      // So is one launchd may read but this can't name a program in, such as a binary plist.
      yield* fs.writeFile(dashPlist, new Uint8Array([...Buffer.from("bplist00"), 0xd1, 0x01]));
      expect(yield* detectServices(deps)).toMatchObject({ moves: [], unread: ["dash"] });
      yield* fs.remove(dashPlist);
      // An absent dash is one install registers too: the confirmation names both.
      expect(yield* detectServices(deps)).toMatchObject({ moves: ["watchdog", "dash"] });
      yield* fs.writeFileString(dashPlist, plist(bundled));

      // Linux: each stale service on its own, the program in effect over the unit's drop-ins.
      const units = path.join(home, ".config", "systemd", "user");
      yield* fs.makeDirectory(units, { recursive: true });
      const linux = { ...deps, platform: "linux" };
      yield* fs.writeFileString(
        path.join(units, "agentd-watchdog.service"),
        `[Service]\nExecStart=${bundled} watchdog\n`,
      );
      yield* fs.writeFileString(
        path.join(units, "agentd-dash.service"),
        `[Service]\nExecStart=${bundled} dash --serve 127.0.0.1:21480\n`,
      );
      // A working watchdog's timer is written and enabled.
      yield* fs.writeFileString(path.join(units, "agentd-watchdog.timer"), "[Timer]\n");
      yield* fs.makeDirectory(path.join(units, "timers.target.wants"));
      yield* fs.writeFileString(
        path.join(units, "timers.target.wants", "agentd-watchdog.timer"),
        "",
      );
      expect(yield* detectServices(linux)).toBe(null);
      // A drop-in shared by every agentd- unit can set a stale program; the unit's own drop-in of
      // the same name wins over it.
      yield* fs.makeDirectory(path.join(units, "agentd-.service.d"));
      yield* fs.writeFileString(
        path.join(units, "agentd-.service.d", "exec.conf"),
        "[Service]\nExecStart=\nExecStart=/gone/agentd watchdog\n",
      );
      yield* fs.makeDirectory(path.join(units, "agentd-dash.service.d"));
      yield* fs.writeFileString(path.join(units, "agentd-dash.service.d", "exec.conf"), "");
      // install rewrites only the unit file, so it can't move a program a drop-in sets: no Repair.
      expect(yield* detectServices(linux)).toEqual({
        services: [{ name: "watchdog", program: "/gone/agentd" }],
        agentd: bundled,
        moves: [],
        overridden: ["watchdog"],
      });
      yield* fs.remove(path.join(units, "agentd-.service.d"), { recursive: true });
      yield* fs.writeFileString(
        path.join(units, "agentd-watchdog.service"),
        "[Service]\nExecStart=/gone/agentd watchdog\n",
      );
      // A dash on the user's own agentd: watchdog install leaves it, so it isn't named as kept.
      const dashUnit = path.join(units, "agentd-dash.service");
      yield* fs.writeFileString(dashUnit, `[Service]\nExecStart=${own} dash\n`);
      expect(yield* detectServices(linux)).toEqual({
        services: [{ name: "watchdog", program: "/gone/agentd" }],
        agentd: bundled,
        moves: ["watchdog"],
      });
      yield* fs.writeFileString(dashUnit, `[Service]\nExecStart=${bundled} dash\n`);
      runs.length = 0;
      const watchdog = yield* detectServices(linux);
      expect(watchdog).toEqual({
        services: [{ name: "watchdog", program: "/gone/agentd" }],
        agentd: bundled,
        moves: ["watchdog"],
      });
      expect(acted(runs)).toEqual([]);
      expect(yield* repairServices(linux, watchdog!)).toEqual({ ok: true });
      expect(acted(runs)).toEqual([
        [bundled, "install"],
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "agentd-watchdog.timer"],
      ]);
      yield* fs.writeFileString(
        path.join(units, "agentd-watchdog.service"),
        `[Service]\nExecStart=${bundled} watchdog\n`,
      );

      // A stale dash alone: Repair runs dash install, and leaves the working watchdog.
      yield* fs.writeFileString(
        path.join(units, "agentd-dash.service"),
        "[Service]\nExecStart=/gone/agentd dash --serve 127.0.0.1:21480\n",
      );
      runs.length = 0;
      const dash = yield* detectServices(linux);
      expect(dash).toMatchObject({ moves: ["dash"] });
      expect(yield* repairServices(linux, dash!)).toEqual({ ok: true });
      expect(acted(runs)).toEqual([
        ["systemctl", "--user", "is-active", "agentd-watchdog.timer"],
        [bundled, "dash", "install"],
      ]);
      yield* fs.writeFileString(
        path.join(units, "agentd-dash.service"),
        `[Service]\nExecStart=${bundled} dash --serve 127.0.0.1:21480\n`,
      );

      // agentd withholds the enable step while a legacy unit is enabled: the step it asked for
      // first is passed on, and still shown until the timer is on.
      yield* fs.remove(path.join(units, "timers.target.wants"), { recursive: true });
      yield* fs.remove(path.join(units, "agentd-watchdog.timer"));
      runs.length = 0;
      const legacyRun: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
        runs.push([input.command, ...input.args]);
        return Effect.succeed(
          output(
            input.args[0] === "install"
              ? `${units}: 1 unit(s) changed [enabled:agentops-watchdog.timer]\n` +
                  "legacy units still enabled; first: systemctl --user disable --now agentops-watchdog.timer, then run agentd install again\n"
              : "",
          ),
        );
      };
      expect(
        yield* repairServices({ ...linux, run: legacyRun }, { ...watchdog!, services: [] }),
      ).toEqual({ ok: false, command: "systemctl --user disable --now agentops-watchdog.timer" });
      yield* fs.writeFileString(path.join(units, "agentops-watchdog.timer"), "[Timer]\n");
      yield* fs.makeDirectory(path.join(units, "timers.target.wants"));
      yield* fs.writeFileString(
        path.join(units, "timers.target.wants", "agentops-watchdog.timer"),
        "",
      );
      runs.length = 0;
      expect(yield* detectServices(linux)).toEqual({
        services: [],
        agentd: bundled,
        moves: ["watchdog"],
        command: "systemctl --user disable --now agentops-watchdog.timer",
      });
      yield* fs.writeFileString(
        path.join(units, "timers.target.wants", "agentd-watchdog.timer"),
        "",
      );
      expect(yield* detectServices(linux)).toBe(null);
      expect(acted(runs)).toEqual([["systemctl", "--user", "is-active", "agentd-watchdog.timer"]]);
      // A timer systemd enabled but couldn't start: still reported, and Repair starts it.
      const stopped =
        (state: string): ProcessRunner.ProcessRunner["Service"]["run"] =>
        (input) =>
          Effect.succeed(input.args[1] === "is-active" ? output(`${state}\n`, 3) : output(""));
      for (const state of ["inactive", "failed"])
        expect(yield* detectServices({ ...linux, run: stopped(state) })).toEqual({
          services: [],
          agentd: bundled,
          moves: ["watchdog"],
          watchdogOff: true,
        });
      runs.length = 0;
      // A repair whose reload or enable failed left the timer written but off, legacy units gone:
      // still reported, and Repair enables it again.
      yield* fs.remove(path.join(units, "timers.target.wants"), { recursive: true });
      yield* fs.remove(path.join(units, "agentops-watchdog.timer"));
      // Install wrote the service and failed before the timer: off too, Repair writes it.
      for (const written of [false, true]) {
        if (written)
          yield* fs.writeFileString(path.join(units, "agentd-watchdog.timer"), "[Timer]\n");
        expect(yield* detectServices(linux)).toEqual({
          services: [],
          agentd: bundled,
          moves: ["watchdog"],
          watchdogOff: true,
        });
      }
      expect(acted(runs)).toEqual([]);

      // An AppImage with no lasting agentd to register: reported, with no Repair.
      yield* fs.writeFileString(
        path.join(units, "agentd-watchdog.service"),
        "[Service]\nExecStart=/gone/agentd watchdog\n",
      );
      const transient = yield* detectServices({ ...linux, target: null });
      expect(transient).toMatchObject({ agentd: null, moves: [] });
      expect(yield* repairServices({ ...linux, target: null }, transient!)).toEqual({ ok: false });
      expect(acted(runs)).toEqual([]);

      // Windows: the plain legacy task is reported only when its env file is in this root, and
      // finding it only queries schtasks. A profile folder with a non-ASCII name, in UTF-16.
      const root = path.join(home, "Work", "..", "José");
      let legacyEnv = path.join(home, "José", "services", "agentd-watchdog.env");
      let listing: string | null =
        '"\\Microsoft\\x","N/A","Ready"\r\n"\\LibraOS\\agentd-watchdog","N/A","Ready"\r\n';
      let dashQuery = "";
      const windowsRun: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
        runs.push([input.command, ...input.args]);
        if (input.command !== "schtasks") return Effect.succeed(output(""));
        if (input.args[1] === "/FO")
          return Effect.succeed(listing === null ? output("", 1) : output(listing));
        if (input.args[2]?.includes("agentd-dash")) return Effect.succeed(output(dashQuery, 1));
        const plain = input.args[2] === "\\LibraOS\\agentd-watchdog";
        if (!plain) return Effect.succeed(output("", 1));
        const bytes = Buffer.from(`\uFEFF${task("C:\\gone\\agentd.exe", legacyEnv)}`, "utf16le");
        input.onStdoutChunk?.(bytes);
        // The runner's own text is UTF-8, where those bytes don't decode.
        return Effect.succeed(output(bytes.toString("utf8")));
      };
      const windows = { ...deps, platform: "win32", root, run: windowsRun };
      const stale = yield* detectServices(windows);
      expect(stale).toEqual({
        services: [{ name: "watchdog", program: "C:\\gone\\agentd.exe" }],
        agentd: bundled,
        moves: ["watchdog", "dash"],
      });
      // A dash task that is listed but whose query fails, or no listing at all, isn't taken as
      // absent: install would re-register it unseen, so no Repair.
      dashQuery = "ERROR: The RPC server is unavailable.";
      listing += '"\\LibraOS\\AGENTD-DASH","N/A","Running"\r\n';
      expect(yield* detectServices(windows)).toMatchObject({ moves: [], unread: ["dash"] });
      // Without a listing not even the watchdog's per-root name can be ruled out: nothing to say.
      listing = null;
      expect(yield* detectServices(windows)).toBe(null);
      listing = '"\\LibraOS\\agentd-watchdog","N/A","Ready"\r\n';
      dashQuery = "";
      expect(acted(runs).every(([command]) => command === "schtasks")).toBe(true);
      expect(yield* repairServices(windows, stale!)).toEqual({ ok: true });
      expect(runs.at(-1)).toEqual([bundled, "install"]);
      legacyEnv = path.join(home, "Other", "services", "agentd-watchdog.env");
      runs.length = 0;
      expect(yield* detectServices(windows)).toBe(null);
      expect(acted(runs).every(([command]) => command === "schtasks")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
