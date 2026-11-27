# 335 — A custom gateway's video, image and audio models are shown, not silently dropped

A gateway's model list can mark models as `video`, `image`, `audio`, `embedding(s)` or `rerank`. They stay out of every agent's model list (no agent can chat with them), but the gateway's row in Providers → Custom endpoint now says how many there are, and its Models panel lists them apart with their kind and where they can be used: the video and audio ones through the media tools (#960); image and embedding models are not supported yet.

Ours (no upstream counterpart):

- `packages/contracts/src/customGateway.ts` — `mediaModels` on the stored setting and the summary.
- `apps/server/src/gateway/gatewaySetup.ts` — `parseGatewayMediaModels`: the models `parseGatewayModels` leaves out, with their kind.
- `apps/server/src/gateway/gatewayKeyModels.ts` — A model list answer carries them too.
- `apps/server/src/gateway/CustomGateway.ts` (+ test) — Kept on add and refresh, listed in the summary.
- `apps/web/src/components/onboarding/CustomGatewayList.tsx` (+ browser test) — The count line and the "Not for chat" list.

Upstream files:

- `apps/web/src/i18n/translations/*.json` — The new strings in every locale.

Not done: an image generation tool, and a way to pick a media model outside a thread's chat.
