type LinkListener = (url: string) => void;

/**
 * Keeps a link tapped while the app starts: React Native drops a `url` event with no listener yet,
 * and React Navigation drops one before its container mounts. Hands links on once the navigator is
 * ready, skipping the launch URL it already opened as its initial state. A link iOS drops natively
 * before JS listens opens as that initial state instead (`initialUrl`).
 */
function readKeptLink(readKept: () => string | null | undefined): string | null {
  try {
    return readKept() ?? null;
  } catch (error) {
    console.warn("[startup-links] could not read the link native code kept", error);
    return null;
  }
}

export function createStartupLinks(whenReady: (deliver: () => void) => void) {
  const pending: string[] = [];
  let listener: LinkListener | undefined;
  let launchUrl: string | null | undefined;
  let ready = false;

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
    /** A `url` event, from when the bundle loads. */
    receive(url: string) {
      pending.push(url);
      if (listener) whenReady(deliver);
    },
    /**
     * The URL the navigator opens with, for its linking `getInitialURL`: the launch URL, else the
     * link native code kept. iOS fires no `url` event for a link that reaches the running app
     * before JS listens; only expo-linking's native side keeps it. The kept link is read only when
     * there is no launch URL, and one that cannot be read leaves the launch without a link.
     */
    async initialUrl(
      readLaunch: () => Promise<string | null | undefined>,
      readKept: () => string | null | undefined,
    ) {
      const launch = await readLaunch();
      launchUrl = launch ?? readKeptLink(readKept);
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
