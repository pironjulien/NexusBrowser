# Development instructions

## Pitfalls

- In tests, build every sensitive path (user profile, `.claude\settings.json`…) only from the test profile
  (`BridgeSecurity.HomeDir()` / `TestEnvironment.Home`) and check it lies under the temporary folder first; never
  `SpecialFolder.UserProfile` or a hard-coded real path. A guard test that fails writes exactly where it must not: one
  such test overwrote a real `settings.json`.
- A `browser_eval` cut by its timeout keeps running: never resend blindly after an "outcome unknown" result, read the
  page state first.
- `browser_upload` must hand Chrome the real file path and check the size in the page: a path seen only inside a
  packaged (MSIX) app's virtualized AppData reaches Chrome as an empty 0-byte file without error.
