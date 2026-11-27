import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { compileModsAsync } from "expo/config-plugins";
import { afterEach, describe, expect, it } from "vite-plus/test";

import withAndroidKeepNewIntent from "./withAndroidKeepNewIntent.cjs";

// Trimmed from the MainActivity.kt that `expo prebuild` generates for this app.
const MAIN_ACTIVITY = `package com.libraos.next

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

const projectRoots: string[] = [];

afterEach(() => {
  for (const root of projectRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

async function prebuildAndroid(mainActivity: string) {
  const projectRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "keep-new-intent-"));
  projectRoots.push(projectRoot);
  const activityPath = NodePath.join(
    projectRoot,
    "android/app/src/main/java/com/libraos/next/MainActivity.kt",
  );
  NodeFS.mkdirSync(NodePath.dirname(activityPath), { recursive: true });
  NodeFS.writeFileSync(activityPath, mainActivity);
  NodeFS.writeFileSync(
    NodePath.join(projectRoot, "android/app/src/main/AndroidManifest.xml"),
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:name=".MainApplication"><activity android:name=".MainActivity"/></application></manifest>`,
  );

  const config = withAndroidKeepNewIntent({ name: "LibraOS Next", slug: "libraos-next" });
  await compileModsAsync(config, { projectRoot, platforms: ["android"] });
  return NodeFS.readFileSync(activityPath, "utf8");
}

describe("withAndroidKeepNewIntent", () => {
  it("makes a link delivered to the running activity its intent, which getInitialURL reads", async () => {
    const mainActivity = await prebuildAndroid(MAIN_ACTIVITY);

    expect(mainActivity).toContain("import android.os.Bundle\nimport android.content.Intent\n");
    expect(mainActivity).toMatch(
      /override fun onNewIntent\(intent: Intent\) \{\s*setIntent\(intent\)\s*super\.onNewIntent\(intent\)\s*\}/,
    );
  });

  it("stays stable on repeated prebuild", async () => {
    const once = await prebuildAndroid(MAIN_ACTIVITY);
    expect(await prebuildAndroid(once)).toEqual(once);
  });
});
