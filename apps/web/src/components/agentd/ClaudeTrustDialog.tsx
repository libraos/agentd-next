import { T, useGT } from "gt-react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

/**
 * Claude Code's own trust question, asked before a worker starts where it never ran: a worker
 * can't answer it and would stop at "Workspace not trusted". Trust records it for that folder only.
 */
export function ClaudeTrustDialog({
  folder,
  onTrust,
  onCancel,
}: {
  readonly folder: string | null;
  readonly onTrust: () => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  return (
    <AlertDialog
      open={folder !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <span className="wrap-anywhere">
              {gt("Let Claude Code work in {folder}?", { folder: folder ?? "" })}
            </span>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <T>
              Claude Code hasn’t worked in this folder before. A worker can read, change and run
              files in it. Trust it only if you trust its contents. This is saved in Claude Code’s
              settings for this folder only.
            </T>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button onClick={onTrust}>
            <T>Trust folder</T>
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
