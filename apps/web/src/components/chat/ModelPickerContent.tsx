import { T, useGT, useLocale, useMessages } from "gt-react";
import { useLegendListRef } from "~/hooks/useLegendListRef";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  customGatewayIdOfInstance,
  isGatewayInstanceId,
  isManagedDriverAllowed,
  isProviderDriverOffered,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import {
  formatProviderUpdateRequiredNotice,
  providerUpdateChannelLags,
} from "@t3tools/client-runtime/providerUpdateRequiredModels";
import { groupModelsBySubProvider } from "@t3tools/client-runtime/providerSubProviders";
import { useNavigate } from "@tanstack/react-router";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useState,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronRightIcon } from "lucide-react";
import { ModelListRow } from "./ModelListRow";
import { barColor } from "../usage/UsageLimits";
import { useProviderWorkspaceSnapshotRefresh } from "./useProviderWorkspaceSnapshotRefresh";
import { getProviderStatusMessage, hasProviderSetup } from "./ProviderStatusBanner";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  modelPickerSubProviderSectionKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";
import { rankModelPickerSearch } from "@t3tools/client-runtime/model-search";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { ModelEsque } from "./providerIconUtils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { registerModelPickerContent } from "../../modelPickerVisibility";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import {
  useEnvironmentModelPreferences,
  useToggleEnvironmentModelFavorite,
} from "~/hooks/useSettings";
import { announce } from "~/lib/announce";
import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { TooltipProvider } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  isProviderInstancePickerReady,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { providerModelKey } from "../../modelOrdering";
import { hasRuntimeModelCatalog } from "../../providerModels";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  continuationGroupKey?: string | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  if (input.driverKind === "antigravity" && input.model === ANTIGRAVITY_DEFAULT_MODEL) {
    const availableModels = input.options.filter(
      (option) => option.slug !== ANTIGRAVITY_DEFAULT_MODEL && !option.isUnavailable,
    );
    return (
      availableModels.find((option) => option.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL)) ??
      availableModels.find((option) => option.isDefault)
    );
  }
  return input.options.find((option) => option.slug === input.model);
}

function shouldIncludeModelPickerOption(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
}): boolean {
  if (input.entry.driverKind === "antigravity" && input.option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
    return false;
  }
  if (isProviderInstancePickerReady(input.entry)) return true;
  return (
    input.entry.enabled &&
    hasRuntimeModelCatalog(input.entry.driverKind) &&
    input.entry.instanceId === input.activeInstanceId &&
    input.option.slug === input.activeModel &&
    input.option.isUnavailable === true
  );
}

function shouldOfferModelPickerSetup(
  entry: ProviderInstanceEntry,
  options: ReadonlyArray<ModelEsque>,
): boolean {
  return (
    entry.enabled &&
    entry.status !== "disabled" &&
    hasProviderSetup(entry.snapshot) &&
    (!isProviderInstancePickerReady(entry) ||
      !entry.installed ||
      entry.snapshot.auth.status === "unauthenticated" ||
      !options.some((option) => !option.isUnavailable))
  );
}

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const MODEL_LIST_ESTIMATED_ITEM_SIZE = 32;
// Rendered heights in `--spacing` units. Chrome is the search box and list padding, plus a 1px border.
const ROW_UNITS = 8;
const ROW_SEPARATOR_UNITS = 0.5;
const LIST_CHROME_UNITS = 15.5;
// A source with more models than this shows its first few and folds the rest.
const SOURCE_FOLD_ABOVE = 10;
const SOURCE_FOLDED_ROWS = 8;

function ModelListSeparator() {
  return <div className="h-0.5" />;
}

function modelJumpLabelsByKey(
  modelKeys: ReadonlyArray<string>,
  keybindings: ResolvedKeybindingsConfig,
  terminalOpen: boolean,
): ReadonlyMap<string, string> {
  const shortcutLabelOptions = {
    platform: navigator.platform,
    context: { terminalFocus: false, terminalOpen, modelPickerOpen: true },
  };
  const mapping = new Map<string, string>();
  for (const [index, modelKey] of modelKeys.entries()) {
    const command = modelPickerJumpCommandForIndex(index);
    const label = command && shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(modelKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
}

function ModelPickerProviderNotices({
  setupEntries,
  updateRequiredNotices,
  emptyLabel,
  onRequestClose,
  onOpenProviderSetup,
}: {
  setupEntries: ReadonlyArray<ProviderInstanceEntry>;
  emptyLabel: string;
  updateRequiredNotices: ReadonlyArray<{
    instanceId: ProviderInstanceId;
    notice: string;
    canUpdateInSettings: boolean;
  }>;
  onRequestClose: (() => void) | undefined;
  onOpenProviderSetup: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  return (
    <>
      {setupEntries.length > 0 ? (
        <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
          {setupEntries.map((entry) => (
            <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
              <p className="line-clamp-3 text-muted-foreground">
                {getProviderStatusMessage(entry.snapshot, messages)}
              </p>
              <InlineButton
                className="mt-1"
                onClick={() => {
                  onRequestClose?.();
                  onOpenProviderSetup?.(entry.instanceId);
                }}
              >
                {setupEntries.length > 1
                  ? gt("Set up {provider}", { provider: entry.displayName })
                  : gt("Open provider setup")}
              </InlineButton>
            </div>
          ))}
        </div>
      ) : (
        <ComboboxEmpty className="empty:h-0">{emptyLabel}</ComboboxEmpty>
      )}
      {updateRequiredNotices.map(({ instanceId, notice, canUpdateInSettings }) => (
        <p
          key={instanceId}
          className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
        >
          {notice}
          {canUpdateInSettings ? (
            <>
              {" "}
              <InlineButton
                onClick={() => {
                  onRequestClose?.();
                  void navigate({ to: "/settings/providers" });
                }}
              >
                <T>Provider settings</T>
              </InlineButton>
            </>
          ) : null}
        </p>
      ))}
    </>
  );
}

function ModelPickerList({
  listRef,
  itemKeys,
  extraData,
  renderItem,
}: {
  listRef: RefObject<LegendListRef | null>;
  itemKeys: ReadonlyArray<string>;
  extraData: unknown;
  renderItem: (props: { item: string; index: number }) => ReactNode;
}) {
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const updateScrollFades = () => {
    const metrics = listRef.current?.getState();
    if (!metrics) return;
    setShowTopScrollFade(!metrics.isAtStart);
    setShowBottomScrollFade(!metrics.isAtEnd);
  };
  const scrollRef = useLegendListRef(listRef, updateScrollFades);

  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden pr-px",
        itemKeys.length > 0 ? "flex-1" : "h-0",
      )}
    >
      <ComboboxListVirtualized>
        <LegendList<string>
          ref={scrollRef}
          data={itemKeys}
          extraData={extraData}
          keyExtractor={(modelKey) => modelKey}
          renderItem={renderItem}
          estimatedItemSize={MODEL_LIST_ESTIMATED_ITEM_SIZE}
          drawDistance={480}
          recycleItems
          contentContainerClassName="pl-2 pr-px"
          ItemSeparatorComponent={ModelListSeparator}
          onLayout={updateScrollFades}
          onScroll={updateScrollFades}
          onReady={updateScrollFades}
          className={cn(
            "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
            getVirtualizedScrollFadeClassName({
              top: showTopScrollFade,
              bottom: showBottomScrollFade,
            }),
          )}
        />
      </ComboboxListVirtualized>
    </div>
  );
}

// Capture gives picker shortcuts priority over the composer.
function WindowKeyDownListener({ onKeyDown }: { onKeyDown: (event: KeyboardEvent) => void }) {
  const handleKeyDown = useEffectEvent(onKeyDown);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a capture-phase window keydown listener for the picker's lifetime
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
    };
  }, []);
  return null;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  environmentId: EnvironmentId | null;
  /** Keeps the open provider tab's catalog fresh for this directory. */
  workspaceCwd?: string | null;
  activeInstanceId: ProviderInstanceId;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** The owning popup moves focus here when it opens (its `initialFocus`). */
  searchInputRef: RefObject<HTMLInputElement | null>;
  /** Sits beside an effort column: fills the shared row, and stacks above it on narrow screens. */
  docked?: boolean;
  /** Right at the end of the search text moves into the popup's effort column. */
  onFocusEffort?: () => void;
  /** Closes the list column, inside the popup's fixed height. */
  listFooter?: ReactNode;
}) {
  const gt = useGT();
  const messages = useMessages();
  const locale = useLocale();
  const {
    searchInputRef,
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    getModelDisabledReason,
    onInstanceModelChange,
    onToggleModel,
    onRequestClose,
    onOpenProviderSetup,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const modelListRef = useRef<LegendListRef | null>(null);
  const pickerContentRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes this picker's mount to global keydown handlers
  useLayoutEffect(() => registerModelPickerContent(), []);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const { favorites } = useEnvironmentModelPreferences(props.environmentId);
  const configAtom = serverEnvironment.configValueAtom(props.environmentId);
  const showOtherAgents = useAtomValue(configAtom, (config) => config?.settings?.showOtherAgents);
  const managedPolicy = useAtomValue(configAtom, (config) => config?.managedPolicy);
  const configuredInstances = useAtomValue(
    configAtom,
    (config) => config?.settings?.providerInstances,
  );
  const instanceEntries = props.instanceEntries.filter(
    (entry) =>
      isProviderDriverOffered(managedPolicy, showOtherAgents, entry.driverKind) ||
      // A connected gateway's agents (Pi among them) were asked for, whatever discovery offers.
      (isGatewayInstanceId(entry.instanceId) &&
        isManagedDriverAllowed(managedPolicy, entry.driverKind)) ||
      (entry.instanceId === props.activeInstanceId &&
        entry.driverKind === props.lockedProvider &&
        isManagedDriverAllowed(managedPolicy, entry.driverKind)),
  );
  const isUnconfiguredDefault = (entry: ProviderInstanceEntry) =>
    entry.isDefault && !entry.enabled && !configuredInstances?.[entry.instanceId];
  const offersSetup = (entry: ProviderInstanceEntry) =>
    isUnconfiguredDefault(entry) ||
    shouldOfferModelPickerSetup(entry, modelOptionsByInstance.get(entry.instanceId) ?? []);
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId);
  const activeModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const activeModelSlug =
    activeModel?.slug ?? (props.model === ANTIGRAVITY_DEFAULT_MODEL ? "" : props.model);
  const activeModelKey = activeModelSlug
    ? modelPickerModelKey(props.activeInstanceId, activeModelSlug)
    : null;
  const selectedModelKeys = props.selectedModels?.map((selection) => {
    const entry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
    const model = resolveModelPickerSelectedModel({
      driverKind: entry?.driverKind,
      model: selection.model,
      options: modelOptionsByInstance.get(selection.instanceId) ?? [],
    });
    return modelPickerModelKey(selection.instanceId, model?.slug ?? selection.model);
  });
  const selectedModelKeySet = new Set(
    selectedModelKeys ?? (activeModelKey ? [activeModelKey] : []),
  );
  const { scanning: workspaceModelsScanning } = useProviderWorkspaceSnapshotRefresh({
    environmentId: props.environmentId,
    gitCwd: props.workspaceCwd ?? null,
    instanceId: props.activeInstanceId,
  });
  // The one model whose other sources and agents are listed under it.
  const [expandedVariantsKey, setExpandedVariantsKey] = useState<string | null>(null);
  const favoritesSet = new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  const [expandedLegacyInstances, setExpandedLegacyInstances] = useState(
    () =>
      new Set<ProviderInstanceId>(
        activeModel?.isLegacy &&
          !favoritesSet.has(providerModelKey(props.activeInstanceId, activeModelSlug))
          ? [props.activeInstanceId]
          : [],
      ),
  );
  // The thread's backend opens expanded, so its models show without a click.
  const [expandedSubProviderKeys, setExpandedSubProviderKeys] = useState(
    () =>
      new Set<string>(
        activeModel?.subProvider
          ? [modelPickerSubProviderSectionKey(props.activeInstanceId, activeModel.subProvider)]
          : [],
      ),
  );
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = providedKeybindings ?? serverKeybindings;
  const [searchHeight, setSearchHeight] = useState(0);
  const toggleFavorite = useToggleEnvironmentModelFavorite(props.environmentId);

  const toggleLegacySection = (instanceId: ProviderInstanceId) => {
    setExpandedLegacyInstances((expanded) => {
      const next = new Set(expanded);
      if (next.has(instanceId)) {
        next.delete(instanceId);
      } else {
        next.add(instanceId);
      }
      return next;
    });
  };

  const toggleSubProviderSection = (key: string) => {
    setExpandedSubProviderKeys((expanded) => {
      const next = new Set(expanded);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const handleModelSelect = (
    modelSlug: string,
    instanceId: ProviderInstanceId,
    additive = false,
  ): string | null => {
    if (getModelDisabledReason?.(instanceId, modelSlug)) {
      return null;
    }
    const options = modelOptionsByInstance.get(instanceId);
    if (!options) {
      return null;
    }
    const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
    if (!entry) {
      return null;
    }
    const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
    if (!resolvedModel) return null;
    if (additive && onToggleModel) {
      onToggleModel(instanceId, resolvedModel);
    } else {
      onInstanceModelChange(instanceId, resolvedModel);
    }
    return resolvedModel;
  };

  const pickSource = (instanceId: ProviderInstanceId, slug: string) => {
    handleModelSelect(slug, instanceId);
  };

  const modelJumpShortcutContext = {
    terminalFocus: false,
    terminalOpen: props.terminalOpen,
    modelPickerOpen: true,
  } as const;
  const lockedProvider = props.lockedProvider;
  const lockedContinuationGroupKey = props.lockedContinuationGroupKey;
  const canOpenProviderSetup = onOpenProviderSetup !== undefined;

  const entryByInstanceId = new Map(instanceEntries.map((entry) => [entry.instanceId, entry]));
  const matchesLockedProvider = (
    entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">,
  ): boolean => {
    if (lockedProvider === null) return true;
    if (entry.driverKind !== lockedProvider) return false;
    if (!lockedContinuationGroupKey) return true;
    return entry.continuationGroupKey === lockedContinuationGroupKey;
  };

  const flatModels = (() => {
    const out: ModelPickerItem[] = [];
    const seenKeys = new Set<string>();
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        continue;
      }
      for (const model of models) {
        const key = modelPickerModelKey(instanceId, model.slug);
        if (
          seenKeys.has(key) ||
          !shouldIncludeModelPickerOption({
            entry,
            option: model,
            activeInstanceId: props.activeInstanceId,
            activeModel: activeModelSlug,
          })
        ) {
          continue;
        }
        seenKeys.add(key);
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.badge ? { badge: model.badge } : {}),
          ...(model.isLegacy ? { isLegacy: true } : {}),
          ...(model.isUnavailable ? { isUnavailable: true } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.acpRegistryAgentId ? { acpRegistryAgentId: entry.acpRegistryAgentId } : {}),
          ...(entry.acpRegistryIconUrl ? { acpRegistryIconUrl: entry.acpRegistryIconUrl } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
        });
      }
    }
    return out;
  })();

  const subProvidersByInstance = new Map(
    instanceEntries.flatMap((entry) =>
      entry.snapshot.subProviders?.length
        ? [[entry.instanceId, entry.snapshot.subProviders] as const]
        : [],
    ),
  );
  const isSearching = searchQuery.trim().length > 0;
  const instanceOrder = instanceEntries.map((entry) => entry.instanceId);
  // What a model's row calls where it runs: the sign-in, or the gateway and, when
  // several agents can run the gateway's models, which one.
  const sourceLabels = (() => {
    const named = instanceEntries.map((entry) => {
      const gatewayId = customGatewayIdOfInstance(entry.instanceId);
      const [agent, ...gatewayName] = entry.displayName.split(" · ");
      return gatewayId !== null && gatewayName.length > 0
        ? {
            entry,
            gatewayId,
            source:
              entry.driverKind === "claudeAgent" ? entry.displayName : gatewayName.join(" · "),
            agent: entry.driverKind === "claudeAgent" ? undefined : agent,
          }
        : { entry, gatewayId: null, source: entry.displayName, agent: undefined };
    });
    const readyAgents = new Map<string, number>();
    for (const { entry, gatewayId } of named) {
      if (gatewayId !== null && isProviderInstancePickerReady(entry)) {
        readyAgents.set(gatewayId, (readyAgents.get(gatewayId) ?? 0) + 1);
      }
    }
    return new Map(
      named.map(({ entry, gatewayId, source, agent }) => [
        entry.instanceId,
        {
          source,
          variant:
            gatewayId !== null && agent && (readyAgents.get(gatewayId) ?? 0) > 1
              ? `${source} · ${agent}`
              : source,
        },
      ]),
    );
  })();

  // One row per model: the same model from another source, or run by another agent,
  // is a variant of that row. Backends of one provider (fx) stay rows of their own.
  const rows = (() => {
    const byKey = new Map<string, ModelPickerItem[]>();
    for (const model of flatModels) {
      if (!matchesLockedProvider(model)) continue;
      const key = subProvidersByInstance.has(model.instanceId)
        ? modelPickerModelKey(model.instanceId, model.slug)
        : model.slug.toLowerCase();
      const variants = byKey.get(key);
      if (variants) variants.push(model);
      else byKey.set(key, [model]);
    }
    return [...byKey].map(([variantsKey, variants]) => ({
      variantsKey,
      variants,
      model:
        variants.find(
          (variant) => modelPickerModelKey(variant.instanceId, variant.slug) === activeModelKey,
        ) ??
        variants.find((variant) => variant.instanceId === props.activeInstanceId) ??
        variants[0]!,
    }));
  })();
  type ModelRow = (typeof rows)[number];
  type SubProviderSection = {
    key: string;
    name: string;
    unavailableReason: string | undefined;
    models: ReadonlyArray<ModelRow>;
    isExpanded: boolean;
  };
  const keyOfRow = (row: ModelRow) => modelPickerModelKey(row.model.instanceId, row.model.slug);
  const isFavoriteRow = (row: ModelRow) =>
    favoritesSet.has(providerModelKey(row.model.instanceId, row.model.slug));

  const layout = (() => {
    const keys: string[] = [];
    const mainRows: ModelRow[] = [];
    const rowByKey = new Map<
      string,
      { row: ModelRow; model: ModelPickerItem; isVariant: boolean }
    >();
    const foldByKey = new Map<string, { isExpanded: boolean; source: string; hidden: number }>();
    const subProviderSectionByKey = new Map<string, SubProviderSection>();
    const addRows = (shown: ReadonlyArray<ModelRow>) => {
      for (const row of shown) {
        const key = keyOfRow(row);
        keys.push(key);
        mainRows.push(row);
        rowByKey.set(key, { row, model: row.model, isVariant: false });
        if (expandedVariantsKey !== row.variantsKey) continue;
        for (const variant of row.variants) {
          if (variant === row.model) continue;
          const variantKey = modelPickerModelKey(variant.instanceId, variant.slug);
          keys.push(variantKey);
          rowByKey.set(variantKey, { row, model: variant, isVariant: true });
        }
      }
    };
    if (isSearching) {
      addRows(
        rankModelPickerSearch(rows, searchQuery, ({ model }) => ({
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          driverKind: model.driverKind,
          providerDisplayName: model.instanceDisplayName,
          isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
        })),
      );
      return { keys, mainRows, rowByKey, foldByKey, subProviderSectionByKey };
    }
    addRows(rows.filter(isFavoriteRow));
    for (const instanceId of instanceOrder) {
      const items = rows.filter(
        (row) => row.model.instanceId === instanceId && !isFavoriteRow(row),
      );
      if (items.length === 0) continue;
      const subProviders = subProvidersByInstance.get(instanceId);
      if (subProviders) {
        const { ungrouped, groups } = groupModelsBySubProvider(
          items,
          subProviders,
          (row) => row.model.subProvider,
        );
        addRows(ungrouped);
        for (const { subProvider, models } of groups) {
          const key = modelPickerSubProviderSectionKey(instanceId, subProvider.name);
          const isExpanded = expandedSubProviderKeys.has(key);
          subProviderSectionByKey.set(key, {
            key,
            name: subProvider.name,
            unavailableReason: subProvider.unavailableReason,
            models,
            isExpanded,
          });
          keys.push(key);
          if (isExpanded) addRows(models);
        }
        continue;
      }
      // Older models fold away, and so does the tail of a long list; the model in use stays.
      const current = items.filter((row) => row.model.isLegacy !== true);
      const kept = new Set(
        current.length > SOURCE_FOLD_ABOVE ? current.slice(0, SOURCE_FOLDED_ROWS) : current,
      );
      const folded = items.filter((row) => !kept.has(row) && keyOfRow(row) !== activeModelKey);
      const isExpanded = expandedLegacyInstances.has(instanceId);
      addRows(isExpanded ? items : items.filter((row) => !folded.includes(row)));
      // The toggle trails the list, so expanding it reveals more models above it.
      if (folded.length > 0) {
        const key = modelPickerLegacySectionKey(instanceId);
        foldByKey.set(key, {
          isExpanded,
          source: sourceLabels.get(instanceId)?.source ?? instanceId,
          hidden: folded.length,
        });
        keys.push(key);
      }
    }
    return { keys, mainRows, rowByKey, foldByKey, subProviderSectionByKey };
  })();
  const subProviderSectionByKey = layout.subProviderSectionByKey;

  const providerSetupEntries =
    !isSearching && canOpenProviderSetup
      ? instanceEntries.filter((entry) => matchesLockedProvider(entry) && offersSetup(entry))
      : [];

  const updateRequiredNotices = instanceEntries.flatMap((entry) => {
    const notice = matchesLockedProvider(entry)
      ? formatProviderUpdateRequiredNotice(entry.snapshot, searchQuery, messages, locale)
      : null;
    return notice
      ? [
          {
            instanceId: entry.instanceId,
            notice,
            canUpdateInSettings: !providerUpdateChannelLags(entry.snapshot, searchQuery),
          },
        ]
      : [];
  });

  const modelJumpModelKeys = layout.mainRows
    .filter((row) => !getModelDisabledReason?.(row.model.instanceId, row.model.slug))
    .slice(0, MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.length)
    .map(keyOfRow);
  const allItemKeys = ((): string[] => [
    ...flatModels.map((model) => modelPickerModelKey(model.instanceId, model.slug)),
    ...new Set(
      flatModels
        .filter((model) => model.isLegacy)
        .map((model) => modelPickerLegacySectionKey(model.instanceId)),
    ),
    ...[...subProvidersByInstance].flatMap(([instanceId, subProviders]) =>
      subProviders.map((subProvider) =>
        modelPickerSubProviderSectionKey(instanceId, subProvider.name),
      ),
    ),
  ])();
  const filteredItemKeys = layout.keys;

  const modelJumpLabelByKey = modelJumpLabelsByKey(
    modelJumpModelKeys,
    keybindings,
    props.terminalOpen,
  );
  const badgedInstanceIds = new Set(
    instanceEntries
      .filter((entry) => shouldShowInstanceBadge(entry, instanceEntries))
      .map((entry) => entry.instanceId),
  );
  const modelListExtraData = {
    layout,
    expandedVariantsKey,
    badgedInstanceIds,
    favoritesSet,
    modelJumpLabelByKey,
    activeModelKey,
    selectedModelKeySet,
  };

  const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.keyCode === 229 ||
      isCommandPaletteOpen()
    ) {
      return;
    }

    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    });
    const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
    if (jumpIndex === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const targetModelKey = modelJumpModelKeys[jumpIndex];
    if (!targetModelKey) {
      return;
    }
    const model = parseModelPickerModelKey(targetModelKey);
    if (!model) {
      return;
    }
    const selectedSlug = handleModelSelect(model.slug, model.instanceId);
    if (selectedSlug === null) return;
    const name = flatModels.find(
      (item) => item.slug === selectedSlug && item.instanceId === model.instanceId,
    )?.name;
    announce(gt("Model: {name}", { name: name ?? selectedSlug }), "model-picker");
  };

  return (
    <TooltipProvider delay={0}>
      <WindowKeyDownListener onKeyDown={onWindowKeyDown} />
      <div
        ref={pickerContentRef}
        className={cn(
          "relative flex w-screen max-w-90 flex-row overflow-hidden",
          props.docked ? "max-sm:h-56 max-sm:w-full max-sm:max-w-none" : "max-h-86.5",
        )}
        // Docked, the popup sets the height; a minimum here would overflow short windows.
        style={
          props.docked
            ? undefined
            : isSearching
              ? { height: searchHeight }
              : {
                  minHeight: `min(calc(var(--spacing) * ${filteredItemKeys.length * (ROW_UNITS + ROW_SEPARATOR_UNITS) + LIST_CHROME_UNITS} + 1px), calc(var(--spacing) * 86.5))`,
                }
        }
        data-model-picker-content="true"
      >
        <Combobox<string, boolean>
          inline
          items={allItemKeys}
          filteredItems={filteredItemKeys}
          filter={null}
          autoHighlight
          open
          virtualized
          multiple={onToggleModel !== undefined}
          value={onToggleModel ? [...selectedModelKeySet] : activeModelKey}
          onItemHighlighted={(modelKey, eventDetails) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
            if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
              void modelListRef.current?.scrollIndexIntoView?.({
                index: eventDetails.index,
                animated: false,
              });
            }
          }}
          onValueChange={(value, details) => {
            const modelKey = Array.isArray(value)
              ? (value.find((key) => !selectedModelKeySet.has(key)) ??
                [...selectedModelKeySet].find((key) => !value.includes(key)))
              : value;
            if (typeof modelKey !== "string") {
              return;
            }
            const legacyInstanceId = parseModelPickerLegacySectionKey(modelKey);
            if (legacyInstanceId) {
              toggleLegacySection(legacyInstanceId);
              return;
            }
            if (subProviderSectionByKey.has(modelKey)) {
              toggleSubProviderSection(modelKey);
              return;
            }
            const model = parseModelPickerModelKey(modelKey);
            if (model) {
              handleModelSelect(
                model.slug,
                model.instanceId,
                "shiftKey" in details.event && details.event.shiftKey === true,
              );
            }
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40">
            <ComboboxSearchInput
              ref={searchInputRef}
              placeholder={gt("Search models...")}
              value={searchQuery}
              onChange={(e) => {
                if (!isSearching) setSearchHeight(pickerContentRef.current?.offsetHeight ?? 0);
                setSearchQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) {
                  (e as typeof e & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
                  e.stopPropagation();
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onRequestClose?.();
                  return;
                }
                if (
                  props.onFocusEffort &&
                  e.key === "ArrowRight" &&
                  !e.altKey &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  !e.shiftKey &&
                  e.currentTarget.selectionStart === searchQuery.length
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  // The column shows the selected model's effort, so a highlighted model is picked
                  // first; the owning popup then moves focus to that model's levels.
                  const highlighted = highlightedModelKeyRef.current
                    ? parseModelPickerModelKey(highlightedModelKeyRef.current)
                    : null;
                  const pickedNew =
                    highlighted !== null &&
                    highlightedModelKeyRef.current !== activeModelKey &&
                    handleModelSelect(highlighted.slug, highlighted.instanceId) !== null;
                  if (!pickedNew) props.onFocusEffort();
                  return;
                }
                if (e.key === "Enter" && highlightedModelKeyRef.current) {
                  (e as typeof e & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
                  e.preventDefault();
                  e.stopPropagation();
                  const legacyInstanceId = parseModelPickerLegacySectionKey(
                    highlightedModelKeyRef.current,
                  );
                  if (legacyInstanceId) {
                    toggleLegacySection(legacyInstanceId);
                    return;
                  }
                  if (subProviderSectionByKey.has(highlightedModelKeyRef.current)) {
                    toggleSubProviderSection(highlightedModelKeyRef.current);
                    return;
                  }
                  const model = parseModelPickerModelKey(highlightedModelKeyRef.current);
                  if (model) {
                    handleModelSelect(model.slug, model.instanceId, e.shiftKey);
                  }
                  return;
                }
                e.stopPropagation();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            />

            <ModelPickerList
              listRef={modelListRef}
              itemKeys={filteredItemKeys}
              extraData={modelListExtraData}
              renderItem={({ item: modelKey, index }) => {
                const fold = layout.foldByKey.get(modelKey);
                if (fold) {
                  return (
                    <ComboboxItem
                      hideIndicator
                      index={index}
                      value={modelKey}
                      aria-expanded={fold.isExpanded}
                      className="group w-full cursor-pointer"
                    >
                      <span className="text-sm leading-snug text-muted-foreground group-hover:text-foreground group-data-highlighted:text-foreground">
                        {fold.isExpanded
                          ? gt("Show fewer {source} models", { source: fold.source })
                          : gt("Show {count} more {source} models", {
                              count: fold.hidden,
                              source: fold.source,
                            })}
                      </span>
                    </ComboboxItem>
                  );
                }
                const subProviderSection = subProviderSectionByKey.get(modelKey);
                if (subProviderSection) {
                  const unavailable = subProviderSection.unavailableReason !== undefined;
                  return (
                    <ComboboxItem
                      hideIndicator
                      index={index}
                      value={modelKey}
                      disabled={unavailable}
                      aria-expanded={unavailable ? undefined : subProviderSection.isExpanded}
                      className="group w-full cursor-pointer"
                    >
                      <div className="min-w-0 flex-1 text-left">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="min-w-0 truncate text-sm font-normal leading-snug">
                            {subProviderSection.name}
                          </div>
                          {unavailable ? (
                            <Badge variant="outline" size="sm">
                              {gt("Unavailable", { $context: "backend cannot be used right now" })}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground">
                          {subProviderSection.unavailableReason ??
                            gt("{count, plural, one {{count} model} other {{count} models}}", {
                              count: subProviderSection.models.length,
                            })}
                        </div>
                      </div>
                      {unavailable ? null : (
                        <ChevronRightIcon
                          className={cn(
                            "size-4 shrink-0 transition-transform",
                            subProviderSection.isExpanded && "rotate-90",
                          )}
                        />
                      )}
                    </ComboboxItem>
                  );
                }
                const listed = layout.rowByKey.get(modelKey);
                if (!listed) {
                  return null;
                }
                const { row, model, isVariant } = listed;
                const sourceColorOf = (variant: ModelPickerItem) =>
                  variant.instanceAccentColor ?? barColor(variant.driverKind);
                const disabledReason =
                  getModelDisabledReason?.(model.instanceId, model.slug) ?? null;
                return (
                  <ModelListRow
                    key={modelKey}
                    index={index}
                    slug={model.slug}
                    name={model.name}
                    subProvider={model.subProvider}
                    instanceId={model.instanceId}
                    driverKind={model.driverKind}
                    providerDisplayName={model.instanceDisplayName}
                    providerAccentColor={model.instanceAccentColor}
                    acpRegistryAgentId={model.acpRegistryAgentId}
                    acpRegistryIconUrl={model.acpRegistryIconUrl}
                    sourceLabel={
                      (isVariant || row.variants.length > 1
                        ? sourceLabels.get(model.instanceId)?.variant
                        : sourceLabels.get(model.instanceId)?.source) ?? model.instanceDisplayName
                    }
                    sourceColor={sourceColorOf(model)}
                    sources={
                      !isVariant && row.variants.length > 1 && row.variants.length <= 3
                        ? row.variants.map((variant) => ({
                            instanceId: variant.instanceId,
                            slug: variant.slug,
                            label:
                              sourceLabels.get(variant.instanceId)?.variant ??
                              variant.instanceDisplayName,
                            color: sourceColorOf(variant),
                          }))
                        : undefined
                    }
                    onPickSource={pickSource}
                    isVariant={isVariant}
                    {...(!isVariant && row.variants.length > 1
                      ? {
                          variantsExpanded: expandedVariantsKey === row.variantsKey,
                          onToggleVariants: () =>
                            setExpandedVariantsKey((current) =>
                              current === row.variantsKey ? null : row.variantsKey,
                            ),
                        }
                      : {})}
                    isFavorite={favoritesSet.has(providerModelKey(model.instanceId, model.slug))}
                    isSelected={
                      selectedModelKeys !== undefined
                        ? selectedModelKeySet.has(modelKey)
                        : modelKey === activeModelKey
                    }
                    showInstanceBadge={badgedInstanceIds.has(model.instanceId)}
                    showNewBadge={model.badge === "new"}
                    unavailable={model.isUnavailable === true}
                    jumpLabel={isVariant ? null : (modelJumpLabelByKey.get(modelKey) ?? null)}
                    disabledReason={disabledReason}
                    onToggleFavorite={toggleFavorite}
                  />
                );
              }}
            />
            <ModelPickerProviderNotices
              setupEntries={providerSetupEntries}
              updateRequiredNotices={updateRequiredNotices}
              emptyLabel={
                workspaceModelsScanning ? gt("Searching project models...") : gt("No models found")
              }
              onRequestClose={onRequestClose}
              onOpenProviderSetup={onOpenProviderSetup}
            />
            {props.listFooter}
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
