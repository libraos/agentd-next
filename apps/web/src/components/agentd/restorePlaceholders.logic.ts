import type { AgentdPlaceholderMap } from "@t3tools/contracts";
import type { Nodes, Parent, PhrasingContent, Root, Text } from "mdast";
import type { PluggableList } from "unified";

// A thread's replies come back with the placeholders a before-send hook put in its messages. The
// client shows and copies them with the original values; the agent and provider never see those.

const patterns = new WeakMap<AgentdPlaceholderMap, RegExp | null>();

/** Every placeholder of the map, longest first, so `[P_10]` is not read as `[P_1]` and a `0`. */
function placeholderPattern(map: AgentdPlaceholderMap): RegExp | null {
  if (patterns.has(map)) return patterns.get(map) ?? null;
  const keys = Object.keys(map).toSorted((a, b) => b.length - a.length || a.localeCompare(b));
  const pattern =
    keys.length === 0
      ? null
      : new RegExp(keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  patterns.set(map, pattern);
  return pattern;
}

export function hasPlaceholders(text: string, map: AgentdPlaceholderMap | null): boolean {
  const pattern = map === null ? null : placeholderPattern(map);
  // search, unlike test, ignores and keeps the shared global pattern's lastIndex.
  return pattern !== null && text.search(pattern) >= 0;
}

/** The text with each placeholder replaced by its original value, as copy gives it. */
export function restorePlaceholders(text: string, map: AgentdPlaceholderMap | null): string {
  const pattern = map === null ? null : placeholderPattern(map);
  if (pattern === null) return text;
  return text.replace(pattern, (placeholder) => map?.[placeholder] ?? placeholder);
}

function restoredNodes(node: Text, map: AgentdPlaceholderMap, pattern: RegExp) {
  const nodes: PhrasingContent[] = [];
  let cursor = 0;
  // matchAll starts at the pattern's lastIndex.
  pattern.lastIndex = 0;
  for (const match of node.value.matchAll(pattern)) {
    const placeholder = match[0];
    const value = map[placeholder];
    if (value === undefined) continue;
    if (match.index > cursor) {
      nodes.push({ type: "text", value: node.value.slice(cursor, match.index) });
    }
    nodes.push({
      type: "emphasis",
      children: [{ type: "text", value }],
      data: {
        hName: "span",
        hProperties: { dataAgentdRestored: placeholder },
      },
    });
    cursor = match.index + placeholder.length;
  }
  if (cursor === 0) return null;
  if (cursor < node.value.length) nodes.push({ type: "text", value: node.value.slice(cursor) });
  return nodes;
}

/** The parser leaves `[`, `PERSON_1` and `]` as separate text nodes when no link forms. */
function mergedText(children: Parent["children"]): Parent["children"] {
  const merged: Parent["children"] = [];
  for (const child of children) {
    const last = merged.at(-1);
    if (child.type === "text" && last?.type === "text") {
      merged[merged.length - 1] = { type: "text", value: last.value + child.value };
    } else {
      merged.push(child);
    }
  }
  return merged;
}

function restoreTree(tree: Nodes, map: AgentdPlaceholderMap, pattern: RegExp) {
  if (!("children" in tree)) return;
  const parent = tree as Parent;
  const children: Parent["children"] = [];
  for (const child of mergedText(parent.children)) {
    const restored = child.type === "text" ? restoredNodes(child, map, pattern) : null;
    if (restored === null) {
      restoreTree(child, map, pattern);
      children.push(child);
    } else {
      children.push(...restored);
    }
  }
  parent.children = children;
}

const plugins = new WeakMap<AgentdPlaceholderMap, PluggableList>();

/**
 * Remark plugins that show each placeholder in prose as its original value, marked; code keeps
 * the placeholder, as the agent wrote it. One list per map, so messages share its parse cache.
 */
export function restorePlaceholderPlugins(map: AgentdPlaceholderMap): PluggableList {
  const known = plugins.get(map);
  if (known !== undefined) return known;
  const pattern = placeholderPattern(map);
  const list: PluggableList =
    pattern === null ? [] : [() => (tree: Root) => restoreTree(tree, map, pattern)];
  plugins.set(map, list);
  return list;
}
