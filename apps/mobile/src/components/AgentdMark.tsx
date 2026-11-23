import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/** The AgentD mark in one colour: three arcs of a ring and the stem of the d. */
export function AgentdMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 139 / 174;
  const color = { color: props.color, colorClassName: props.colorClassName };
  return (
    <Svg
      accessibilityLabel="AgentD Next"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="28 14 139 174"
    >
      <ThemedPath
        d="M148.13 94.57A58 58 0 0 1 100.05 177.86M91.95 177.86A58 58 0 0 1 43.87 94.57M47.92 87.57A58 58 0 0 1 144.08 87.57"
        {...color}
        fill="none"
        stroke="currentColor"
        strokeWidth={17}
      />
      <ThemedPath d="M147.5 16H164.5V182.5H147.5Z" {...color} fill="currentColor" />
    </Svg>
  );
}
