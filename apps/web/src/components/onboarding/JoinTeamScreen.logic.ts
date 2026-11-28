import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

const TICKET = /^adt_[A-Za-z0-9_-]{16,200}$/;
const invalidLink = { ok: false, reason: "invalid-link" } as const;
const httpsRequired = { ok: false, reason: "https-required" } as const;

export function parseTeamInvitation(value: string) {
  const link = value.trim();
  if (/[\s\\]/.test(link)) return invalidLink;

  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return invalidLink;
  }
  const insecure = url.protocol === "http:";
  if (url.protocol !== "https:" && !insecure) return httpsRequired;
  if (
    !/^https?:\/\/[^/?#]/i.test(link) ||
    url.username ||
    url.password ||
    url.host.toLowerCase().includes("adt_") ||
    url.origin.length > 2048
  ) {
    return invalidLink;
  }
  if (insecure && (!isLocalLoopbackHost(url.hostname) || url.hostname.endsWith("."))) {
    return httpsRequired;
  }

  const tickets = [
    ...url.searchParams.getAll("ticket"),
    ...new URLSearchParams(url.hash.slice(1)).getAll("ticket"),
  ];
  const [ticket] = tickets;
  if (tickets.length !== 1 || ticket === undefined || !TICKET.test(ticket)) {
    return { ok: false, reason: "invalid-ticket" } as const;
  }
  return { ok: true, server: url.origin, host: url.host, ticket, insecure } as const;
}

export function joinedPersonName(output: string): string | null {
  return /^joined \S+ as device \S+ \(cli, person (.+)\), protocol \d+;/m.exec(output)?.[1] ?? null;
}

/** Where Join a team's Back and Done go: the Settings page that opened it, else the welcome page. */
export function joinTeamReturnPath<Path extends string>(
  from: unknown,
  settingsPaths: ReadonlyArray<Path>,
): Path | null {
  return settingsPaths.find((path) => path === from) ?? null;
}
