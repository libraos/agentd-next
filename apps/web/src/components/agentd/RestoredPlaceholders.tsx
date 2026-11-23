import type { ScopedThreadRef } from "@t3tools/contracts";
import { T } from "gt-react";

import { useThreadPlaceholders } from "~/lib/agentdState";
import {
  hasPlaceholders,
  restorePlaceholderPlugins,
  restorePlaceholders,
} from "./restorePlaceholders.logic";

/** ChatMarkdown props that show `text`'s placeholders as their originals, and whether any are. */
export function useRestoredMarkdown(threadRef: ScopedThreadRef | null | undefined, text: string) {
  const map = useThreadPlaceholders(threadRef);
  const restoring = map !== null && hasPlaceholders(text, map);
  return {
    restoring,
    markdownProps: restoring ? { extraRemarkPlugins: restorePlaceholderPlugins(map) } : {},
  };
}

/** `text` with the thread's placeholders replaced by their originals, as copy gives it. */
export function useRestoredText(threadRef: ScopedThreadRef | null | undefined, text: string) {
  return restorePlaceholders(text, useThreadPlaceholders(threadRef));
}

export function RestoredPlaceholdersNote() {
  return (
    <p className="mt-1 text-muted-foreground text-xs">
      <T>Highlighted values are shown restored here. The agent saw only placeholders.</T>
    </p>
  );
}
