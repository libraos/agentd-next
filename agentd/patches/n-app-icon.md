# The desktop icon becomes the LibraOS Next N

The user replaced the lowercase d with a capital N on the desktop and web icon (dec-7b3f1941c9)
and on the mobile icon, splash and in-app logo that use the iOS PNGs (dec-3fc436f6b7). The mark is `agentd/design/n-mark.svg`, shown on the icon's navy rounded square in
`agentd/design/n-icon-preview.svg`. `agentd/scripts/regenerate-brand-icons.mjs` (ours) now renders
every desktop and web raster from the production Icon Composer `text.svg` instead of copying AgentD
Desktop's resources. The Android launcher artwork and the mobile app's vector `AgentdMark` keep
the AgentD mark.

## Upstream files changed

- `assets/{dev,nightly,prod}/app-icon.icon/Assets/text.svg`: the N mark, on a 100-unit canvas.
- `assets/{dev,nightly,prod}/app-icon.icon/icon.json`: layer named `N`, scale 5.12 so the mark spans
  half the icon as in the approved preview.
- `assets/{dev,nightly,prod}/*-macos-1024.png`: the N icon, 824px body inset 100px.
- `assets/{dev,nightly,prod}/*-universal-1024.png`: the N icon for Linux.
- `assets/{dev,nightly,prod}/*-ios-1024.png`: the N icon for the mobile app, same image as Linux.
- `assets/{dev,nightly,prod}/*-windows.ico`: the N icon, 16 to 256px.
- `assets/{dev,nightly,prod}/*-web-*`: the N favicons, Apple touch and manifest icons.
- `apps/web/public/{favicon.ico,favicon-16x16.png,favicon-32x32.png,apple-touch-icon.png,icon-192x192.png,icon-512x512.png}`:
  the N for the window favicon, manifest and splash.
- `apps/desktop/resources/dmg/dmg-background-{latest,nightly}.svg`: the N in the corner mark.
- `assets/README.md`: the mark is the N; how the rasters are rendered and that a native macOS
  export can replace the generated PNGs.
