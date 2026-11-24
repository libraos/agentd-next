import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { BRAND_ASSET_PATHS, resolveWebIconOverrides } from "../../scripts/lib/brand-assets.ts";

const require = NodeModule.createRequire(new URL("../../scripts/package.json", import.meta.url));
const sharp = require("sharp");
const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
if (NodeProcess.argv.length !== 2) {
  throw new Error("Usage: node agentd/scripts/regenerate-brand-icons.mjs");
}

// Geometry of the approved agentd/design/n-icon-preview.svg: a 200-unit navy rounded square
// with the 100-unit mark centred. The fill matches the Icon Composer projects' solid fill.
const NAVY = "#151f3a";
const markSvg = await NodeFSP.readFile(
  NodePath.join(root, BRAND_ASSET_PATHS.productionIconComposerProject, "Assets", "text.svg"),
  "utf8",
);
const markBody = markSvg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const iconSvg = (size) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}">` +
      `<rect width="200" height="200" rx="44" fill="${NAVY}"/>` +
      `<svg x="50" y="50" width="100" height="100" viewBox="0 0 100 100">${markBody}</svg></svg>`,
  );
const renderIcon = (size) => sharp(iconSvg(size)).png().toBuffer();

// PNG-compressed ICO entries are valid on Windows Vista and later and in every browser.
const encodeIco = (pngs) => {
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs.map(({ png }) => png)]);
};

const universalPng = await renderIcon(1024);
const macPng = await sharp(await renderIcon(824))
  .extend({ top: 100, bottom: 100, left: 100, right: 100, background: "#00000000" })
  .png()
  .toBuffer();
const windowsIco = encodeIco(
  await Promise.all(
    [16, 24, 32, 48, 64, 128, 256].map(async (size) => ({ size, png: await renderIcon(size) })),
  ),
);
const publicIcons = new Map([["favicon.ico", windowsIco]]);
for (const [name, size] of [
  ["favicon-16x16.png", 16],
  ["favicon-32x32.png", 32],
  ["apple-touch-icon.png", 180],
  ["icon-192x192.png", 192],
  ["icon-512x512.png", 512],
]) {
  publicIcons.set(name, await renderIcon(size));
}

// The iOS PNGs belong to the mobile app, which keeps its own mark.
for (const [brand, linux, mac, windows] of [
  [
    "development",
    BRAND_ASSET_PATHS.developmentUniversalIconPng,
    BRAND_ASSET_PATHS.developmentDesktopIconPng,
    BRAND_ASSET_PATHS.developmentWindowsIconIco,
  ],
  [
    "nightly",
    BRAND_ASSET_PATHS.nightlyLinuxIconPng,
    BRAND_ASSET_PATHS.nightlyMacIconPng,
    BRAND_ASSET_PATHS.nightlyWindowsIconIco,
  ],
  [
    "production",
    BRAND_ASSET_PATHS.productionLinuxIconPng,
    BRAND_ASSET_PATHS.productionMacIconPng,
    BRAND_ASSET_PATHS.productionWindowsIconIco,
  ],
]) {
  for (const [file, bytes] of [
    [linux, universalPng],
    [mac, macPng],
    [windows, windowsIco],
  ]) {
    await NodeFSP.writeFile(NodePath.join(root, file), bytes);
  }
  for (const { sourceRelativePath, targetRelativePath } of resolveWebIconOverrides(
    brand,
    "apps/web/public",
  )) {
    const name = NodePath.basename(targetRelativePath);
    const bytes = publicIcons.get(name);
    if (!bytes) throw new Error(`No rendition for ${name}`);
    await NodeFSP.writeFile(NodePath.join(root, sourceRelativePath), bytes);
    if (brand === "development") {
      await NodeFSP.writeFile(NodePath.join(root, targetRelativePath), bytes);
    }
  }
}
