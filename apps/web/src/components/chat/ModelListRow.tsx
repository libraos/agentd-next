import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { memo } from "react";
import { CheckIcon, ChevronDownIcon, StarIcon } from "lucide-react";
import { getDisplayModelName } from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export interface ModelRowSource {
  readonly instanceId: ProviderInstanceId;
  readonly slug: string;
  readonly label: string;
  readonly color: string;
}

function SourceDot({ color }: { readonly color: string }) {
  return (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  );
}

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  slug: string;
  name: string;
  subProvider?: string | undefined;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  /** Where the model runs: a sign-in, or a gateway and the agent that runs it. */
  sourceLabel: string;
  /** Another source of the model in the row above, listed under it. */
  isVariant?: boolean;
  /** The source's color: its accent, else its provider's. */
  sourceColor: string;
  /** Every source of a model that has several, this row's included; shown while the row is pointed at. */
  sources?: ReadonlyArray<ModelRowSource> | undefined;
  onPickSource?: (instanceId: ProviderInstanceId, slug: string) => void;
  /** Given when the model has other sources: lists them under this row. */
  onToggleVariants?: () => void;
  variantsExpanded?: boolean;
  isFavorite: boolean;
  isSelected: boolean;
  /** Marks this instance apart from another of the same provider. */
  showInstanceBadge: boolean;
  showNewBadge?: boolean;
  unavailable?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: (instanceId: ProviderInstanceId, slug: string) => void;
}) {
  const gt = useGT();
  const model = {
    slug: props.slug,
    name: props.name,
    subProvider: props.subProvider,
  };

  const row = (
    <ComboboxItem
      hideIndicator
      selectedFill={false}
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      {/* One row shape in every tab: the logo names the provider, so Favorites needs no second line. */}
      {props.isVariant ? <span className="w-3 shrink-0" aria-hidden="true" /> : null}
      <ProviderInstanceIcon
        driverKind={props.driverKind}
        displayName={props.providerDisplayName}
        accentColor={props.providerAccentColor}
        acpRegistryAgentId={props.acpRegistryAgentId}
        acpRegistryIconUrl={props.acpRegistryIconUrl}
        showBadge={props.showInstanceBadge}
        className="size-4"
        iconClassName="size-4"
        indicatorBackground="var(--popover)"
        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
      />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <div
          className="min-w-0 truncate text-sm font-normal leading-snug"
          // Names the row in full on hover only when it is cut off.
          onPointerEnter={(event) => {
            const name = event.currentTarget;
            name.title = name.scrollWidth > name.clientWidth ? getDisplayModelName(model) : "";
          }}
        >
          {getDisplayModelName(model)}
          {/* The logo is decorative, so name the provider for screen readers. */}
          <span className="sr-only">, {props.providerDisplayName}</span>
        </div>
        {props.isSelected ? <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
        {props.subProvider ? (
          <span className="min-w-0 shrink truncate text-xs text-muted-foreground/70">
            {props.subProvider}
          </span>
        ) : null}
        {props.showNewBadge ? (
          <span
            className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-update-foreground"
            aria-label={gt("New model")}
          >
            {gt("New", { $context: "badge on a newly added model" })}
          </span>
        ) : null}
        {props.unavailable ? (
          <Badge variant="outline" size="sm">
            <T context="badge on a model that cannot be selected">Unavailable</T>
          </Badge>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {/* Pointing at a model with several sources offers each one, in its color. */}
        {props.sources && !props.disabledReason ? (
          <span className="hidden items-center gap-1 group-hover:flex">
            {props.sources.map((source) => (
              <Button
                key={source.instanceId}
                size="xs"
                variant={source.instanceId === props.instanceId ? "outline" : "ghost-muted"}
                data-model-source-choice={source.label}
                aria-pressed={source.instanceId === props.instanceId}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onPickSource?.(source.instanceId, source.slug);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
              >
                <SourceDot color={source.color} />
                <span className="max-w-24 truncate">{source.label}</span>
              </Button>
            ))}
          </span>
        ) : null}
        {props.onToggleVariants ? (
          <Button
            size="xs"
            variant="ghost-muted"
            className={cn(props.sources && !props.disabledReason && "group-hover:hidden")}
            data-model-source={props.sourceLabel}
            aria-expanded={props.variantsExpanded === true}
            aria-label={gt("{source}. Other sources of this model", { source: props.sourceLabel })}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleVariants?.();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
            }}
          >
            <SourceDot color={props.sourceColor} />
            <span className="max-w-28 truncate">{props.sourceLabel}</span>
            <ChevronDownIcon
              className={cn("size-3", props.variantsExpanded && "rotate-180")}
              aria-hidden="true"
            />
          </Button>
        ) : (
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-model-source={props.sourceLabel}
          >
            <SourceDot color={props.sourceColor} />
            <span className="max-w-28 truncate">{props.sourceLabel}</span>
          </span>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFavorite(props.instanceId, props.slug);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                disabled={Boolean(props.disabledReason)}
                aria-label={props.isFavorite ? gt("Remove from favorites") : gt("Add to favorites")}
              >
                <StarIcon
                  className={cn(
                    "size-3.5 sm:size-3",
                    props.isFavorite && "fill-current text-warning",
                    !props.isFavorite &&
                      "opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100 in-focus-visible:opacity-100 pointer-coarse:opacity-100",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            {props.isFavorite ? gt("Remove from favorites") : gt("Add to favorites")}
          </TooltipPopup>
        </Tooltip>
        {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
