import type {
  EnvironmentId,
  OrchestrationV2ProviderFailureClass,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { libraosCreditsRefusal } from "@t3tools/contracts";
import type { Dispatch, SetStateAction } from "react";
import { LibraosCreditsThreadError } from "../agentd/LibraosCreditsThreadError";
import {
  dismissProviderStatusBannerForSession,
  ProviderStatusBanner,
} from "./ProviderStatusBanner";
import { dismissThreadErrorBannerForSession, ThreadErrorBanner } from "./ThreadErrorBanner";

/**
 * The banners pinned above the timeline. The dismiss handlers are built here from plain
 * values, so a ChatView render that changes neither banner leaves both cached.
 */
export function ChatBannerLane(props: {
  environmentId: EnvironmentId;
  providerStatus: ServerProvider | null;
  providerStatusDismissalKey: string | null;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  threadId: ThreadId;
  threadError: string | null;
  threadErrorProvider: string | null;
  threadErrorClass: OrchestrationV2ProviderFailureClass | null;
  threadErrorCode: string | null;
  threadErrorInstanceId: string | null;
  threadErrorBannerKey: string | null;
  onRetryThreadError: (() => void) | null;
  threadErrorRetrying: boolean;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  setThreadErrorBannerDismissTick: Dispatch<SetStateAction<number>>;
}) {
  const {
    providerStatus,
    providerStatusDismissalKey,
    onOpenProviderSetup,
    threadId,
    threadError,
    threadErrorClass,
    threadErrorCode,
    threadErrorBannerKey,
    setThreadError,
    setThreadErrorBannerDismissTick,
  } = props;
  const dismissThreadError = () => {
    setThreadError(threadId, null);
    dismissThreadErrorBannerForSession(threadErrorBannerKey);
    setThreadErrorBannerDismissTick((tick) => tick + 1);
  };
  const creditsRefusal = libraosCreditsRefusal(props.threadErrorInstanceId, threadError);
  return (
    <div className="chat-banner-lane pointer-events-none absolute top-0 z-30 flex flex-col">
      <ProviderStatusBanner
        environmentId={props.environmentId}
        status={providerStatus}
        onDismiss={() => dismissProviderStatusBannerForSession(providerStatusDismissalKey)}
        onOpenProviderSetup={onOpenProviderSetup}
      />
      {creditsRefusal === null ? (
        <ThreadErrorBanner
          error={threadError}
          provider={props.threadErrorProvider}
          errorClass={threadErrorClass}
          errorCode={threadErrorCode}
          onDismiss={dismissThreadError}
        />
      ) : (
        <LibraosCreditsThreadError
          environmentId={props.environmentId}
          refusal={creditsRefusal}
          provider={props.threadErrorProvider}
          onRetry={props.onRetryThreadError}
          retrying={props.threadErrorRetrying}
          onDismiss={dismissThreadError}
        />
      )}
    </div>
  );
}
