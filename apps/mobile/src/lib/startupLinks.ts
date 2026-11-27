type LinkListener = (url: string) => void;

/**
 * The last link native code received, kept whether or not JS listened (expo-linking on iOS). The
 * slot is never emptied natively, so it is cleared once JS has seen the link.
 */
export interface KeptLink {
  read(): string | null | undefined;
  clear(): void;
}

function attempt<T>(what: string, run: () => T): T | null {
  try {
    return run();
  } catch (error) {
    console.warn(`[startup-links] could not ${what} the link native code kept`, error);
    return null;
  }
}

/**
 * Keeps a link tapped while the app starts: React Native drops a `url` event with no listener yet,
 * and React Navigation drops one before its container mounts. Hands links on once the navigator is
 * ready, skipping the launch URL it already opened as its initial state. A link iOS drops natively
 * before JS listens opens as that initial state instead, from `keptLink`.
 */
export function createStartupLinks(whenReady: (deliver: () => void) => void, keptLink?: KeptLink) {
  const pending: string[] = [];
  let listener: LinkListener | undefined;
  let launchUrl: string | null | undefined;
  let ready = false;

  const clearKept = () => {
    if (keptLink) attempt("clear", () => keptLink.clear());
  };

  const takeKept = () => {
    if (!keptLink) return null;
    const kept = attempt("read", () => keptLink.read()) ?? null;
    if (kept !== null) clearKept();
    return kept;
  };

  const deliver = () => {
    if (!ready) {
      ready = true;
      const launch = launchUrl == null ? -1 : pending.indexOf(launchUrl);
      if (launch !== -1) pending.splice(launch, 1);
    }
    const open = listener;
    if (open) for (const url of pending.splice(0)) open(url);
  };

  return {
    /** A `url` event, from when the bundle loads. JS has the link, so native code need not keep it. */
    receive(url: string) {
      clearKept();
      pending.push(url);
      if (listener) whenReady(deliver);
    },
    /**
     * The URL the navigator opens with: the launch URL, else the link native code kept (iOS fires
     * no `url` event for a link that reaches the app before JS listens). Taking the kept link
     * clears it, so a JS reload after an update does not open it again.
     */
    async initialUrl(readLaunch: () => Promise<string | null | undefined>) {
      const launch = await readLaunch();
      launchUrl = launch ?? takeKept();
      return launchUrl;
    },
    /** A linking `subscribe`. */
    subscribe(next: LinkListener) {
      listener = next;
      whenReady(deliver);
      return () => {
        if (listener === next) listener = undefined;
      };
    },
  };
}
