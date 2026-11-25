# Hand a task to a worker

With [LibraOS Engine](https://github.com/libraos/engine) set up, you can hand a task from a
conversation to a background worker (Claude Code, Codex or opencode). LibraOS Engine runs the worker
on its own branch and checks the result; the task shows in **Background tasks**.

## Start a task

Open **Hand to a worker** from the slash menu (type `/` in the composer), from the
command palette, or from the suggestion above the composer when a turn runs long. Fill in the
goal, acceptance criteria, check command and budget, then choose **Start**.

For a worker on your machine, the working directory must be a Git repository on a named branch.
From `main` or `master`, the worker runs on a new branch in its own worktree and leaves your
checkout alone.

In **Background tasks**, a queued local task with no agent chosen waits until someone
starts it. Use **Start with…** to choose an agent for the working directory shown in the
menu, or **Stop** to cancel the task. Tasks addressed to a recipient or waiting for a remote
worker show who can pick them up. If Core pauses automatic retries, look under **Waiting**
for the reason. Use **Start anyway** to retry an eligible task in its listed checkout. A task
whose worker asks for your approval also waits there: open its card to read the request and
the commands that approve or reject it.

## Get a task card from the conversation

In **Hand to a worker**, choose **Draft from this conversation**. The session's agent
is asked to write the task, and its reply shows in the chat as a task card with **Start** and
**Edit**. **Edit** opens the dialog with the card's fields.

Only that button produces a card. If you ask the agent in your own words, for example
"hand this to a worker", its answer is an ordinary reply: the app does not read it as a task. An
agent connected to LibraOS Engine may try to create the task itself, and LibraOS Engine refuses it while the
checkout is on the default branch. In either case, open **Hand to a worker** and choose
**Draft from this conversation** to get the card.

## Budgets

A budget is minutes (`60m`), dollars (`$5`) or both (`60m,$5`). The worker is stopped
when it runs out.

A dollar limit for a worker on your machine needs model prices in LibraOS Engine's
`[budget.prices]`. Without them the default budget is minutes only, and a budget with dollars is
flagged before **Start**. Cloud Workers are priced by the service and always take a dollar cap.

The default comes from LibraOS Engine's estimate for similar tasks, else from **Settings →
Workers → Default budget**.

## What workers may do without asking

When you set up LibraOS Engine, you choose how much its workers may do without asking:

- **Ask first.** A worker stops and waits when a command needs permission. The task then says
  it is waiting and shows the command to answer it in a terminal, such as `claude attach`.
- **Run without asking.** Workers run any command in their own worktree, with network. They
  still cannot push, merge or open a pull request, and budgets and checks still apply.

**Settings → Workers** shows the current choice. You can switch to **Ask first** there at any
time. Going back to **Run without asking** is done in a terminal, with the command Settings
shows.
