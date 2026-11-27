import { useAtomValue } from "@effect/atom-react";
import type {
  AgentSessionProjectCandidate,
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { resolveProviderInstanceDisplayName as agentName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AgentSessionSource,
  AuthProvidersManageScope,
  AuthTerminalOperateScope,
  CommandId,
  AuthOrchestrationOperateScope,
  isManagedDriverAllowed,
  isProviderAvailable,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { Link, useBlocker, useLocation } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, TerminalIcon } from "lucide-react";
import { msg, T, useGT, useLocale, useMessages, Var } from "gt-react";
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { readLocalApi } from "../../localApi";
import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import { PRIVACY_POLICY_URL } from "../../legalLinks";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { completeOnboarding } from "../../onboarding/firstRun";
import {
  groupOnboardingProjects,
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  isNewOnboardingProject,
  resolveOnboardingProjectId,
  type OnboardingProjectGroup,
  splitOnboardingProjectPath,
} from "../../onboarding/projectImport.logic";
import {
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
} from "../../onboarding/providerReadiness.logic";
import {
  groupWelcomeAgents,
  isBrokenVersion,
  splitWelcomeAgentRows,
  turnedOnInstance,
  welcomeAgentState,
} from "../../onboarding/welcomePage.logic";
import {
  StoredWelcomeImportSelection,
  type WelcomeImportSelection,
  welcomeImportSelectionKey,
} from "../../onboarding/welcomeState";
import { newProjectId, randomUUID } from "../../lib/utils";
import { agentSessionImport } from "../../state/agentSessions";
import { readProjects, useProjects, waitForProject } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { managedTelemetryOffMessage, useManagedPolicy } from "../../state/managedPolicy";
import { useProjectScans } from "../../onboarding/useProjectScans";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentsWithScope,
} from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { getProviderSummary } from "../settings/providerStatus";
import { AddProviderInstanceDialog } from "../settings/AddProviderInstanceDialog";
import { useDesktopCliCommand } from "../settings/CliCommandSettingsRow";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ACPRegistryIcon } from "../Icons";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";
import { WelcomeAccountCards } from "../agentd/WelcomeAccountCards";
import { ConnectEndpointScreen } from "./ConnectEndpointScreen";
import { JoinTeamScreen } from "./JoinTeamScreen";

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
const SCAN_LIMIT_MESSAGE = msg(
  "Scan limit reached. Some projects or conversations may be missing.",
);
// Mirrors the exclusions in apps/server/src/project/AgentSessionScanner.ts.
const MISSING_PROJECT_REASONS = [
  msg("The folder was moved or no longer exists."),
  msg("Folders in ~/Downloads or ~/Documents/Codex, your home folder and /tmp are skipped."),
  msg("Linked worktrees count toward their main checkout."),
  msg("Folders the app manages itself, such as its own worktrees, are skipped."),
  msg("Only Claude Code, Codex and Pi history is read."),
  msg("Folders with no recorded conversations are not listed."),
  msg("Each agent's history is read up to 5,000 conversation files."),
];

/**
 * First-run page for one computer: its agents and the projects found in agent history.
 */
export function WelcomePage({
  environmentId,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly onDone: (projectRef?: ScopedProjectRef) => void | Promise<void>;
}) {
  const { environments } = useEnvironments();
  const gt = useGT();
  const label =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    gt("this computer");
  const agents = useWelcomeAgents(environmentId);
  const agentReady = agents.readyCount > 0;
  const isPrimary = usePrimaryEnvironmentId() === environmentId;
  const screen = useLocation({ select: (location) => location.search.screen });
  const scans = useProjectScans([environmentId]);
  const [storedSelection, storeSelection] = useLocalStorage(
    welcomeImportSelectionKey(environmentId),
    null,
    StoredWelcomeImportSelection,
  );
  // The page keeps its own copy, so a failed write (a full quota) cannot undo a choice.
  const [importSelection, setImportSelectionState] = useState(storedSelection);
  const setImportSelection = (next: WelcomeImportSelection | null) => {
    setImportSelectionState(next);
    storeSelection(next);
  };
  const [isImporting, setIsImporting] = useState(false);
  // True from Start until the landing; leaving earlier would drop the import or the landing.
  const holdPageRef = useRef(false);
  useBlocker({
    shouldBlockFn: () => {
      if (!holdPageRef.current) return false;
      toastManager.add({
        id: "welcome-finishing",
        type: "info",
        title: gt("Finishing setup"),
        description: gt("One moment."),
      });
      return true;
    },
    // Electron cancels a quit silently when unload is blocked. A later visit resumes the import.
    enableBeforeUnload: false,
  });
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  // Starting before the project list loads keeps saved picks, such as an import a quit cut short.
  const keepChoicesRef = useRef(false);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const finish = (
    projectRef?: ScopedProjectRef,
    importWarning?: string,
    importedThreadCount = 0,
  ) => {
    if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
    if (completionErrorToastIdRef.current !== null) {
      toastManager.close(completionErrorToastIdRef.current);
      completionErrorToastIdRef.current = null;
    }

    holdPageRef.current = true;
    const completion = completeOnboarding()
      .then(async () => {
        if (completionErrorToastIdRef.current !== null) {
          toastManager.close(completionErrorToastIdRef.current);
          completionErrorToastIdRef.current = null;
        }
        // Release before onDone so its own navigation is not blocked.
        holdPageRef.current = false;
        await onDone(projectRef);
        if (!keepChoicesRef.current) setImportSelection(null);
        if (importWarning) {
          toastManager.add({
            type: "warning",
            title: gt("Some history was not imported"),
            description: importWarning,
            timeout: 0,
          });
        } else if (importedThreadCount > 0) {
          toastManager.add({
            type: "success",
            title: gt(
              "{count, plural, one {Imported {count} thread} other {Imported {count} threads}}",
              { count: importedThreadCount },
            ),
          });
        }
        return true;
      })
      .catch(() => {
        holdPageRef.current = false;
        const errorToast = {
          type: "error",
          title: gt("Could not finish setup"),
          description: gt("Your settings could not be saved. Try again."),
        } as const;
        if (completionErrorToastIdRef.current === null) {
          completionErrorToastIdRef.current = toastManager.add(errorToast);
        } else {
          toastManager.update(completionErrorToastIdRef.current, errorToast);
        }
        return false;
      })
      .finally(() => {
        if (finishingPromiseRef.current === completion) {
          finishingPromiseRef.current = null;
        }
      });
    finishingPromiseRef.current = completion;
    return completion;
  };
  const projectImport = useProjectImport({
    scans,
    importSelection,
    onImportSelectionChange: setImportSelection,
    isImporting,
    setIsImporting,
    holdPageRef,
    onDone: finish,
  });
  // Without import permission, starting simply skips the projects.
  const selected = projectImport.canWrite ? projectImport.selected : [];
  const agentsId = useId();
  const start = () => {
    keepChoicesRef.current = scans.some((scan) => scan.data === null);
    if (selected.length === 0) {
      projectImport.finishAfterImport();
      return;
    }
    // Stored now, so after a restart mid-import these stay checked even once they exist.
    projectImport.setSelectedKeys(new Set(selected.map((candidate) => candidate.key)));
    void projectImport.runImport(selected);
  };

  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, gt("Welcome"))}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div className="flex min-h-full flex-col px-6 py-10 sm:py-16">
            <div className="m-auto w-full max-w-xl">
              {screen === "endpoint" || screen === "gateway" ? (
                <ConnectEndpointScreen
                  key={screen}
                  gatewayChosen={screen === "gateway"}
                  environmentId={environmentId}
                  back={
                    <Link to="." search={{ screen: undefined }} hash={true}>
                      <T>Back</T>
                    </Link>
                  }
                />
              ) : screen === "team" ? (
                <JoinTeamScreen />
              ) : (
                <>
                  <h1 className="mb-7 text-center text-3xl font-semibold tracking-tight text-foreground">
                    <T>Connect an agent you already use</T>
                  </h1>
                  <WelcomeAccountCards
                    environmentId={environmentId}
                    agentsId={agentsId}
                    gatewayLink={<Link to="." search={{ screen: "gateway" }} hash={true} />}
                  />
                  <AgentsSection
                    id={agentsId}
                    agents={agents}
                    environmentId={environmentId}
                    label={label}
                    isPrimary={isPrimary}
                    onImportSourceEnabled={() => scans[0]?.refresh()}
                    projects={
                      <ProjectsSection
                        scan={scans[0]}
                        projectImport={projectImport}
                        isImporting={isImporting}
                        canPickFolder={isPrimary && window.desktopBridge !== undefined}
                      />
                    }
                  />
                  <div className="mt-5 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm">
                    <Link
                      to="."
                      search={{ screen: "endpoint" }}
                      hash={true}
                      className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      <T>Use an API key or gateway</T>
                    </Link>
                    <Link
                      to="."
                      search={{ screen: "team" }}
                      hash={true}
                      className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      <T>Join a team</T>
                    </Link>
                  </div>
                  <div className="mt-7 flex justify-center">
                    <Button disabled={!agentReady || isImporting} onClick={start}>
                      {isImporting
                        ? selected.length > 0
                          ? gt("Importing…")
                          : gt("Starting…")
                        : selected.length > 0
                          ? gt(
                              "{count, plural, one {Import {count} project and continue} other {Import {count} projects and continue}}",
                              { count: selected.length },
                            )
                          : gt("Continue", { $context: "verb, finishes setup" })}
                    </Button>
                  </div>
                  {/* Setup must not dead-end when no agent is detected; Settings > Providers connects one later. */}
                  {agentReady ? null : (
                    <div className="mt-2 flex justify-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isImporting}
                        onClick={() => projectImport.finishAfterImport()}
                      >
                        <T>Skip for now</T>
                      </Button>
                    </div>
                  )}
                  <TelemetryNotice environmentId={environmentId} />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function TelemetryNotice({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const messages = useMessages();
  const telemetryOff = managedTelemetryOffMessage(useManagedPolicy(environmentId), messages);
  return (
    <p className="mt-9 text-center text-2xs leading-relaxed text-muted-foreground/70">
      {telemetryOff === undefined ? (
        <T>
          LibraOS Next sends no usage data unless an analytics endpoint is configured. See{" "}
          <a
            className="underline decoration-current/40 underline-offset-2 hover:text-muted-foreground"
            href={PRIVACY_POLICY_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            what it would send
          </a>
          .
        </T>
      ) : (
        <>
          {telemetryOff}{" "}
          <T>
            See the{" "}
            <a
              className="underline decoration-current/40 underline-offset-2 hover:text-muted-foreground"
              href={PRIVACY_POLICY_URL}
              target="_blank"
              rel="noreferrer noopener"
            >
              privacy policy
            </a>
            .
          </T>
        </>
      )}
    </p>
  );
}

// Each part of the page is one band: its label on the left, its rows on the right.
// Rows share one icon column, so names, checkboxes, and steps line up down the page.
function RowIcon({ children }: { readonly children: ReactNode }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      {children}
    </span>
  );
}

const INSTALLABLE_DRIVERS = ["claudeAgent", "codex", "opencode"] as const;
type OnboardingAgentDriver = (typeof INSTALLABLE_DRIVERS)[number];
const isInstallableDriver = (driver: string): driver is OnboardingAgentDriver =>
  (INSTALLABLE_DRIVERS as ReadonlyArray<string>).includes(driver);

interface AgentTerminalSession {
  readonly environmentId: EnvironmentId;
  readonly driver: OnboardingAgentDriver;
  readonly step: "install" | "signIn";
  readonly providerInstanceId: ServerProvider["instanceId"];
  readonly cwd: string;
  readonly command: string;
  readonly keybindings: ServerConfig["keybindings"];
}

function useWelcomeAgents(environmentId: EnvironmentId) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const managedPolicy = serverConfig?.managedPolicy;
  const isAllowed = (driver: ProviderDriverKind) => isManagedDriverAllowed(managedPolicy, driver);
  const { found, available, readyCount } = groupWelcomeAgents(
    providers,
    serverConfig?.settings,
    agentName,
    (provider) => isAllowed(provider.driver),
  );
  return {
    serverConfig,
    readyCount,
    ...splitWelcomeAgentRows([...found, ...available], isAllowed),
  };
}

const isImportSource = Schema.is(AgentSessionSource);

const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");

function AgentsSection({
  id,
  agents,
  environmentId,
  label,
  isPrimary,
  onImportSourceEnabled,
  projects,
}: {
  readonly id: string;
  readonly projects: ReactNode;
  readonly agents: ReturnType<typeof useWelcomeAgents>;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  // The project scan only reads agents that are on, so turning one on or off changes what it finds.
  readonly onImportSourceEnabled: () => void;
}) {
  const { serverConfig, primary, more } = agents;
  const gt = useGT();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [terminalSession, setTerminalSession] = useState<AgentTerminalSession | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the environment to refresh its provider list when the environment changes
  useEffect(() => {
    void refreshProviders({ environmentId, input: {} });
  }, [environmentId, refreshProviders]);

  const acpAllowed = isManagedDriverAllowed(serverConfig?.managedPolicy, ACP_REGISTRY_DRIVER_KIND);
  const stateOf = (provider: ServerProvider) => welcomeAgentState(provider, serverConfig?.settings);
  const setupStepFor = (provider: ServerProvider) => {
    const state = stateOf(provider);
    if (
      !isInstallableDriver(provider.driver) ||
      isBrokenVersion(provider) ||
      provider.setup?.canAuthenticate === true
    )
      return null;
    if (state === "install" || state === "signIn") return state;
    return state === "attention" &&
      provider.installed &&
      provider.auth.status === "unknown" &&
      isProviderAvailable(provider)
      ? "signIn"
      : null;
  };
  const openTerminal = (provider: ServerProvider, step: AgentTerminalSession["step"]) => {
    if (
      !isInstallableDriver(provider.driver) ||
      serverConfig === null ||
      !readEnvironmentScope(environmentId, AuthTerminalOperateScope)
    )
      return;
    setTerminalSession({
      environmentId,
      driver: provider.driver,
      step,
      providerInstanceId: provider.instanceId,
      cwd: serverConfig.cwd,
      command:
        step === "signIn"
          ? resolveOnboardingProviderLoginCommand(
              provider,
              serverConfig.settings,
              serverConfig.environment.platform.os,
            )
          : resolveOnboardingProviderInstallCommand(
              provider.driver,
              serverConfig.environment.platform.os,
            ),
      keybindings: serverConfig.keybindings,
    });
  };

  const setTurnedOn = async (provider: ServerProvider, on: boolean) => {
    if (serverConfig === null) return;
    const instance = serverConfig.settings.providerInstances[provider.instanceId] ?? {
      driver: provider.driver,
    };
    const result = await persistProviderInstance({
      operation: "upsert",
      instanceId: provider.instanceId,
      instance: on ? turnedOnInstance(instance) : { ...instance, enabled: false },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: on
            ? gt("Could not turn on {agent}", { agent: agentName(provider) })
            : gt("Could not turn off {agent}", { agent: agentName(provider) }),
          ...(cause instanceof Error ? { description: cause.message } : {}),
        });
      }
      return;
    }
    void refreshProviders({ environmentId, input: { instanceId: provider.instanceId } });
    if (isImportSource(provider.driver)) onImportSourceEnabled();
  };

  // One action per agent, the same in the list and in the grid.
  const actionFor = (provider: ServerProvider, name: string) => {
    const state = stateOf(provider);
    const settingsAction = (actionLabel: string) => (
      <Button
        size="xs"
        variant="outline"
        aria-label={gt("{action}: {agent}", { action: actionLabel, agent: name })}
        render={
          <Link
            to="/settings/providers"
            search={{ environmentId, instanceId: provider.instanceId }}
          />
        }
      >
        {actionLabel}
      </Button>
    );
    const turnedOnSwitch = (
      <Switch
        aria-label={name}
        checked={state !== "disabled"}
        disabled={!canManageProviders || serverConfig === null}
        onCheckedChange={(checked) => void setTurnedOn(provider, checked)}
      />
    );
    if (state === "ready" || state === "disabled") return turnedOnSwitch;
    // An agent that is on but not signed in can still be turned off here.
    if (state === "signIn" || state === "attention") {
      return (
        <span className="flex items-center gap-3">
          {setupActionFor(provider, name, state, settingsAction)}
          {turnedOnSwitch}
        </span>
      );
    }
    return setupActionFor(provider, name, state, settingsAction);
  };

  const setupActionFor = (
    provider: ServerProvider,
    name: string,
    state: ReturnType<typeof stateOf>,
    settingsAction: (actionLabel: string) => ReactNode,
  ) => {
    // Settings updates a broken CLI the way it was installed, including a custom binary path.
    if (isBrokenVersion(provider))
      return settingsAction(gt("Update", { $context: "verb, updates an agent CLI" }));
    const step = setupStepFor(provider);
    if (step !== null) {
      return (
        <TerminalAction
          name={name}
          signIn={step === "signIn"}
          disabled={
            (terminalSession?.providerInstanceId === provider.instanceId &&
              terminalSession.step === step) ||
            serverConfig === null ||
            !canOperateTerminal
          }
          onClick={() => openTerminal(provider, step)}
        />
      );
    }
    return settingsAction(
      state === "signIn" ? gt("Sign in") : state === "attention" ? gt("Details") : gt("Set up"),
    );
  };

  const visibleProviders = [
    ...primary.flatMap(({ provider }) => (provider ? [provider] : [])),
    ...more,
  ];
  const notes = [
    !canOperateTerminal && visibleProviders.some((provider) => setupStepFor(provider) !== null)
      ? gt("This connection cannot control terminals.")
      : null,
    !canManageProviders &&
    (acpAllowed || visibleProviders.some((provider) => stateOf(provider) === "disabled"))
      ? gt("This connection cannot manage agents.")
      : null,
  ].filter((note) => note !== null);

  return (
    <section id={id} tabIndex={-1} aria-label={gt("Agents")} className="outline-none">
      <p className="mb-2.5 text-center text-xs text-muted-foreground">
        <T>Agents that are on are available in chats. Turn off any you do not want.</T>
      </p>
      <ul className="space-y-2.5">
        {primary.map(({ driver, name, provider }) => (
          <AgentRow
            key={driver}
            driver={driver}
            name={name}
            provider={provider}
            state={provider ? stateOf(provider) : "checking"}
            action={provider && actionFor(provider, name)}
          />
        ))}
      </ul>
      {notes.map((note) => (
        <p key={note} className="mt-2 text-center text-xs text-muted-foreground">
          {note}
        </p>
      ))}
      {projects}
      <Collapsible>
        <div className="mt-3 text-center">
          <CollapsibleTrigger className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            <T>More agents</T>
            <ChevronDownIcon className="size-3.5 group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <ul className="mt-2 space-y-1">
            {more.map((provider) => (
              <AgentRow
                key={provider.instanceId}
                driver={provider.driver}
                name={agentName(provider)}
                provider={provider}
                state={stateOf(provider)}
                compact
                action={actionFor(provider, agentName(provider))}
              />
            ))}
          </ul>
          {acpAllowed ? (
            <div className="flex min-h-9 items-center gap-3">
              <RowIcon>
                <ACPRegistryIcon className="size-4" />
              </RowIcon>
              <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                <T>More agents in the ACP Registry</T>
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={!canManageProviders}
                onClick={() => setAddingProvider(true)}
              >
                <T>Browse</T>
              </Button>
            </div>
          ) : null}
          {isPrimary ? <CliPathSetup /> : null}
        </CollapsiblePanel>
      </Collapsible>
      {terminalSession !== null ? (
        <AgentInstallTerminal
          key={`${terminalSession.environmentId}:${terminalSession.providerInstanceId}:${terminalSession.step}`}
          session={terminalSession}
          onCommandFinished={() =>
            void refreshProviders({
              environmentId,
              input: { instanceId: terminalSession.providerInstanceId },
            })
          }
          onClose={() => {
            setTerminalSession(null);
            void refreshProviders({ environmentId, input: {} });
          }}
        />
      ) : null}
      {addingProvider ? (
        <AddProviderInstanceDialog
          open
          environmentId={environmentId}
          environmentLabel={label}
          showMoreProviders
          onOpenChange={setAddingProvider}
          onCreated={(_instanceId, driver) => {
            void refreshProviders({ environmentId, input: {} });
            // A new Claude Code, Codex, or Pi instance can bring more history to import.
            if (isImportSource(driver)) onImportSourceEnabled();
          }}
        />
      ) : null}
    </section>
  );
}

// Above Continue and boxed like the agents, so the import choice is seen before setup ends.
function ProjectsCard({ children }: { readonly children: ReactNode }) {
  const gt = useGT();
  return (
    <section aria-label={gt("Projects")} className="mt-6 rounded-lg border bg-card px-4 py-3">
      {children}
    </section>
  );
}

function ProjectsSection({
  scan,
  projectImport,
  isImporting,
  canPickFolder,
}: {
  readonly scan: ReturnType<typeof useProjectScans>[number] | undefined;
  readonly projectImport: ReturnType<typeof useProjectImport>;
  readonly isImporting: boolean;
  // The native folder dialog only exists in the desktop app, on its own computer.
  readonly canPickFolder: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const importSourcesLabel = useImportSourcesLabel();
  const [reviewing, setReviewing] = useState(false);
  const [picking, setPicking] = useState(false);
  const {
    canWrite,
    candidates,
    isNew,
    recent,
    selected,
    selectedKeys,
    setSelectedKeys,
    visibleImportError,
  } = projectImport;
  if (scan === undefined) return null;
  const addFolder = async () => {
    const api = readLocalApi();
    if (!api) return;
    setPicking(true);
    const path = await api.dialogs.pickFolder().catch(() => null);
    setPicking(false);
    if (path && (await projectImport.addFolder(scan.environmentId, path))) setReviewing(true);
  };
  const missingHelp = (
    <MissingProjectsHelp
      onAddFolder={canPickFolder && canWrite ? addFolder : undefined}
      disabled={picking || isImporting}
    />
  );
  if (scan.isPending && candidates.length === 0) {
    return (
      <ProjectsCard>
        <p className="text-sm leading-10 text-muted-foreground">
          <T>
            Looking for projects in your <Var>{importSourcesLabel}</Var> history…
          </T>
        </p>
      </ProjectsCard>
    );
  }
  const retry = (
    <Button variant="ghost" size="sm" onClick={scan.refresh}>
      <T>Retry</T>
    </Button>
  );
  if (scan.error !== null && candidates.length === 0) {
    return (
      <ProjectsCard>
        <div
          role="alert"
          className="flex min-h-10 items-center justify-between gap-3 text-sm text-muted-foreground"
        >
          <span>{gt("Could not check projects. {error}", { error: scan.error })}</span>
          {retry}
        </div>
      </ProjectsCard>
    );
  }
  if (candidates.length === 0) {
    return (
      <ProjectsCard>
        <p className="text-sm leading-8 text-muted-foreground" role="status">
          {scan.data?.truncated ? (
            m(SCAN_LIMIT_MESSAGE)
          ) : (
            <T>
              No projects found in your <Var>{importSourcesLabel}</Var> history.
            </T>
          )}
        </p>
        {missingHelp}
      </ProjectsCard>
    );
  }

  const allKeys = candidates.map((candidate) => candidate.key);
  // Checking the box picks recent new projects, else any new ones, else everything listed.
  const fresh = candidates.filter(isNew);
  const defaultKeys = (recent.length > 0 ? recent : fresh.length > 0 ? fresh : candidates).map(
    (candidate) => candidate.key,
  );
  const partial =
    selected.length > 0 &&
    selected.length < candidates.length &&
    !(selected.length === defaultKeys.length && defaultKeys.every((key) => selectedKeys.has(key)));
  return (
    <ProjectsCard>
      <div className="flex min-h-10 items-center gap-3 py-1">
        <label className="flex min-w-0 flex-1 items-center gap-3">
          <RowIcon>
            <Checkbox
              checked={canWrite && selected.length > 0}
              indeterminate={canWrite && partial}
              disabled={isImporting || !canWrite}
              onCheckedChange={(checked) =>
                setSelectedKeys(new Set(checked ? defaultKeys : []), { optedOut: !checked })
              }
            />
          </RowIcon>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">
              {canWrite && selected.length > 0
                ? gt(
                    "{count, plural, one {Import {count} project and their threads} other {Import {count} projects and their threads}}",
                    { count: selected.length },
                  )
                : gt("Import projects and their threads (optional)")}
            </span>
            <span className="block text-xs text-muted-foreground">
              <T>
                Found in your <Var>{importSourcesLabel}</Var> history. Nothing is imported unless
                you choose it.
              </T>
            </span>
          </span>
        </label>
        {canWrite ? (
          <Button
            variant="outline"
            size="xs"
            aria-expanded={reviewing}
            onClick={() => setReviewing((open) => !open)}
          >
            {reviewing
              ? gt("Hide")
              : gt(
                  "{count, plural, one {Choose from {count} project} other {Choose from {count} projects}}",
                  { count: candidates.length },
                )}
            <ChevronDownIcon className={cn("size-3.5", reviewing && "rotate-180")} />
          </Button>
        ) : null}
      </div>
      {reviewing && canWrite ? (
        // The negative margin lines the list's checkboxes up with the one above it.
        <fieldset className="-mx-1.5 mt-1 min-w-0" disabled={isImporting}>
          <div className="flex items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
            <span role="status">
              {gt(
                "{selected, plural, one {{selected} of {total} selected} other {{selected} of {total} selected}}",
                {
                  selected: selected.length,
                  total: candidates.length,
                },
              )}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                disabled={selected.length === candidates.length}
                onClick={() => setSelectedKeys(new Set(allKeys))}
              >
                <T>Select all</T>
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={selected.length === 0}
                onClick={() => setSelectedKeys(new Set())}
              >
                <T>Select none</T>
              </Button>
            </div>
          </div>
          <ScrollArea scrollFade className="mt-1 h-auto max-h-80">
            <div className="space-y-0.5 pr-3">
              <ImportCandidateList
                candidates={candidates}
                selectedKeys={selectedKeys}
                onSelectionChange={setSelectedKeys}
              />
            </div>
          </ScrollArea>
          <p className="px-2 pt-1 text-xs text-muted-foreground">
            <T>Folders that are not git repositories are listed under Other folders.</T>
          </p>
        </fieldset>
      ) : null}
      {missingHelp}
      {scan.data?.truncated ? (
        <p className="pl-8 text-xs text-muted-foreground" role="status">
          {m(SCAN_LIMIT_MESSAGE)}
        </p>
      ) : null}
      {scan.error !== null ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 pl-8 text-sm text-muted-foreground"
        >
          <span>{gt("Could not check projects again. {error}", { error: scan.error })}</span>
          {retry}
        </div>
      ) : null}
      {visibleImportError ? (
        <p className="pt-1 pl-8 text-sm text-destructive">{m(visibleImportError)}</p>
      ) : null}
    </ProjectsCard>
  );
}

function MissingProjectsHelp({
  onAddFolder,
  disabled,
}: {
  readonly onAddFolder: (() => void) | undefined;
  readonly disabled: boolean;
}) {
  const m = useMessages();
  return (
    <Collapsible className="ml-8">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <CollapsibleTrigger className="group inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          <T>Why might a project be missing?</T>
          <ChevronDownIcon className="size-3.5 group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        {onAddFolder ? (
          <Button variant="ghost" size="xs" disabled={disabled} onClick={onAddFolder}>
            <T>Add a folder…</T>
          </Button>
        ) : null}
      </div>
      <CollapsiblePanel>
        <ul className="list-disc space-y-0.5 pb-1 pl-4 text-xs text-muted-foreground">
          {MISSING_PROJECT_REASONS.map((reason) => (
            <li key={reason}>{m(reason)}</li>
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function TerminalAction({
  name,
  signIn,
  disabled,
  onClick,
}: {
  readonly name: string;
  readonly signIn: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const gt = useGT();
  const label = signIn ? gt("Sign in") : gt("Install");
  return (
    <Button
      size="xs"
      variant="outline"
      aria-label={gt("{action}: {agent}", { action: label, agent: name })}
      disabled={disabled}
      onClick={onClick}
    >
      <TerminalIcon className="size-3.5" />
      {label}
    </Button>
  );
}

function AgentRow({
  driver,
  name,
  provider,
  state,
  action,
  compact = false,
}: {
  readonly driver: ProviderDriverKind;
  readonly name: string;
  readonly provider: ServerProvider | undefined;
  readonly state: ReturnType<typeof welcomeAgentState>;
  readonly action?: ReactNode;
  readonly compact?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const detail = (() => {
    switch (state) {
      case "ready":
        return gt("Ready", { $context: "agent status" });
      case "checking":
        return gt("Checking…");
      case "install":
        return gt("Not installed");
      case "signIn":
        return gt("Needs sign-in");
      case "disabled":
        return gt("Turned off");
      case "attention":
        return (
          provider &&
          (provider.unavailableReason ??
            (isBrokenVersion(provider) ? provider.compatibilityAdvisory?.message : undefined) ??
            provider.message ??
            getProviderSummary(provider, messages).headline)
        );
    }
  })();
  return (
    <li
      className={cn(
        "flex items-center gap-3",
        compact ? "min-h-9 px-2" : "min-h-16 rounded-lg border bg-card px-4 py-3",
      )}
    >
      <ProviderInstanceIcon
        driverKind={driver}
        displayName={name}
        iconClassName={compact ? "size-4" : "size-6"}
      />
      <div className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm text-foreground", !compact && "font-semibold")}>
          {name}
        </span>
        <p
          className={cn(
            "line-clamp-2 text-xs leading-relaxed break-words",
            state === "ready" ? "text-success-foreground" : "text-muted-foreground",
          )}
        >
          {detail}
        </p>
      </div>
      <div className="shrink-0">
        {state === "ready" ? (
          <span className="flex items-center gap-2">
            {action}
            <CheckIcon className="size-4 text-success-foreground" aria-hidden />
          </span>
        ) : state === "checking" ? null : (
          action
        )}
      </div>
    </li>
  );
}

function AgentInstallTerminal({
  session,
  onCommandFinished,
  onClose,
}: {
  readonly session: AgentTerminalSession;
  readonly onCommandFinished: () => void;
  readonly onClose: () => void;
}) {
  const { command, cwd, driver, environmentId, keybindings, providerInstanceId } = session;
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const gt = useGT();
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const [terminalId] = useState(() => `onboarding-${driver}-${randomUUID()}`);
  const threadRef = scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID);
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const terminalReady = setupState === "ready" || setupState === "writeFailed";
  const commandRunning = useThreadRunningTerminalIds({
    environmentId,
    threadId: AGENT_ONBOARDING_THREAD_ID,
  }).includes(terminalId);
  const commandStartedRef = useRef(false);
  const handleCommandFinished = useEffectEvent(onCommandFinished);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the shell stays open after an install or sign-in, so its command exiting is the only signal to check the agent again
  useEffect(() => {
    if (commandRunning) {
      commandStartedRef.current = true;
    } else if (commandStartedRef.current) {
      commandStartedRef.current = false;
      handleCommandFinished();
    }
  }, [commandRunning]);

  // StrictMode can finish a cancelled open after replacement setup; it must not close or pre-type into that
  // session.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the setup PTY, types the command into it, and closes it on cleanup
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    // oxlint-disable-next-line react/set-state-in-effect -- A retry or a new command reopens the terminal, which shows as preparing until the open settles.
    setSetupState("preparing");

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("openFailed");
        return;
      }
      const opened = await openTerminal({
        environmentId,
        input: {
          threadId: AGENT_ONBOARDING_THREAD_ID,
          terminalId,
          cwd,
          providerInstanceId,
        },
      });
      if (opened._tag !== "Success") {
        if (activeSetupGenerationRef.current === generation) setSetupState("openFailed");
        return;
      }

      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("writeFailed");
        return;
      }

      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, data: command },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    // Revocation leaves the PTY running; close only while terminal access remains.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
        await closeTerminal({
          environmentId,
          input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    closeTerminal,
    command,
    cwd,
    environmentId,
    openTerminal,
    providerInstanceId,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry bumps setupAttempt to open the terminal again.
    setupAttempt,
    terminalId,
    writeTerminal,
  ]);

  return (
    <div
      data-thread-terminal-drawer
      className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {!canOperateTerminal ? (
            gt("This connection cannot control terminals.")
          ) : setupState === "writeFailed" ? (
            <T>
              Run{" "}
              <code className="rounded bg-muted px-1 font-mono">
                <Var>{command}</Var>
              </code>{" "}
              in this terminal.
            </T>
          ) : setupState === "ready" ? (
            gt("Review the command, then press Enter to run it.")
          ) : setupState === "openFailed" ? (
            gt("Could not open the setup terminal.")
          ) : (
            gt("Preparing command...")
          )}
        </span>
        <div className="flex items-center gap-1">
          {setupState === "openFailed" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperateTerminal}
              onClick={() => {
                if (readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
                  setSetupAttempt((value) => value + 1);
                }
              }}
            >
              <T>Retry</T>
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            <T>Close</T>
          </Button>
        </div>
      </div>
      <div className="h-64">
        {terminalReady ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={AGENT_ONBOARDING_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={
              session.step === "install"
                ? gt("Install {agent}", { agent: driver })
                : gt("Sign in: {agent}", { agent: driver })
            }
            cwd={cwd}
            providerInstanceId={providerInstanceId}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
            autoFocus
            visible
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}

const IMPORT_PERMISSION_MESSAGE = msg("This connection cannot import projects or thread history.");

// Creates the selected projects, then imports each one's agent history. Owns retry state so a
// second Start resumes instead of recreating projects.
function useProjectImport({
  scans,
  importSelection,
  onImportSelectionChange,
  isImporting,
  setIsImporting,
  holdPageRef,
  onDone,
}: {
  readonly scans: ReturnType<typeof useProjectScans>;
  readonly importSelection: WelcomeImportSelection | null;
  readonly onImportSelectionChange: (next: WelcomeImportSelection) => void;
  readonly isImporting: boolean;
  readonly setIsImporting: (value: boolean) => void;
  // Blocks leaving the page; onDone releases it before landing.
  readonly holdPageRef: { current: boolean };
  readonly onDone: (
    projectRef?: ScopedProjectRef,
    importWarning?: string,
    importedThreadCount?: number,
  ) => Promise<boolean>;
}) {
  const writableEnvironments = useEnvironmentsWithScope(scans, AuthOrchestrationOperateScope);
  const gt = useGT();
  const m = useMessages();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const importWarningRef = useRef("");
  // Per project, so a retry that skips finished projects still counts their threads.
  const importedThreadsRef = useRef(new Map<string, number>());
  const importedProjectsRef = useRef(new Map<string, ScopedProjectRef>());
  const projectsWithImportedHistoryRef = useRef(new Map<string, ScopedProjectRef>());
  const lastImportSelectionRef = useRef<ReadonlyArray<string>>([]);
  const projectAttemptsRef = useRef(
    new Map<string, { readonly projectId: ProjectId; readonly commandId: CommandId }>(),
  );
  const importGenerationRef = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- bumps the import generation on mount and unmount so in-flight imports drop stale results
  useEffect(() => {
    importGenerationRef.current += 1;
    return () => {
      importGenerationRef.current += 1;
    };
  }, []);

  const { available: candidates, recent: recentActive } = partitionOnboardingProjects(
    scans.flatMap((scan) =>
      (scan.data?.candidates ?? []).map((candidate) => ({
        ...candidate,
        environmentId: scan.environmentId,
        key: onboardingProjectKey(scan.environmentId, candidate.path),
      })),
    ),
  );
  // Projects already in AgentD Next stay in the list, but reopening the page does not import their
  // history again unless the user picks them. The scan can be 30 s old, so the live list decides.
  const projects = useProjects();
  const isNewProject = isNewOnboardingProject(projects);
  const isNew = (candidate: ImportCandidate) => isNewProject(candidate.environmentId, candidate);
  const recent = recentActive.filter(isNew);
  const knownKeys = new Set(importSelection?.knownKeys);
  const pickedKeys = new Set(importSelection?.keys);
  // Nothing is imported until the person picks it.
  const selected = importSelection?.optedOut
    ? []
    : candidates.filter(
        (candidate) => knownKeys.has(candidate.key) && pickedKeys.has(candidate.key),
      );
  const selectedKeys = new Set(selected.map((candidate) => candidate.key));
  const setSelectedKeys = (keys: ReadonlySet<string>, { optedOut = false } = {}) =>
    onImportSelectionChange({
      knownKeys: candidates.map((candidate) => candidate.key),
      keys: [...keys],
      optedOut,
    });

  const canWrite = scans.every((scan) => writableEnvironments.has(scan.environmentId));
  const canImport = selected.every((candidate) =>
    writableEnvironments.has(candidate.environmentId),
  );
  const visibleImportError = canWrite && canImport ? "" : IMPORT_PERMISSION_MESSAGE;

  // A folder the scan offered is picked for import; any other becomes a project now. True when picked.
  const addFolder = async (environmentId: EnvironmentId, path: string) => {
    const key = onboardingProjectKey(environmentId, path);
    if (candidates.some((candidate) => candidate.key === key)) {
      setSelectedKeys(new Set([...selectedKeys, key]));
      return true;
    }
    const name = inferProjectTitleFromPath(path);
    if (resolveOnboardingProjectId(readProjects(), environmentId, { path }) !== null) {
      toastManager.add({ type: "info", title: gt("{name} is already a project", { name }) });
      return false;
    }
    const result = await createProject({
      environmentId,
      input: {
        projectId: newProjectId(),
        title: name,
        workspaceRoot: path,
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: null,
      },
    });
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: gt("Added {name}", { name }) });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not add {name}", { name }),
        description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
      });
    }
    return false;
  };

  const importedThreadTotal = () =>
    lastImportSelectionRef.current.reduce(
      (total, key) => total + (importedThreadsRef.current.get(key) ?? 0),
      0,
    );

  const finishAfterImport = () => {
    const projectRef = resolveOnboardingLandingProject(
      lastImportSelectionRef.current,
      projectsWithImportedHistoryRef.current,
      importedProjectsRef.current,
    );
    // Busy until setup is saved, so Start cannot run the import again meanwhile.
    setIsImporting(true);
    if (projectRef === undefined) {
      void onDone(undefined, importWarningRef.current, importedThreadTotal()).then((completed) => {
        if (!completed) setIsImporting(false);
      });
      return;
    }
    holdPageRef.current = true;
    const importGeneration = importGenerationRef.current;
    // waitForProject gives up after its timeout, so a project that never reaches the client
    // still finishes setup, just without landing in it.
    void waitForProject(projectRef)
      .then(
        () => projectRef,
        () => undefined,
      )
      .then(async (landing) => {
        if (importGeneration !== importGenerationRef.current) {
          holdPageRef.current = false;
          return;
        }
        const completed = await onDone(landing, importWarningRef.current, importedThreadTotal());
        if (!completed) setIsImporting(false);
      });
  };

  const runImport = async (selection: typeof candidates) => {
    if (isImporting) return;
    const hasAccess = () =>
      selection.every((candidate) =>
        readEnvironmentScope(candidate.environmentId, AuthOrchestrationOperateScope),
      );
    // The permission message shows from the session's scopes.
    const stopForDeniedAccess = () => setIsImporting(false);
    if (!hasAccess()) {
      stopForDeniedAccess();
      return;
    }
    setIsImporting(true);
    importWarningRef.current = "";
    lastImportSelectionRef.current = selection.map((candidate) => candidate.key);
    const importGeneration = importGenerationRef.current;
    const importedThreads = importedThreadsRef.current;
    const importedProjects = importedProjectsRef.current;
    const projectAttempts = projectAttemptsRef.current;
    let importedProjectsCount =
      importedProjects.size > 0
        ? selection.filter((candidate) => importedProjects.has(candidate.key)).length
        : 0;
    let skippedThreadCount = 0;
    const refreshEnvironments = new Set<EnvironmentId>();
    // Resolves false when the run stopped early: a newer run, an unmount, or lost access.
    const importEach = async () => {
      for (const candidate of selection) {
        const { environmentId } = candidate;
        if (importGeneration !== importGenerationRef.current) return false;
        if (!hasAccess()) {
          stopForDeniedAccess();
          return false;
        }
        if (importedProjects.has(candidate.key)) continue;
        let projectId = resolveOnboardingProjectId(readProjects(), environmentId, candidate);
        if (projectId === null) {
          let attempt = projectAttempts.get(candidate.key);
          if (attempt === undefined) {
            const nextProjectId = newProjectId();
            attempt = {
              projectId: nextProjectId,
              commandId: CommandId.make(`onboarding:project:create:${nextProjectId}`),
            };
            projectAttempts.set(candidate.key, attempt);
          }
          projectId = attempt.projectId;
          const result = await createProject({
            environmentId,
            input: {
              projectId,
              commandId: attempt.commandId,
              title: candidate.title,
              workspaceRoot: candidate.path,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          });
          if (importGeneration !== importGenerationRef.current) return false;
          if (result._tag !== "Success") {
            if (!isAtomCommandInterrupted(result)) {
              projectAttempts.delete(candidate.key);
              refreshEnvironments.add(environmentId);
            }
            continue;
          }
        }

        if (!hasAccess()) {
          stopForDeniedAccess();
          return false;
        }
        const threadImportResult = await importThreads({
          environmentId,
          input: { projectId, expectedWorkspaceRoot: candidate.path },
        });
        if (importGeneration !== importGenerationRef.current) return false;
        if (threadImportResult._tag === "Success") {
          importedThreads.set(
            candidate.key,
            (importedThreads.get(candidate.key) ?? 0) + threadImportResult.value.importedCount,
          );
          skippedThreadCount += threadImportResult.value.skippedCount;
          if (threadImportResult.value.importedCount > 0) {
            projectsWithImportedHistoryRef.current.set(
              candidate.key,
              scopeProjectRef(environmentId, projectId),
            );
          }
          if (threadImportResult.value.skippedCount === 0) {
            importedProjectsCount += 1;
            importedProjects.set(candidate.key, scopeProjectRef(environmentId, projectId));
          }
        } else if (!isAtomCommandInterrupted(threadImportResult)) {
          projectAttempts.delete(candidate.key);
          refreshEnvironments.add(environmentId);
        }
      }
      return true;
    };
    holdPageRef.current = true;
    const completed = await importEach().finally(() => {
      holdPageRef.current = false;
    });
    if (!completed) return;
    for (const scan of scans) {
      if (refreshEnvironments.has(scan.environmentId)) scan.refresh();
    }
    setIsImporting(false);
    const importedThreadCount = importedThreadTotal();
    if (importedProjectsCount < selection.length) {
      if (importedThreadCount > 0 && skippedThreadCount > 0) {
        importWarningRef.current = `${gt(
          "{count, plural, one {Imported {count} thread.} other {Imported {count} threads.}}",
          { count: importedThreadCount },
        )} ${gt(
          "{count, plural, one {{count} thread could not be imported.} other {{count} threads could not be imported.}}",
          { count: skippedThreadCount },
        )}`;
      } else if (skippedThreadCount > 0) {
        importWarningRef.current = gt(
          "{count, plural, one {{count} thread could not be imported.} other {{count} threads could not be imported.}}",
          { count: skippedThreadCount },
        );
      } else if (importedThreadCount > 0) {
        importWarningRef.current = gt(
          "{count, plural, one {Imported {count} thread. Some thread history could not be imported.} other {Imported {count} threads. Some thread history could not be imported.}}",
          { count: importedThreadCount },
        );
      } else {
        importWarningRef.current = gt("Could not import thread history.");
      }
    }
    finishAfterImport();
  };

  return {
    canWrite,
    candidates,
    isNew,
    recent,
    selected,
    selectedKeys,
    setSelectedKeys,
    visibleImportError,
    runImport,
    finishAfterImport,
    addFolder,
  };
}

type ImportCandidate = AgentSessionProjectCandidate & {
  readonly environmentId: EnvironmentId;
  readonly key: string;
};

function ImportCandidateList({
  candidates,
  selectedKeys,
  onSelectionChange,
}: {
  readonly candidates: ReadonlyArray<ImportCandidate>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onSelectionChange: (next: ReadonlySet<string>) => void;
}) {
  const { repositories, other } = groupOnboardingProjects(candidates);
  const setKeys = (keys: ReadonlyArray<string>, checked: boolean) => {
    const next = new Set(selectedKeys);
    for (const key of keys) {
      if (checked) next.add(key);
      else next.delete(key);
    }
    onSelectionChange(next);
  };
  const otherSelected = other.filter((candidate) => selectedKeys.has(candidate.key)).length;
  const gt = useGT();

  return (
    <>
      {repositories.map((group) => (
        <ImportRepositoryGroup
          key={group.key}
          group={group}
          selectedKeys={selectedKeys}
          onToggle={setKeys}
        />
      ))}
      {other.length > 0 ? (
        <Collapsible>
          <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40">
            <Checkbox
              checked={otherSelected === other.length}
              indeterminate={otherSelected > 0 && otherSelected < other.length}
              onCheckedChange={(checked) =>
                setKeys(
                  other.map((candidate) => candidate.key),
                  checked === true,
                )
              }
            />
            <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 text-left">
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
              <span className="truncate text-sm text-muted-foreground">
                <T>Other folders</T>
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {gt("{count, plural, one {{count} folder} other {{count} folders}}", {
                  count: other.length,
                })}
              </span>
            </CollapsibleTrigger>
          </div>
          <CollapsiblePanel>
            {other.map((candidate) => (
              <ImportCandidateRow
                key={candidate.key}
                candidate={candidate}
                path={candidate.path}
                nested
                checked={selectedKeys.has(candidate.key)}
                onCheckedChange={(checked) => setKeys([candidate.key], checked)}
              />
            ))}
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </>
  );
}

function ImportRepositoryGroup({
  group,
  selectedKeys,
  onToggle,
}: {
  readonly group: OnboardingProjectGroup<ImportCandidate>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onToggle: (keys: ReadonlyArray<string>, checked: boolean) => void;
}) {
  const keys = group.candidates.map((candidate) => candidate.key);
  const selectedCount = keys.filter((key) => selectedKeys.has(key)).length;
  const single = group.candidates.length === 1;
  const only = group.candidates[0];
  if (single && only !== undefined) {
    return (
      <ImportCandidateRow
        candidate={only}
        label={group.label}
        path={only.path}
        checked={selectedKeys.has(only.key)}
        onCheckedChange={(checked) => onToggle([only.key], checked)}
      />
    );
  }
  return (
    <Collapsible defaultOpen>
      <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40">
        <Checkbox
          checked={selectedCount === keys.length}
          indeterminate={selectedCount > 0 && selectedCount < keys.length}
          onCheckedChange={(checked) => onToggle(keys, checked === true)}
        />
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
          <span className="truncate text-sm font-medium">{group.label}</span>
          <ImportRowMeta
            sources={[...new Set(group.candidates.flatMap((c) => c.sources))]}
            threadCount={group.threadCount}
            lastActiveAt={group.lastActiveAt}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsiblePanel>
        {group.candidates.map((candidate) => (
          <ImportCandidateRow
            key={candidate.key}
            candidate={candidate}
            path={candidate.path}
            nested
            checked={selectedKeys.has(candidate.key)}
            onCheckedChange={(checked) => onToggle([candidate.key], checked)}
          />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ProjectPathText({
  path,
  className,
}: {
  readonly path: string;
  readonly className?: string;
}) {
  const { name, parent } = splitOnboardingProjectPath(path);
  return (
    <span className={cn("flex min-w-0 items-baseline font-mono", className)}>
      {parent.length > 0 ? <span className="truncate">{parent}</span> : null}
      <span className="max-w-full shrink-0 truncate">{name}</span>
    </span>
  );
}

function ImportCandidateRow({
  candidate,
  label,
  path,
  nested = false,
  checked,
  onCheckedChange,
}: {
  readonly candidate: ImportCandidate;
  readonly label?: string;
  readonly path?: string;
  readonly nested?: boolean;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40 has-disabled:cursor-default",
        nested && "pl-8",
      )}
    >
      <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <Tooltip>
        <TooltipTrigger
          render={<span className="flex min-w-0 flex-1 items-baseline gap-2 truncate" />}
        >
          {label !== undefined ? (
            <span className="truncate text-sm font-medium">{label}</span>
          ) : null}
          {path !== undefined ? (
            <ProjectPathText
              path={path}
              className={label === undefined ? "text-xs" : "text-2xs text-muted-foreground"}
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup variant="code">{candidate.path}</TooltipPopup>
      </Tooltip>
      <ImportRowMeta
        sources={nested ? null : candidate.sources}
        threadCount={candidate.threadCount}
        lastActiveAt={candidate.lastActiveAt}
      />
    </label>
  );
}

const IMPORT_SOURCE_NAMES: Record<AgentSessionSource, string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};
function useImportSourcesLabel() {
  return new Intl.ListFormat(useLocale(), { type: "conjunction" }).format(
    AgentSessionSource.literals.map((source) => IMPORT_SOURCE_NAMES[source]),
  );
}

function ImportRowMeta({
  sources,
  threadCount,
  lastActiveAt,
}: {
  readonly sources: ReadonlyArray<AgentSessionSource> | null;
  readonly threadCount: number;
  readonly lastActiveAt: string | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const relative =
    lastActiveAt === null ? null : formatRelativeTime(lastActiveAt, undefined, messages);
  const age =
    relative === null
      ? ""
      : relative.suffix === null
        ? gt("now", { $context: "relative time" })
        : relative.value;
  return (
    <span className="ml-auto grid shrink-0 grid-cols-[1rem_1rem_1rem_2.5rem_2.25rem] items-center gap-x-1 text-xs text-muted-foreground tabular-nums">
      {AgentSessionSource.literals.map((source) => (
        <span key={source} className="flex size-4 items-center justify-center">
          {sources?.includes(source) ? (
            <span role="img" aria-label={IMPORT_SOURCE_NAMES[source]}>
              <ProviderInstanceIcon
                driverKind={ProviderDriverKind.make(source)}
                displayName={IMPORT_SOURCE_NAMES[source]}
                iconClassName="size-3"
              />
            </span>
          ) : null}
        </span>
      ))}
      <span className="text-right">{threadCount}</span>
      <span className="text-right whitespace-nowrap">{age}</span>
    </span>
  );
}

/** The desktop app links `lnext` on a fresh install; this puts its folder on PATH when it is not. */
function CliPathSetup() {
  const { state, busy, run } = useDesktopCliCommand();
  const setup = state?.pathSetup;
  if (!setup) return null;
  return (
    <div className="flex min-h-10 items-center gap-3">
      <RowIcon>
        <TerminalIcon className="size-4" />
      </RowIcon>
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {setup.added ? (
          <T>
            Added to <Var>{setup.file}</Var>. Open a new terminal to use{" "}
            <code className="font-mono">lnext</code>.
          </T>
        ) : (
          <T>
            Use <code className="font-mono">lnext</code> from any terminal. Adds one line to{" "}
            <Var>{setup.file}</Var>.
          </T>
        )}
      </p>
      {setup.added ? null : (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
          <T>Add to PATH</T>
        </Button>
      )}
    </div>
  );
}
