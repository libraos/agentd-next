import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/** A send that failed while a before-send hook was on; the review dialog asks if one is held. */
export interface BeforeSendReviewRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /** Clears the restored draft once the confirmed message is sent. */
  readonly onSent: () => void;
}

export const useBeforeSendReviewStore = create<{
  readonly request: BeforeSendReviewRequest | null;
  readonly setRequest: (request: BeforeSendReviewRequest | null) => void;
}>((set) => ({
  request: null,
  setRequest: (request) => set({ request }),
}));

export const requestBeforeSendReview = (request: BeforeSendReviewRequest) =>
  useBeforeSendReviewStore.getState().setRequest(request);
