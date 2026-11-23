import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { T, useGT } from "gt-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { agentdEnvironment } from "../../lib/agentdState";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { joinedPersonName, parseTeamInvitation } from "./JoinTeamScreen.logic";

export function JoinTeamScreen() {
  const gt = useGT();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const environmentId = usePrimaryEnvironmentId();
  const canJoin = useAtomValue(agentdEnvironment.joinTeam.permissionAtom(environmentId));
  const joinTeam = useAtomCommand(agentdEnvironment.joinTeam, {
    reportFailure: false,
    reportDefect: false,
  });
  const [preview, setPreview] = useState<{ host: string; insecure: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [joined, setJoined] = useState<{ host: string; person: string | null } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = inputRef.current;
    if (field === null || environmentId === null || !canJoin || isJoining) return;

    const invitation = parseTeamInvitation(field.value);
    field.value = "";
    setPreview(null);
    if (!invitation.ok) {
      setError(
        invitation.reason === "https-required"
          ? gt("Use an HTTPS invitation link. HTTP is only allowed for a server on this computer.")
          : invitation.reason === "invalid-ticket"
            ? gt(
                "This link must contain one valid LibraOS Core device ticket. Ask your team for a new link.",
              )
            : gt("Paste a complete LibraOS Core team invitation link."),
      );
      field.focus();
      return;
    }

    const { host, server, ticket } = invitation;
    setError(null);
    setIsJoining(true);
    const result = await joinTeam({ environmentId, input: { server, ticket } });
    setIsJoining(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error && cause.message
          ? cause.message.replaceAll(ticket, "[redacted]")
          : gt("Could not join the team. Try again with a new invitation link."),
      );
      return;
    }
    setJoined({
      host,
      person: joinedPersonName(result.value.output.replaceAll(ticket, "[redacted]")),
    });
  }

  return (
    <div className="mx-auto max-w-md space-y-5 text-center">
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">
        <T>Join a team</T>
      </h1>
      {joined ? (
        <div className="space-y-2 break-words" role="status">
          <p className="font-medium">{gt("Joined the team at {host}.", { host: joined.host })}</p>
          {joined.person ? (
            <p className="text-sm text-muted-foreground">
              {gt("You joined as {person}.", { person: joined.person })}
            </p>
          ) : null}
        </div>
      ) : (
        <form className="space-y-4" autoComplete="off" onSubmit={submit}>
          <div className="space-y-2 text-start">
            <Label htmlFor={inputId}>
              <T>Team invitation link</T>
            </Label>
            <Input
              nativeInput
              id={inputId}
              ref={inputRef}
              type="password"
              autoComplete="off"
              disabled={isJoining}
              aria-invalid={error !== null}
              onChange={(event) => {
                const invitation = parseTeamInvitation(event.currentTarget.value);
                setPreview(
                  invitation.ok ? { host: invitation.host, insecure: invitation.insecure } : null,
                );
                setError(null);
              }}
            />
            {preview ? (
              <div role="status" className="space-y-1 break-words text-sm text-muted-foreground">
                <p>{gt("Team server: {host}", { host: preview.host })}</p>
                {preview.insecure ? (
                  <p className="text-warning-foreground">
                    <T>
                      This connection is not encrypted. Join only if you trust the local server.
                    </T>
                  </p>
                ) : null}
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          {!canJoin ? (
            <p className="text-sm text-muted-foreground">
              <T>Joining a team requires maintenance access to this environment.</T>
            </p>
          ) : null}
          <Button type="submit" disabled={!canJoin || isJoining}>
            {isJoining ? gt("Joining…") : gt("Join team")}
          </Button>
        </form>
      )}
      <div>
        <Button
          variant={joined ? "default" : "link"}
          render={<Link to="/welcome" search={{ screen: undefined }} hash={true} />}
        >
          {joined
            ? gt("Done", { $context: "button, exits a finished setup step" })
            : gt("Back", { $context: "button, returns to the previous setup step" })}
        </Button>
      </div>
    </div>
  );
}
