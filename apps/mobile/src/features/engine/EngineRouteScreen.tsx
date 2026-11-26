import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AgentdError, AgentdHandoffId, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { agentdEnvironment } from "../../state/agentd";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { deriveEngineScreen, type EngineScreenInput, type EngineTaskItem } from "./engineScreen";

const isAgentdError = Schema.is(AgentdError);
const isHandoffId = Schema.is(AgentdHandoffId);

function readOf<A>(query: { data: A | null; failure: unknown }) {
  if (query.data !== null) return query.data;
  return query.failure === null ? ("loading" as const) : ("error" as const);
}

export function EngineRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  return (
    <EngineScreenView key={route.params.environmentId} environmentId={route.params.environmentId} />
  );
}

function EngineScreenView({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const status = useEnvironmentQuery(agentdEnvironment.status({ environmentId, input: {} }));
  const tasks = useEnvironmentQuery(agentdEnvironment.tasks({ environmentId, input: {} }));
  const approvals = useEnvironmentQuery(agentdEnvironment.approvals({ environmentId, input: {} }));
  const canOperate = useAtomValue(agentdEnvironment.stopTask.permissionAtom(environmentId));

  const input: EngineScreenInput = {
    status: status.data === null && isAgentdError(status.failure) ? status.failure : readOf(status),
    tasks: readOf(tasks),
    approvals: readOf(approvals),
    canOperate,
  };
  const screen = deriveEngineScreen(input);

  return (
    <SettingsScreen
      title="LibraOS Engine"
      refresh={{
        accessibilityLabel: gt("Refresh"),
        onPress: () => {
          status.refresh();
          approvals.refresh();
        },
      }}
    >
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {screen.kind === "loading" ? (
          <View className="items-center py-8">
            <AppActivityIndicator />
          </View>
        ) : screen.kind !== "ready" ? (
          <Text
            selectable
            accessibilityLiveRegion="polite"
            className="px-2 text-base text-foreground-muted"
          >
            {screen.message}
          </Text>
        ) : (
          <>
            {screen.sections.length === 0 ? (
              <Text className="px-2 text-base text-foreground-muted">{gt("No tasks yet")}</Text>
            ) : (
              screen.sections.map((section) => (
                <ListSection key={section.id} title={section.title}>
                  {section.tasks.map((task) => (
                    <TaskRow key={task.id} environmentId={environmentId} task={task} />
                  ))}
                </ListSection>
              ))
            )}
            <ListSection title={gt("Approvals")} footer={screen.approvalFooter}>
              {screen.approvals.kind === "list" ? (
                screen.approvals.items.map((item) => (
                  <ListRowLayout key={item.id} label={item.title} description={item.detail} />
                ))
              ) : screen.approvals.kind === "loading" ? (
                <View className="items-center py-4">
                  <AppActivityIndicator />
                </View>
              ) : (
                <Text
                  className={
                    screen.approvals.kind === "error"
                      ? "p-4 text-base text-danger-foreground"
                      : "p-4 text-base text-foreground-muted"
                  }
                >
                  {screen.approvals.message}
                </Text>
              )}
            </ListSection>
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function TaskRow(props: { readonly environmentId: EnvironmentId; readonly task: EngineTaskItem }) {
  const { environmentId, task } = props;
  const gt = useGT();
  const stopTask = useAtomCommand(agentdEnvironment.stopTask, { reportFailure: false });
  const [state, setState] = useState<"idle" | "pending" | "requested">("idle");
  const [error, setError] = useState<string | null>(null);
  const id = task.id;

  if (!task.canStop || !isHandoffId(id)) {
    return <ListRowLayout label={task.title} description={task.detail} />;
  }

  const stop = () =>
    Dialog.confirm({
      title: gt("Stop this background task?"),
      message: task.title,
      confirmText: gt("Stop", { $context: "verb, stop a background task" }),
      destructive: true,
      onConfirm: () => {
        setState("pending");
        setError(null);
        void stopTask({
          environmentId,
          input: { id, reason: "Stopped from LibraOS Next on a phone" },
        }).then((result) => {
          if (AsyncResult.isFailure(result)) {
            const cause = squashAtomCommandFailure(result);
            setError(cause instanceof Error ? cause.message : gt("Couldn't stop the task."));
            setState("idle");
            return;
          }
          setState("requested");
        });
      },
    });

  return (
    <View>
      <ListRowLayout label={task.title} description={task.detail} />
      <ListActionRow
        icon="stop.fill"
        tone="danger"
        label={
          state === "requested"
            ? gt("Stop requested")
            : gt("Stop", { $context: "verb, stop a background task" })
        }
        disabled={state === "requested"}
        loading={state === "pending"}
        onPress={stop}
      />
      {error ? (
        <Text selectable className="px-4 pb-3 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
