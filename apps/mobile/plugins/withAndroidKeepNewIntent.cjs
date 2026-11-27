const { withMainActivity } = require("expo/config-plugins");

// React Native drops a link that reaches a running activity before its React context exists.
const NEW_INTENT_METHOD = `
  // Keeps a link tapped while React starts: Linking.getInitialURL reads this intent.
  // Added by withAndroidKeepNewIntent.
  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    super.onNewIntent(intent)
  }
`;

function insertAfter(contents, anchor, insertion, description) {
  const index = contents.indexOf(anchor);
  if (index === -1) {
    throw new Error(
      `withAndroidKeepNewIntent: could not find ${description} in MainActivity — the Expo template changed; update the plugin anchors.`,
    );
  }
  const end = index + anchor.length;
  return contents.slice(0, end) + insertion + contents.slice(end);
}

module.exports = function withAndroidKeepNewIntent(config) {
  return withMainActivity(config, (nextConfig) => {
    let contents = nextConfig.modResults.contents;
    if (nextConfig.modResults.language !== "kt") {
      throw new Error("withAndroidKeepNewIntent: MainActivity must be Kotlin.");
    }
    if (contents.includes("override fun onNewIntent(")) {
      return nextConfig;
    }
    if (!contents.includes("import android.content.Intent\n")) {
      contents = insertAfter(
        contents,
        "import android.os.Bundle",
        "\nimport android.content.Intent",
        "the android.os.Bundle import",
      );
    }
    contents = insertAfter(
      contents,
      "class MainActivity : ReactActivity() {",
      NEW_INTENT_METHOD,
      "the MainActivity class declaration",
    );
    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
