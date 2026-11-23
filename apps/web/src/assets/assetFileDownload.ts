/** Saves the file at an asset URL under the last segment of `path`; false when it could not be read. */
export async function downloadAssetFile(url: string, path: string): Promise<boolean> {
  const response = await fetch(url);
  if (!response.ok) return false;
  // Blob downloads keep desktop's custom app scheme from navigating to an external browser.
  const downloadUrl = URL.createObjectURL(await response.blob());
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = path.split(/[\\/]/).at(-1) || path;
  anchor.click();
  return true;
}
