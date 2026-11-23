import type { ComponentProps } from "react";
import appMarkUrl from "../../../../assets/prod/app-icon.icon/Assets/text.svg";
import { cn } from "../lib/utils";

export function T3Wordmark(props: Omit<ComponentProps<"img">, "alt" | "src">) {
  return (
    <img {...props} src={appMarkUrl} alt="" className={cn("object-contain", props.className)} />
  );
}

const WORDMARK_NAME = "AgentD";
const WORDMARK_QUALIFIER = "Next";
const WORDMARK_MAKER = "by LibraOS";

export function AgentDWordmark({ onBackdrop = false }: { readonly onBackdrop?: boolean }) {
  const muted = onBackdrop ? "text-white/70" : "text-muted-foreground";
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap font-medium tracking-tight">
      <span className="font-semibold">{WORDMARK_NAME}</span>{" "}
      <span className={muted}>{WORDMARK_QUALIFIER}</span>{" "}
      <span className={cn("text-2xs font-normal tracking-normal", muted)}>{WORDMARK_MAKER}</span>
    </span>
  );
}
