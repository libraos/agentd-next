# Brand icons

The three Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project uses `text.svg` for the LibraOS Next N (two segmented blue stems and a gold diagonal; the design source is `agentd/design/n-mark.svg`) on the navy fill set in `icon.json`. Development, nightly, and production ship the same artwork and keep their existing filenames for the build tools. The decorative backgrounds remain inputs to the Android exporter. The N is the desktop and web icon only: the iOS PNGs and the Android artwork belong to the mobile app, which keeps the AgentD mark. `vp run icons:export` and `vp run icons:export:android` read the same `text.svg`, so running them now would put the N on the mobile app too.

To regenerate the desktop and web PNGs and ICOs without macOS, run `node agentd/scripts/regenerate-brand-icons.mjs` with workspace dependencies installed. It renders the production `text.svg` on the navy rounded square as approved in `agentd/design/n-icon-preview.svg`: the Linux PNGs, the Windows ICOs, the web favicons and manifest icons, and the macOS PNGs in the safe-area layout described below, without Icon Composer's shadow. The development web exports are also copied to `apps/web/public` for the browser favicon, web app manifest icons, and splash screen. The DMG backgrounds in `apps/desktop/resources/dmg` carry their own copy of the mark.

For a native Icon Composer export from the vector layers, run `vp run icons:export` from the repository root. `vp run icons:check` compares against that native export, not against the rasters the script renders.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

Icon Composer's command-line exporter does not expose the `macOS pre-Tahoe` preset. A plain command-line `macOS` export is full bleed and is not suitable for the desktop app, so the export script intentionally leaves the tracked macOS PNGs unchanged and prints a reminder after every run.

After changing an Icon Composer project, open it in Icon Composer and export the macOS PNG with exactly these settings:

- Platform: `macOS pre-Tahoe`
- Appearance: `Default`
- Size: `1024pt`
- Scale: `1×`

Save the three exports to:

- `dev/app-icon.icon` -> `dev/blueprint-macos-1024.png`
- `nightly/app-icon.icon` -> `nightly/nightly-macos-1024.png`
- `prod/app-icon.icon` -> `prod/black-macos-1024.png`

The result must be a 1024×1024 PNG with the classic macOS safe area: the opaque icon body is 824×824, inset 100 pixels on every side, with only the native Icon Composer shadow extending into the surrounding transparent canvas.

To have Codex perform the native exports, paste this prompt into a task opened at the repository root:

```text
Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the three macOS app icons in this repository.

For each project below, use Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, and Scale: 1×, then save the PNG to the exact destination:

- assets/dev/app-icon.icon -> assets/dev/blueprint-macos-1024.png
- assets/nightly/app-icon.icon -> assets/nightly/nightly-macos-1024.png
- assets/prod/app-icon.icon -> assets/prod/black-macos-1024.png

Do not resize, composite, or otherwise post-process the exported PNGs.

Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only Icon Composer's native shadow extending beyond it.
```

The tracked macOS PNGs are currently rendered on Linux by `agentd/scripts/regenerate-brand-icons.mjs`: an 824px navy rounded square inset 100px on the transparent 1024px canvas, with no shadow. Desktop packaging generates ICNS files from those PNGs on macOS. A native Icon Composer export made as above can replace them at any time.

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette gets framed again and the wordmark is cropped. The Android artwork
is instead rendered from the same Icon Composer SVG sources by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground.png`: the shared transparent wordmark, sized to stay
  inside the safe zone
- `apps/mobile/assets/android-icon-background-nightly.png`: full-bleed variant artwork (night sky
  and clouds). Development and production use a solid color.
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image, so
  the splash mask reproduces the launcher icon's framing.

Rerun the export after changing a layer SVG. It also writes the mark in one color:
`android-icon-mark.png` for Android's themed icon and `android-notification-icon.png` for the
status bar.
