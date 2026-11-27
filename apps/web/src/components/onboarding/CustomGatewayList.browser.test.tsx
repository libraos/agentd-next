import { EnvironmentId, type CustomGatewaySummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { CustomGatewayList } from "./CustomGatewayList";

const gateway: CustomGatewaySummary = {
  id: "work",
  name: "Work",
  url: "https://gateway.example.com",
  format: "openai",
  hasKey: true,
  modelCount: 1,
  models: ["chat-model"],
  hiddenModels: [],
  mediaModels: [
    { id: "veo-4", kind: "video" },
    { id: "flux-2", kind: "image" },
  ],
  agents: ["codex"],
};

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => [],
}));
vi.mock("../../lib/customGatewayState", () => ({
  useCustomGateways: () => ({ data: { gateways: [gateway] }, dataUpdatedAt: 1 }),
  useCustomGatewayCommands: () => ({
    canChange: true,
    rename: vi.fn(),
    remove: vi.fn(),
    setHiddenModels: vi.fn(),
  }),
}));

it("lists the gateway's video and image models apart, saying no agent chats with them", async () => {
  await using screen = await render(
    <CustomGatewayList environmentId={EnvironmentId.make("test")} />,
  );
  await expect
    .element(screen.getByText("2 more models are not for chat. See Models."))
    .toBeVisible();

  await screen.getByRole("button", { name: "Models" }).click();
  await expect.element(screen.getByRole("checkbox", { name: "chat-model" })).toBeChecked();
  await expect.element(screen.getByRole("checkbox", { name: /veo-4/ })).not.toBeInTheDocument();
  const media = screen.getByRole("region", { name: "Not for chat" });
  await expect
    .element(
      media.getByText(
        "2 models on this gateway make video, images, audio or vectors, so no agent can chat with them.",
        { exact: false },
      ),
    )
    .toBeVisible();
  await expect.element(media.getByText("veo-4")).toBeVisible();
  await expect.element(media.getByText("Video")).toBeVisible();
  await expect.element(media.getByText("flux-2")).toBeVisible();
  await expect.element(media.getByText("Image")).toBeVisible();
});
