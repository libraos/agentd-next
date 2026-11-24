# LibraOS Core's public repository is libraos/libraos-core (libraos/core#1038)

The public repository of LibraOS Core's binaries, installers and dash was renamed from `libraos/cli` to `libraos/libraos-core` (dec-e62e978875; before `libraos/cli` it was `libraos/agentd`). GitHub redirects both old names; nothing here relies on that. The private source `libraos/core` and this app's `libraos/next` are unchanged. `1038-repo-rename.md` records the earlier rename and keeps the names of that time.

Upstream files changed:

- `.github/workflows/release.yml`: the bundled Core release is looked up in `libraos/libraos-core`.
- `README.md`, `docs/user/{faq,workers}.md`: LibraOS Core links point at `libraos/libraos-core`.
- `scripts/build-desktop-artifact.ts`: the `gh release download -R libraos/libraos-core` hint.
