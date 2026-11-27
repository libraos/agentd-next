import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/** The LibraOS Next N in one colour: two split stems and the diagonal (assets/prod/app-icon.icon). */
export function NextMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const color = { color: props.color, colorClassName: props.colorClassName };
  return (
    <Svg
      accessibilityLabel="LibraOS Next"
      height={props.height}
      width={props.height}
      viewBox="0 0 100 100"
    >
      <ThemedPath
        d="M0 0H17V46H0ZM0 54H17V100H0ZM83 0H100V46H83ZM83 54H100V100H83ZM0 0H17L100 100H83Z"
        {...color}
        fill="currentColor"
      />
    </Svg>
  );
}
