# 289: the file preview's drag selection tests run again

- `apps/web/src/components/files/FilePreviewPanel.browser.test.tsx`: the three "source file scroll" drag cases scroll the held drag themselves instead of waiting up to 1 s for Chrome's edge auto-scroll, which stalls on a loaded CI runner, and their quarantine skip is removed; each case still checks the anchor row's mount across the window shift, the selection overlay and the copied text.
