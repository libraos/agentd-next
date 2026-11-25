import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";

import { productProfile } from "./productProfile";
import { Route as IssuesRoute } from "./routes/_chat.issues";
import { Route as PullRequestsRoute } from "./routes/_chat.pull-requests";
import { Route as AccessRoute } from "./routes/_chat.settings.access";
import { Route as ScheduledTasksRoute } from "./routes/_chat.settings.scheduled-tasks";
import { Route as WorkflowsRoute } from "./routes/_chat.workflows";

const hiddenPages = [
  ["/issues", "issues", IssuesRoute],
  ["/pull-requests", "pullRequests", PullRequestsRoute],
  ["/settings/access", "sharingAndAccess", AccessRoute],
  ["/settings/scheduled-tasks", "scheduledTasks", ScheduledTasksRoute],
  ["/workflows", "workflows", WorkflowsRoute],
] as const;

function routerFor(path: (typeof hiddenPages)[number][0]) {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, path: "/" });
  const pages = hiddenPages.map(([path, , route]) =>
    createRoute({
      getParentRoute: () => root,
      path,
      beforeLoad: (context) => route.options.beforeLoad?.(context as never),
    }),
  );
  return createRouter({
    routeTree: root.addChildren([chat, ...pages]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

it.each(hiddenPages)(
  "redirects a direct visit to %s to chat unless enabled",
  async (path, flag) => {
    const disabled = routerFor(path);
    await disabled.load();

    expect(disabled.state.redirect?.headers.get("location")).toBe("/");
    expect(disabled.state.redirect?.options.replace).toBe(true);

    const original = productProfile[flag];
    try {
      productProfile[flag] = true;
      const enabled = routerFor(path);
      await enabled.load();

      expect(enabled.state.redirect).toBeUndefined();
      expect(enabled.state.matches.at(-1)?.pathname).toBe(path);
    } finally {
      productProfile[flag] = original;
    }
  },
);
