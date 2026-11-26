import type { AgentdPluginListing } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { usePluginOriginLabel } from "./AgentdPluginOrigin";

/**
 * An installed plugin's MCP servers, exactly as they will be started, and the form for the
 * settings they need. A secret setting is never shown back: only whether one is saved.
 */
export function AgentdPluginContributions({
  plugin,
  disabled,
  onSave,
}: {
  readonly plugin: AgentdPluginListing;
  readonly disabled: boolean;
  readonly onSave: (values: Readonly<Record<string, string | null>>) => void;
}) {
  const gt = useGT();
  const originLabel = usePluginOriginLabel();
  const servers = plugin.mcpServers ?? [];
  const settings = plugin.settings ?? [];
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>({});
  if (servers.length === 0 && settings.length === 0) return null;
  const changed = Object.keys(draft).length > 0;

  return (
    <div className="mt-1 flex flex-col gap-2 rounded-md border p-2">
      {servers.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">
            <T>
              While this plugin is on, Claude Code and Codex agents started here get these MCP
              servers. Other agents do not get them.
            </T>
          </p>
          <p className="text-muted-foreground text-xs">
            {gt("Source: {source}", { source: originLabel(plugin.origin) })}
          </p>
          <ul className="flex flex-col gap-1">
            {servers.map((server) => (
              <li key={server.name} className="flex flex-col gap-0.5">
                <span className="font-medium text-xs">{server.name}</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs wrap-anywhere">
                  {[server.command, ...server.args].join(" ")}
                </code>
                {server.env.length === 0 ? null : (
                  <span className="text-muted-foreground text-xs wrap-anywhere">
                    {gt("Environment: {names}", { names: server.env.join(", ") })}
                  </span>
                )}
                {server.missing.length === 0 ? null : (
                  <span className="text-warning-foreground text-xs">
                    {gt("Not given to agents until these are set: {names}", {
                      names: server.missing
                        .map(
                          (name) =>
                            settings.find((setting) => setting.name === name)?.label ?? name,
                        )
                        .join(", "),
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {settings.length === 0 ? null : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            // An emptied secret field keeps the saved secret; Clear removes it.
            onSave(
              Object.fromEntries(
                Object.entries(draft).filter(
                  ([name, value]) =>
                    value !== "" ||
                    settings.find((setting) => setting.name === name)?.secret !== true,
                ),
              ),
            );
            setDraft({});
          }}
        >
          {settings.map((setting) => {
            const id = `plugin-${plugin.id}-${setting.name}`;
            return (
              <div key={setting.name} className="flex flex-col gap-1">
                <Label htmlFor={id}>{setting.label}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={id}
                    size="sm"
                    type={setting.secret ? "password" : "text"}
                    autoComplete="off"
                    disabled={disabled}
                    value={draft[setting.name] ?? (setting.secret ? "" : (setting.value ?? ""))}
                    placeholder={setting.secret && setting.set ? gt("Saved; type to replace") : ""}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, [setting.name]: event.target.value }))
                    }
                  />
                  {setting.secret && setting.set ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={disabled}
                      aria-label={gt("Clear {label}", { label: setting.label })}
                      onClick={() => onSave({ [setting.name]: null })}
                    >
                      <T>Clear</T>
                    </Button>
                  ) : null}
                </div>
                {setting.description === undefined ? null : (
                  <span className="text-muted-foreground text-xs">{setting.description}</span>
                )}
              </div>
            );
          })}
          <div>
            <Button type="submit" size="xs" variant="outline" disabled={disabled || !changed}>
              <T>Save settings</T>
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
