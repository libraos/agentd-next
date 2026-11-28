import { describe, expect, it } from "vite-plus/test";

import { joinedPersonName, joinTeamReturnPath, parseTeamInvitation } from "./JoinTeamScreen.logic";

describe("team invitation links", () => {
  it.each([
    {
      link: " https://team.example:21490/join?ticket=adt_0123456789abcdef&from=welcome ",
      expected: {
        ok: true,
        server: "https://team.example:21490",
        host: "team.example:21490",
        ticket: "adt_0123456789abcdef",
        insecure: false,
      },
    },
    {
      link: "https://team.example/#ticket=adt_fixtureABCD12345",
      expected: {
        ok: true,
        server: "https://team.example",
        host: "team.example",
        ticket: "adt_fixtureABCD12345",
        insecure: false,
      },
    },
    {
      link: "http://[::1]:21490/join?ticket=adt_0123456789abcdef",
      expected: {
        ok: true,
        server: "http://[::1]:21490",
        host: "[::1]:21490",
        ticket: "adt_0123456789abcdef",
        insecure: true,
      },
    },
  ])("extracts the origin and ticket from $link", ({ link, expected }) => {
    expect(parseTeamInvitation(link)).toEqual(expected);
  });

  it.each([
    ["not an invitation", "invalid-link"],
    ["https:team.example?ticket=adt_0123456789abcdef", "invalid-link"],
    ["https://someone@team.example/?ticket=adt_0123456789abcdef", "invalid-link"],
    ["https://adt_0123456789abcdef.example/?ticket=adt_0123456789abcdef", "invalid-link"],
    ["http://team.example/?ticket=adt_0123456789abcdef", "https-required"],
    ["http://192.168.1.24/?ticket=adt_0123456789abcdef", "https-required"],
    ["ftp://team.example/?ticket=adt_0123456789abcdef", "https-required"],
    ["https://team.example/login?invite=abc123", "invalid-ticket"],
    ["https://team.example/?ticket=adt_short", "invalid-ticket"],
    [
      "https://team.example/?ticket=adt_0123456789abcdef#ticket=adt_fixtureABCD12345",
      "invalid-ticket",
    ],
  ])("rejects %s without returning the link or ticket", (link, reason) => {
    expect(parseTeamInvitation(link)).toEqual({ ok: false, reason });
  });
});

describe("joined person", () => {
  it("uses the identity from connect, not the one on the old device", () => {
    expect(
      joinedPersonName(
        "joined https://team.example as device dvc_new (cli, person Mira Chen), protocol 3; credential in /agentd/device (mode 600), never shown\n" +
          "this replaces device dvc_old on https://previous.example: a person there revokes it with agentd server devices revoke dvc_old",
      ),
    ).toBe("Mira Chen");
    expect(joinedPersonName("agentd did not report a person")).toBeNull();
  });
});

describe("joinTeamReturnPath", () => {
  const paths = ["/settings/general", "/settings/providers"] as const;

  it("returns to the Settings page that opened Join a team", () => {
    expect(joinTeamReturnPath("/settings/providers", paths)).toBe("/settings/providers");
  });

  it("returns to the welcome page from anywhere else", () => {
    expect(joinTeamReturnPath(undefined, paths)).toBeNull();
    expect(joinTeamReturnPath("https://example.com/settings/providers", paths)).toBeNull();
    expect(joinTeamReturnPath("/settings/providers/../../", paths)).toBeNull();
  });
});
