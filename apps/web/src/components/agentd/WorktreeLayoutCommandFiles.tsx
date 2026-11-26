import { T } from "gt-react";

import { cn } from "../../lib/utils";

/**
 * The project's own files a layout command names, which its approval covers: the server asks
 * again when one of them changes, not only when the command's text does.
 */
export function WorktreeLayoutCommandFiles({
  files,
  className,
}: {
  files: ReadonlyArray<string>;
  className?: string;
}) {
  if (files.length === 0) return null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 text-xs text-muted-foreground", className)}>
      <span>
        <T>
          This command runs files from the project. Approval covers them as they are now, and a
          change to any of them asks again:
        </T>
      </span>
      <ul className="flex min-w-0 flex-col gap-0.5 font-mono">
        {files.map((file) => (
          <li key={file} className="wrap-anywhere">
            {file}
          </li>
        ))}
      </ul>
    </div>
  );
}
