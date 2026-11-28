import { AgentdCommandError, EnvironmentId, type AgentdCommandOutput } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { JoinTeamScreen } from "./JoinTeamScreen";

const { runJoin } = vi.hoisted(() => ({ runJoin: vi.fn() }));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("primary"),
}));

vi.mock(import("../../lib/agentdState"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const allowed = Atom.make(true);
  return {
    ...actual,
    agentdEnvironment: {
      ...actual.agentdEnvironment,
      joinTeam: {
        ...actual.agentdEnvironment.joinTeam,
        permissionAtom: () => allowed,
        // The command runs as an Effect; the test settles it with a promise.
        run: (_registry, target) =>
          Effect.tryPromise({
            try: () => runJoin(target) as Promise<AgentdCommandOutput>,
            catch: (error) => error as AgentdCommandError,
          }),
      },
    },
  };
});

it("clears the invite immediately, shows the refusal, and confirms a successful retry", async () => {
  const expiredTicket = "adt_0123456789abcdef";
  const freshTicket = "adt_fixtureABCD12345";
  const pending = Promise.withResolvers<AgentdCommandOutput>();
  runJoin.mockReset().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
    output:
      "joined https://team.example as device dvc_new (cli, person Mira Chen), protocol 3; credential in /agentd/device (mode 600), never shown",
  });
  await using screen = await render(<JoinTeamScreen />, { router: "/welcome?screen=team" });
  using warn = vi.spyOn(console, "warn");
  const input = screen.getByLabelText("Team invitation link");
  const submit = screen.getByRole("button", { name: "Join team" });

  await input.fill("not an invitation");
  await submit.click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Paste a complete LibraOS Engine team invitation link.");
  await input.fill("http://team.example/?ticket=adt_0123456789abcdef");
  await submit.click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent(
      "Use an HTTPS invitation link. HTTP is only allowed for a server on this computer.",
    );
  expect(runJoin).not.toHaveBeenCalled();
  await input.fill("http://127.0.0.1:21490/?ticket=adt_0123456789abcdef");
  await expect
    .element(
      screen.getByText(
        "This connection is not encrypted. Join only if you trust the local server.",
      ),
    )
    .toBeVisible();

  await input.fill("https://team.example/join?ticket=adt_0123456789abcdef");
  await expect.element(screen.getByText("Team server: team.example")).toBeVisible();
  await submit.click();
  await expect.element(input).toHaveValue("");
  await expect.element(screen.getByRole("button", { name: "Joining…" })).toBeDisabled();
  expect(runJoin).toHaveBeenCalledWith({
    environmentId: "primary",
    input: { server: "https://team.example", ticket: expiredTicket },
  });
  expect(screen.router?.state.location.href).toBe("/welcome?screen=team");

  await act(() => {
    pending.reject(
      new AgentdCommandError({
        message: `Ticket ${expiredTicket} expired.\nAsk your team for a new invitation.`,
        notSetUp: false,
      }),
    );
  });
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Ticket [redacted] expired. Ask your team for a new invitation.");
  expect(warn).not.toHaveBeenCalledWith(
    "[atom-command] environment-data:agentd:join-team failed",
    expect.anything(),
  );

  await input.fill("https://team.example/#ticket=adt_fixtureABCD12345");
  await submit.click();
  await expect.element(screen.getByText("Joined the team at team.example.")).toBeVisible();
  await expect.element(screen.getByText("You joined as Mira Chen.")).toBeVisible();
  await expect.element(input).not.toBeInTheDocument();
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(expiredTicket);
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(freshTicket);
  await screen.getByRole("link", { name: "Done" }).click();
  await vi.waitFor(() => expect(screen.router?.state.location.href).toBe("/welcome"));
});

it("opened from Settings, Back returns to the Settings page that opened it", async () => {
  runJoin.mockReset();
  await using screen = await render(<JoinTeamScreen />, {
    router: "/welcome?screen=team&from=%2Fsettings%2Fproviders",
  });
  await expect
    .element(screen.getByRole("link", { name: "Back" }))
    .toHaveAttribute("href", "/settings/providers");
});
