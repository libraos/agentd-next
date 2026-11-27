type LinkListener = (url: string) => void;

/**
 * Keeps a link tapped while the app starts: React Native drops a `url` event with no listener yet,
 * and React Navigation drops one before its container mounts. Hands links on once the navigator is
 * ready, skipping the launch URL it already opened as its initial state.
 */
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
    /** The URL the app was launched with, as its linking `getInitialURL` resolved it. */
    recordLaunchUrl(url: string | null | undefined) {
      launchUrl = url;
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
