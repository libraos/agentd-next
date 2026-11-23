import { describe, expect, it } from "@effect/vitest";

import { cloudJobNote } from "./agentdCloud.ts";
import { AgentdCommandError } from "@t3tools/contracts";

import { CLOUD_REASONS, cloudReason, openKeyFile, startErrorFor } from "./cloudFailure.ts";

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
  ] as const)("%s: %s", (state, message, note) => {
    expect(cloudJobNote(state, [message])).toBe(note);
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
