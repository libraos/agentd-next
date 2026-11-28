import { describe, expect, it } from "@effect/vitest";

import { cloudJobNote } from "./agentdCloud.ts";
import { AgentdCommandError } from "@t3tools/contracts";

import {
  CLOUD_REASONS,
  cloudFailureReason,
  cloudReason,
  cloudSetupProblem,
  openKeyFile,
  refusedBeforeTask,
  startErrorFor,
} from "./cloudFailure.ts";

describe("cloudJobNote", () => {
  it.each([
    ["failed", "OAuth access token is invalid (401)", CLOUD_REASONS.subscriptionSignIn],
    ["failed", "API Error: 401 authentication_error", CLOUD_REASONS.subscriptionSignIn],
    ["failed", "claude subscription jobs are not enabled", CLOUD_REASONS.subscriptionUnavailable],
    ["failed", "ChatGPT subscription jobs are not enabled", CLOUD_REASONS.chatgptUnavailable],
    [
      "failed",
      "Codex could not sign in with your ChatGPT login (expired or revoked)",
      CLOUD_REASONS.chatgptSignIn,
    ],
    ["failed", "your ChatGPT plan's usage limit was reached", CLOUD_REASONS.chatgptLimit],
    // A BYOK job runs Codex on an API key: its sign-in failure is the provider's, not ChatGPT's.
    ["failed", "codex could not sign in: invalid api key", CLOUD_REASONS.providerSignIn],
    ["failed", "the GitHub App is not installed on acme/app", CLOUD_REASONS.repository],
    ["failed", "check exited 1", CLOUD_REASONS.check],
    ["failed", "git push refused by GitHub", CLOUD_REASONS.push],
    ["failed", "Job API 502", "The cloud worker could not finish the task."],
    ["budget_exceeded", "", "The task reached its spending limit."],
    // A path naming byok or cloud-key is not a key or setup problem.
    [
      "failed",
      "wrote /home/me/byok/cloud-key/out.log",
      "The cloud worker could not finish the task.",
    ],
    ["submitting", "402: insufficient credit", CLOUD_REASONS.credit],
    ["running", "runner starting, timed out once", null],
    ["completed", "the GitHub App is not installed on acme/app", CLOUD_REASONS.repository],
    // Engine's job result when the Job API could not mint a token for the repository.
    [
      "failed_verification",
      "Nothing pushed: no repository access: the GitHub App is not installed on acme/app",
      CLOUD_REASONS.repository,
    ],
    ["failed", "Nothing pushed: no repository access to push", CLOUD_REASONS.repository],
  ] as const)("%s: %s", (state, message, note) => {
    expect(cloudJobNote(state, [message])).toBe(note);
  });
});

describe("cloudSetupProblem", () => {
  it.each(["agentd", "libraos-core", "libraos-engine"])(
    "reads the current not-set-up wording naming %s as setup",
    (command) => {
      const message = `Cloud Workers are not set up: [cloud] url is missing. Run ${command} cloud setup`;
      expect(cloudSetupProblem(message)).toBe("setup");
      expect(cloudSetupProblem(message.toLowerCase())).toBe("setup");
      expect(cloudReason(message)).toBe(CLOUD_REASONS.setup);
      expect(refusedBeforeTask(message)).toBe(true);
    },
  );

  it.each([
    "a cloud handoff needs [cloud] url for the Job API. Run agentd cloud setup",
    "set [cloud] url in config.toml",
    "cloud_not_configured: run libraos-engine cloud setup",
    "agentd access revoked",
    "cloud.key_file /home/me/.config/agentd/cloud.key: no such file or directory",
    "[cloud] key_file /home/me/cloud.key cannot be read",
  ])("keeps reading an older Engine's wording as setup: %s", (message) => {
    expect(cloudSetupProblem(message)).toBe("setup");
  });

  it.each([
    ["wrote /home/me/cloud-workers-not-set-up/out.log", null],
    ["402: insufficient credit", "credit"],
    ["the GitHub App is not installed on acme/app", "repository"],
    ["no repository access: the GitHub App is not installed on acme/app", "repository"],
    ["Nothing pushed: no repository access to push", "repository"],
    ["wrote /home/me/no-repository-access/out.log", null],
  ] as const)("%s is %s", (message, problem) => {
    expect(cloudSetupProblem(message)).toBe(problem);
  });
});

describe("cloudReason", () => {
  it.each([
    [
      "a cloud handoff needs [cloud] url for the Job API. Run agentd cloud setup",
      CLOUD_REASONS.setup,
    ],
    [
      "--model-access subscription needs your Claude token: run claude setup-token on your own machine",
      CLOUD_REASONS.subscriptionToken,
    ],
    [
      "--model-access subscription needs your ChatGPT login: run codex login, then pass --codex-auth-file FILE",
      CLOUD_REASONS.chatgptAuth,
    ],
    [
      "both cloud.claude_token_file and cloud.codex_auth_file are set: pass --claude-token-file or --codex-auth-file",
      CLOUD_REASONS.pickPlan,
    ],
    [
      "cloud.claude_token_file must hold the token from claude setup-token (it starts sk-ant-oat) alone, on one line",
      CLOUD_REASONS.subscriptionTokenFormat,
    ],
    [
      "--anthropic-key-file /Users/me/my keys/anthropic.key can be read or written by others (mode 644)",
      "/Users/me/my keys/anthropic.key can be read by other users. Run chmod 600 '/Users/me/my keys/anthropic.key', then try again.",
    ],
    [
      "cloud.openai_key_file /srv/openai.key belongs to another user (uid 501)",
      "/srv/openai.key belongs to another user. Copy it to a file of your own, run chmod 600 on that copy, then choose it.",
    ],
    [
      "cloud.openai_key_file /home/me/it's;rm.key can be read or written by others (mode 644)",
      "/home/me/it's;rm.key can be read by other users. Run chmod 600 '/home/me/it'\\''s;rm.key', then try again.",
    ],
    ["the key file can be read or written by others", CLOUD_REASONS.privateFile],
  ] as const)("%s", (message, reason) => {
    expect(cloudReason(message)).toBe(reason);
  });
});

// libraos/next#287: the job result when the hosted gateway had no usable provider credential.
const GATEWAY_503 = `API Error: 503 auth_unavailable: no auth available (providers=claude, model=claude-sonnet-5-5;
last upstream error: unauthorized: token: [REDACTED] "error_description": "Refresh token: [REDACTED]);
check Claude auth/key session and cooldown state via /v0/management/auth-files.
This is a server-side issue, usually temporary — try again in a moment.
If it persists, check your inference gateway (api.example.com).
level=fatal msg="exec failed with exit code 1"`;

describe("gateway model access unavailable", () => {
  it.each(["failed_verification", "failed"])(
    "a %s job whose gateway had no auth is not blamed on the check or the user",
    (state) => {
      const note = cloudFailureReason(state, [GATEWAY_503, null]);
      expect(note).toBe(CLOUD_REASONS.gatewayUnavailable);
      expect(cloudJobNote(state, [GATEWAY_503])).toBe(CLOUD_REASONS.gatewayUnavailable);
    },
  );

  it("does not blame the user's credentials or quote the gateway's internals", () => {
    const reason = CLOUD_REASONS.gatewayUnavailable;
    expect(reason).not.toBe(CLOUD_REASONS.providerSignIn);
    expect(reason).not.toBe(CLOUD_REASONS.subscriptionSignIn);
    expect(reason).not.toMatch(/management|auth-files|\/v0\//);
    expect(reason).toMatch(/try again later/i);
    expect(reason).toMatch(/subscription or API key/i);
  });

  it("matches the gateway's own wording even beside other credential words", () => {
    expect(cloudReason("503 auth_unavailable: no auth available (providers=codex)")).toBe(
      CLOUD_REASONS.gatewayUnavailable,
    );
    // An OAuth 401 upstream inside the gateway's message is still the gateway's.
    expect(
      cloudReason(
        "API Error: 503 auth_unavailable: no auth available (providers=claude; last upstream error: OAuth authentication_error 401)",
      ),
    ).toBe(CLOUD_REASONS.gatewayUnavailable);
  });

  it.each([
    [
      "failed",
      "wrote /home/me/auth-503/auth_service/out.log",
      "The cloud worker could not finish the task.",
    ],
    ["failed_verification", "check exited 1 in acme/auth-unavailable-503", CLOUD_REASONS.check],
    ["failed", "API Error: 503 Service Unavailable", "The cloud worker could not finish the task."],
    ["failed", "OAuth access token is invalid (401)", CLOUD_REASONS.subscriptionSignIn],
    [
      "failed",
      "Codex could not sign in with your ChatGPT login: refresh token expired",
      CLOUD_REASONS.chatgptSignIn,
    ],
  ] as const)("%s: %s keeps its reason", (state, message, note) => {
    expect(cloudFailureReason(state, [message])).toBe(note);
  });

  it("is not a refusal before a task, since the job was created and ran", () => {
    expect(refusedBeforeTask(GATEWAY_503)).toBe(false);
  });
});

describe("openKeyFile", () => {
  it("names only a file others can read, which the app may make private", () => {
    expect(
      openKeyFile(
        "--openai-key-file /home/me/openai.key can be read or written by others (mode 664)",
      ),
    ).toBe("/home/me/openai.key");
    expect(
      openKeyFile("cloud.openai_key_file /srv/openai.key belongs to another user (uid 501)"),
    ).toBe(null);
    expect(openKeyFile("check exited 1")).toBe(null);
  });
});

describe("startErrorFor", () => {
  it("names whose key a file holds only to a connection that may read host files", () => {
    const wrong = new AgentdCommandError({
      message: "The file in the OpenAI key field holds an Anthropic key.",
      notSetUp: false,
      wrongKeyFile: "openai",
    });
    expect(startErrorFor(wrong, true, [])).toBe(wrong);
    const hidden = startErrorFor(wrong, false, []);
    expect(hidden).toMatchObject({ message: CLOUD_REASONS.keyFile });
    expect(hidden).not.toHaveProperty("wrongKeyFile");
    const other = new AgentdCommandError({ message: "x", notSetUp: false });
    expect(startErrorFor(other, false, [])).toBe(other);
  });

  it("names a shared credential file to a connection without host reads only if it entered it", () => {
    const opened =
      "--claude-token-file /srv/personal/claude-token can be read or written by others";
    const shared = new AgentdCommandError({
      message: cloudReason(opened)!,
      notSetUp: false,
      privateFile: openKeyFile(opened)!,
    });
    expect(startErrorFor(shared, true, [])).toBe(shared);
    // The host's configured token file, which this connection never named.
    const hidden = startErrorFor(shared, false, []);
    expect(hidden.message).toBe(CLOUD_REASONS.privateFile);
    expect(hidden).not.toHaveProperty("privateFile");
    expect(startErrorFor(shared, false, ["/srv/personal/claude-token"])).toBe(shared);
    const owned = new AgentdCommandError({
      message: cloudReason("cloud.claude_token_file /srv/t belongs to another user (uid 501)")!,
      notSetUp: false,
    });
    expect(owned.message).toContain("/srv/t");
    expect(startErrorFor(owned, false, []).message).toBe(CLOUD_REASONS.privateFile);
    expect(startErrorFor(owned, false, ["/srv/t"])).toBe(owned);
  });
});
