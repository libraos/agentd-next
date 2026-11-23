import {
  type AgentdBeforeSendReview,
  type AgentdPlugins,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { BeforeSendControls } from "./BeforeSendControls";
import { requestBeforeSendReview, useBeforeSendReviewStore } from "./beforeSendReviewStore";

const ENVIRONMENT = EnvironmentId.make("environment-1");
const THREAD = ThreadId.make("thread-1");
const MESSAGE = MessageId.make("message-1");
const REVIEW: AgentdBeforeSendReview = {
  reviewId: "review-1",
  threadId: THREAD,
  messageId: MESSAGE,
  plugins: ["Redactor"],
  original: { text: "my password is hunter2", attachments: [] },
  proposed: { text: "my password is [redacted]", attachments: [] },
};

const state = vi.hoisted(() => ({
  plugins: null as AgentdPlugins | null,
  review: vi.fn(),
  confirm: vi.fn(),
  discard: vi.fn(),
}));

vi.mock(import("~/lib/agentdState"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useAgentdPlugins: (() => ({
      data: state.plugins,
    })) as unknown as typeof actual.useAgentdPlugins,
    useAgentdPluginCommands: (() => ({
      review: state.review,
      confirm: state.confirm,
      discard: state.discard,
    })) as unknown as typeof actual.useAgentdPluginCommands,
  };
});

function setup(beforeSend: boolean) {
  useBeforeSendReviewStore.setState({ request: null });
  state.plugins = {
    source: "cache",
    beforeSend,
    plugins: [
      {
        id: "redactor",
        name: "Redactor",
        description: "",
        author: "",
        licence: "",
        version: "1.0.0",
        installedVersion: "1.0.0",
        hooks: ["before-send"],
        enabled: beforeSend,
        state: beforeSend ? "on" : "off",
      },
    ],
  };
  state.review.mockReset().mockResolvedValue({ _tag: "Success", value: REVIEW });
  state.confirm.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  state.discard.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  const onSent = vi.fn();
  return { onSent };
}

const controls = (
  <TooltipProvider>
    <BeforeSendControls environmentId={ENVIRONMENT} projectId={ProjectId.make("project-1")} />
  </TooltipProvider>
);

it("shows the indicator only while a before-send hook is ready, and asks for no review without one", async () => {
  const { onSent } = setup(false);
  await using screen = await render(controls, { router: false }); // no route is read
  await expect
    .element(screen.getByRole("img", { name: "Checked before sending" }))
    .not.toBeInTheDocument();
  requestBeforeSendReview({
    environmentId: ENVIRONMENT,
    threadId: THREAD,
    messageId: MESSAGE,
    onSent,
  });
  await vi.waitFor(() => expect(useBeforeSendReviewStore.getState().request).toBeNull());
  expect(state.review).not.toHaveBeenCalled();

  setup(true);
  await screen.rerender(
    <TooltipProvider>
      <BeforeSendControls environmentId={ENVIRONMENT} projectId={ProjectId.make("project-1")} />
    </TooltipProvider>,
  );
  await expect.element(screen.getByRole("img", { name: "Checked before sending" })).toBeVisible();
});

it("closing the review sends nothing and discards the held message", async () => {
  const { onSent } = setup(true);
  await using _screen = await render(controls, { router: false }); // no route is read
  requestBeforeSendReview({
    environmentId: ENVIRONMENT,
    threadId: THREAD,
    messageId: MESSAGE,
    onSent,
  });
  const dialog = page.getByRole("dialog", { name: "Review the changed message" });
  await expect.element(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).first().click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(state.discard).toHaveBeenCalledWith({
    environmentId: ENVIRONMENT,
    input: { reviewId: "review-1" },
  });
  expect(state.confirm).not.toHaveBeenCalled();
  expect(onSent).not.toHaveBeenCalled();
});

it("sends the content as the person edited it, then clears the draft", async () => {
  const { onSent } = setup(true);
  await using _screen = await render(controls, { router: false }); // no route is read
  requestBeforeSendReview({
    environmentId: ENVIRONMENT,
    threadId: THREAD,
    messageId: MESSAGE,
    onSent,
  });
  const dialog = page.getByRole("dialog", { name: "Review the changed message" });
  const message = dialog.getByRole("textbox", { name: "Message" });
  await expect.element(message).toHaveValue("my password is [redacted]");
  await userEvent.clear(message);
  await userEvent.type(message, "my password is secret");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(state.confirm).toHaveBeenCalledWith({
    environmentId: ENVIRONMENT,
    input: { reviewId: "review-1", content: { text: "my password is secret", attachments: [] } },
  });
  expect(onSent).toHaveBeenCalledOnce();
  expect(state.discard).not.toHaveBeenCalled();
});
