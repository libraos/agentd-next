# Render count regressions from the 2026-11-25 upstream merge

Three app render scenarios failed after upstream b61af8a5d2 was merged, and the stream scenario's markdown check found no component to count. These are small fixes in upstream files. One scenario expectation changed, to follow upstream's rename.

- `apps/web/src/components/Sidebar.tsx`: `handleThreadClick` checks the open thread through a stable callback. Upstream 5812320a6a (#41258) made it read `routeThreadKey`, so every sidebar row got a new click handler on each thread switch.
- `apps/web/src/components/chat/TimelineMinimap.tsx`: the at-end flag is a small store that the minimap subscribes to, so a change re-renders only the minimap.
- `apps/web/src/components/chat/MessagesTimeline.tsx`: writes that store in place of the `minimapAtEnd` state. Since upstream 0938476b95 (#41060) removes the Thinking row under a streaming reply, the list reaches its exact end for a frame as a reply starts, and that state re-rendered the whole timeline.
- `apps/web/src/components/chat/TimelineAssistantRows.tsx`: the `agentDirectories` callback is built before the task-draft branch. Inside that branch, React Compiler rebuilt it with the streamed text, and the new callback changed ChatMarkdown's file-link handlers and so its renderer context, which re-rendered every finished block on each delta (465 `MarkdownSource` renders against upstream's 59).
- `apps/web/test/appScenarios.renders.tsx`: the stream scenario counts `MarkdownSource`, which upstream 0fb6ac6e65 renders per block in place of `MarkdownParagraph`. That gives one render for each new block plus one as the block before it is marked finished.
