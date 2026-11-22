import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AgentdBeforeSendContent,
  AgentdBeforeSendReview,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ShieldCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useAgentdPluginCommands, useAgentdPlugins } from "~/lib/agentdState";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type BeforeSendReviewRequest, useBeforeSendReviewStore } from "./beforeSendReviewStore";

/**
 * Beside Send while a before-send hook is ready for this project, and the review of a message a
 * hook rewrote. Plugins ship no UI; this is the host's.
 */
export function BeforeSendControls({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}) {
  const gt = useGT();
  const plugins = useAgentdPlugins(environmentId, projectId);
  const active = plugins.data?.beforeSend === true;
  const names = (plugins.data?.plugins ?? [])
    .filter((plugin) => plugin.state === "on" && plugin.hooks.includes("before-send"))
    .map((plugin) => plugin.name)
    .join(", ");
  return (
    <>
      {active ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={gt("Checked before sending")}
                className="inline-flex shrink-0 items-center text-muted-foreground"
              />
            }
          >
            <ShieldCheckIcon aria-hidden className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {gt("{names} checks each message before it is sent.", { names })}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <BeforeSendReviewDialog environmentId={environmentId} active={active} />
    </>
  );
}

function BeforeSendReviewDialog({
  environmentId,
  active,
}: {
  readonly environmentId: EnvironmentId;
  readonly active: boolean;
}) {
  const request = useBeforeSendReviewStore((store) =>
    store.request?.environmentId === environmentId ? store.request : null,
  );
  const setRequest = useBeforeSendReviewStore((store) => store.setRequest);
  const commands = useAgentdPluginCommands();
  const [held, setHeld] = useState<{
    readonly review: AgentdBeforeSendReview;
    readonly onSent: BeforeSendReviewRequest["onSent"];
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for the review it holds for a failed send
  useEffect(() => {
    // Another composer of this environment may have taken it already.
    if (request === null || useBeforeSendReviewStore.getState().request !== request) return;
    setRequest(null);
    if (!active) return;
    void commands
      .review({
        environmentId,
        input: { threadId: request.threadId, messageId: request.messageId },
      })
      .then((result) => {
        if (result._tag === "Success" && result.value !== null) {
          setHeld({ review: result.value, onSent: request.onSent });
        }
      });
  }, [request, active, environmentId, commands, setRequest]);

  if (held === null) return null;
  return (
    <ReviewDialog
      key={held.review.reviewId}
      review={held.review}
      onClose={() => {
        void commands.discard({ environmentId, input: { reviewId: held.review.reviewId } });
        setHeld(null);
      }}
      onConfirm={async (content) => {
        const result = await commands.confirm({
          environmentId,
          input: { reviewId: held.review.reviewId, content },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          return error instanceof Error ? error.message : null;
        }
        held.onSent();
        setHeld(null);
        return undefined;
      }}
    />
  );
}

function ReviewDialog({
  review,
  onClose,
  onConfirm,
}: {
  readonly review: AgentdBeforeSendReview;
  readonly onClose: () => void;
  /** Resolves to undefined once sent, else the reason it was not. */
  readonly onConfirm: (content: AgentdBeforeSendContent) => Promise<string | null | undefined>;
}) {
  const gt = useGT();
  const [content, setContent] = useState(review.proposed);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const plugins = review.plugins.join(", ");

  async function confirm() {
    setSending(true);
    setFailure(null);
    const reason = await onConfirm(content);
    setSending(false);
    if (reason !== undefined) setFailure(reason ?? gt("The message was not sent."));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !sending) onClose();
      }}
    >
      <DialogPopup showCloseButton={!sending}>
        <DialogHeader>
          <DialogTitle>
            <T>Review the changed message</T>
          </DialogTitle>
          <DialogDescription>
            {gt(
              "{plugins} changed this message. Send it as shown, edit it first, or close to keep your draft unsent.",
              { plugins },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <T>Message</T>
              <Textarea
                value={content.text}
                disabled={sending}
                rows={6}
                onChange={(event) => setContent({ ...content, text: event.target.value })}
              />
            </label>
            {content.attachments.map((attachment, index) => (
              <label key={attachment.id} className="flex flex-col gap-1 text-sm">
                <span className="wrap-anywhere">{attachment.name}</span>
                <Textarea
                  value={attachment.text}
                  disabled={sending}
                  rows={4}
                  onChange={(event) =>
                    setContent({
                      ...content,
                      attachments: content.attachments.map((other, at) =>
                        at === index ? { ...other, text: event.target.value } : other,
                      ),
                    })
                  }
                />
              </label>
            ))}
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                <T>Your original message</T>
              </summary>
              <p className="mt-1 whitespace-pre-wrap wrap-anywhere">{review.original.text}</p>
            </details>
            {failure === null ? null : (
              <p role="alert" className="text-destructive text-sm wrap-anywhere">
                {failure}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={sending} onClick={onClose}>
            <T>Close</T>
          </Button>
          <Button type="button" disabled={sending} onClick={() => void confirm()}>
            {sending ? <T>Sending…</T> : <T>Send</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
