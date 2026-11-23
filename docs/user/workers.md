# Hand a task to a worker

With [agentd](https://github.com/libraos/agentd) set up, you can hand a task from a
conversation to a background worker (Claude Code, Codex or opencode). agentd runs the worker
on its own branch and checks the result; the task shows in **Background tasks**.

## Start a task

Open **Hand to a worker** from the slash menu (type `/` in the composer), from the
command palette, or from the suggestion above the composer when a turn runs long. Fill in the
goal, acceptance criteria, check command and budget, then choose **Start**.

For a worker on your machine, the working directory must be a Git repository on a named branch.
From `main` or `master`, the worker runs on a new branch in its own worktree and leaves your
checkout alone.

## Get a task card from the conversation

In **Hand to a worker**, choose **Draft from this conversation**. The session's agent
is asked to write the task, and its reply shows in the chat as a task card with **Start** and
**Edit**. **Edit** opens the dialog with the card's fields.

Only that button produces a card. If you ask the agent in your own words, for example
"hand this to a worker", its answer is an ordinary reply: the app does not read it as a task. An
agent connected to agentd may try to create the task itself, and agentd refuses it while the
checkout is on the default branch. In either case, open **Hand to a worker** and choose
**Draft from this conversation** to get the card.

## Budgets

A budget is minutes (`60m`), dollars (`$5`) or both (`60m,$5`). The worker is stopped
when it runs out.

A dollar limit for a worker on your machine needs model prices in agentd's
`[budget.prices]`. Without them the default budget is minutes only, and a budget with dollars is
flagged before **Start**. Cloud Workers are priced by the service and always take a dollar cap.

The default comes from agentd's estimate for similar tasks, else from **Settings →
Workers → Default budget**.
