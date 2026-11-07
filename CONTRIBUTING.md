# Contributing

## Environment

- Windows 10 or 11, the .NET SDK pinned by `global.json`, PowerShell 7;
- Node.js on the PATH for the extension's type check and tests (the locked development tools of `package-lock.json`
  are installed by `test.ps1` with `npm ci` when missing);
- Chrome with the unpacked `extension/` only for the checks on a real browser (`test.ps1 -Full`).

## Rules

1. Open an issue or a pull request against `main`. A change is accepted only when `test.ps1` passes: the CI
   (`.github/workflows/tests.yml`) runs that same script on every push and pull request.
2. **Every new feature and every bug fix comes with its test**: engine and bridge changes in
   `tests/NexusBrowser.Tests` (xUnit), extension changes in `tests/browser.test.cjs` (`node --test`). A fix starts
   with a test that fails without it.
3. A new tool keeps its contract in the engine and its safeguards: outward gestures (send, pay, publish...) stay behind
   the one-time confirmation token, and secrets stay masked in reads.
4. Never commit a secret, a token, a capture of a real page, a log or a build output: builds and test outputs go to
   `~\.nexus\build\nexus-browser`, outside the repository.
5. Comments, commit messages and `CHANGELOG.md` entries (Keep a Changelog, under `[Unreleased]`) are written in
   English.

## Checks

```powershell
pwsh -NoProfile -File test.ps1        # dotnet test (xUnit, real bridge on ephemeral ports), tsc, node --test; offline
pwsh -NoProfile -File test.ps1 -Full  # plus the bridge and the loaded extension on this PC (verify.ps1 -Browser)
git diff --check
```

## Version

One version everywhere: the `VERSION` file sets it; `native/BridgeSecurity.cs`, `server.json`, `mcpb/manifest.json`,
the plugin manifests and `gemini-extension.json` follow. `extension/manifest.json` has its own version, raised only when
the extension changes. The `Release` workflow (`.github/workflows/release.yml`) checks them, runs `test.ps1`, builds,
attests and publishes a development build on every push to `main`.
