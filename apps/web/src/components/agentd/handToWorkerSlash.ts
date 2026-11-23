/** The composer's `/hand-to-worker` command, shown by its command like every other built-in one. */
export function handToWorkerSlashItem(description: string) {
  return {
    id: "slash:hand-to-worker",
    type: "slash-command",
    command: "hand-to-worker",
    label: "/hand-to-worker",
    description,
  } as const;
}
