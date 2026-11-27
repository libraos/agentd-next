export const CUSTOMIZE_PANES = ["plugins", "connectors", "skills"] as const;
export type CustomizePane = (typeof CUSTOMIZE_PANES)[number];
