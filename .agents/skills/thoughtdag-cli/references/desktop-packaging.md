# ThoughtDAG desktop packaging scenarios

Use the cross-platform entrypoint from the repository root:

```bash
npm run desktop:package -- [options]
```

It performs, unless skipped:

1. root `npm run build`;
2. desktop payload assembly and production dependency installation;
3. platform packaging with `electron-builder --publish never`;
4. an `afterPack` assertion that the packaged runtime includes the server, web build, CLI, shared CLI catalog/control plane, and Express runtime.

The script never uploads or publishes artifacts. GitHub release upload remains the responsibility of the release workflow.

## Host and architecture rules

- Run macOS packaging on macOS, Windows packaging on Windows, and Linux packaging on Linux.
- `--allow-cross` only removes the script's guard; it does not install Wine, system packaging tools, code-signing tools, or platform SDKs.
- `--dry-run` may describe another platform without `--allow-cross` and performs no installs, builds, cleanup, or packaging.
- Supported architectures are `x64`, `arm64`, and macOS-only `universal`.
- `--arch all` means separate `arm64` and `x64` builds. It is not the same as one macOS universal binary.
- `--arch current` is the default and uses the host Node architecture.

## Fresh checkout

Install both root and desktop dependencies, build, assemble the payload, and create an unsigned installer for the current platform/architecture:

```bash
npm run desktop:package -- --install --sign never
```

`--install` runs `npm ci` in both package roots. Omit it when both dependency trees already match their lockfiles.

## Fast unpacked build for local testing

Build an unpacked application directory instead of an installer:

```bash
npm run desktop:package:dir
```

Equivalent explicit form:

```bash
npm run desktop:package -- --mode dir --sign never
```

The result appears below `desktop/out/` in the platform's unpacked directory. `afterPack` still restores server dependencies and verifies the bundled CLI.

## Current-platform unsigned installer

```bash
npm run desktop:package -- --sign never
```

`--sign never` sets `CSC_IDENTITY_AUTO_DISCOVERY=false`, removes explicit macOS/Windows certificate variables from the builder subprocess, and on macOS also overrides notarization to false. Use this for local QA artifacts that will not be distributed as trusted releases.

## Reuse existing intermediate output

When `dist/index.html` is already current:

```bash
npm run desktop:package -- --skip-build
```

When both `dist/` and `desktop/payload/` are intentionally current:

```bash
npm run desktop:package -- --skip-build --skip-payload
```

The script rejects missing reused directories. Do not use these flags for a release unless those inputs were produced earlier in the same clean job.

## Clean output before packaging

```bash
npm run desktop:package -- --clean
```

`--clean` recursively removes only `desktop/out/` immediately before running the builder. It does not remove source, dependencies, `dist/`, or `desktop/payload/`.

## macOS

Unsigned local packages:

```bash
# Apple Silicon
npm run desktop:package -- --platform mac --arch arm64 --sign never

# Intel
npm run desktop:package -- --platform mac --arch x64 --sign never

# Separate Apple Silicon and Intel DMG/ZIP artifacts
npm run desktop:package -- --platform mac --arch all --sign never

# One universal application
npm run desktop:package -- --platform mac --arch universal --sign never
```

Default macOS targets are `dmg,zip`. A PKG can be selected explicitly:

```bash
npm run desktop:package -- --platform mac --arch arm64 --targets pkg --sign never
```

Signed and notarized release:

```bash
npm run desktop:package -- --platform mac --arch all --sign required --clean
```

`--sign required` refuses to start unless a signing identity and a complete notarization credential method are present.

Signing identity, choose one:

- `CSC_LINK` plus, when needed, `CSC_KEY_PASSWORD`;
- `CSC_NAME` for an identity already installed in the macOS keychain.

Notarization, choose exactly one complete method:

- Apple ID: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`;
- App Store Connect API: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`;
- stored notarytool credentials: `APPLE_KEYCHAIN_PROFILE`, optionally `APPLE_KEYCHAIN`.

`--sign auto` is the default. It lets `electron-builder` use available credentials and skip unavailable signing/notarization. Use `required` for a release that must never silently become unsigned.

## Windows

Native Windows commands:

```powershell
# x64 NSIS installer
npm run desktop:package -- --platform win --arch x64 --sign never

# Windows on ARM NSIS installer
npm run desktop:package -- --platform win --arch arm64 --sign never

# Portable executable and NSIS installer
npm run desktop:package -- --platform win --arch x64 --targets nsis,portable --sign never
```

Supported Windows targets are `nsis`, `portable`, and `zip`.

For a signed build, provide `WIN_CSC_LINK` or `CSC_LINK`; the corresponding password may be supplied as `WIN_CSC_KEY_PASSWORD` or `CSC_KEY_PASSWORD`, then run:

```powershell
npm run desktop:package -- --platform win --arch x64 --sign required --clean
```

The current public workflow intentionally permits unsigned Windows builds. Use `required` only after Windows signing credentials have been configured.

## Linux

Native Linux commands:

```bash
# x64 AppImage
npm run desktop:package -- --platform linux --arch x64 --sign never

# ARM64 AppImage
npm run desktop:package -- --platform linux --arch arm64 --sign never

# Multiple Linux formats
npm run desktop:package -- --platform linux --arch x64 --targets AppImage,deb,rpm,tar.gz
```

Supported Linux targets are `AppImage`, `deb`, `rpm`, `tar.gz`, and `zip`. The host runner must provide the system tools required by the chosen format. This repository does not define a Linux artifact-signing contract, so `--sign required` is rejected for Linux; use `auto` or `never`.

## Version selection

The default version comes from `desktop/package.json`. Override it without editing that file:

```bash
npm run desktop:package -- --version 0.3.32
```

Accepted values are semantic versions, optionally prefixed with `v`. Resolution order is:

1. `--version`;
2. `THOUGHTDAG_DESKTOP_VERSION`;
3. a GitHub Actions tag from `GITHUB_REF_NAME` when `GITHUB_REF_TYPE=tag`;
4. `desktop/package.json`.

The override is passed as `electron-builder` extra package metadata, so artifact naming and the packaged application's version use the same value.

## CI and releases

The repository workflow uses native runners:

- macOS: `npm run dist:mac -- --skip-build` -> arm64 and x64 DMG/ZIP;
- Windows: `npm run dist:win -- --skip-build` -> x64 NSIS;
- Linux: `npm run dist:linux -- --skip-build` -> x64 AppImage.

The workflow builds the root web app first, so `--skip-build` avoids duplicate compilation while payload assembly still runs. Tag names such as `v0.3.32` are inferred as the packaged version. Each platform uploads into a draft release; the release is published only after all platform jobs succeed.

For a CI release that must require macOS signing, change only the macOS invocation to include `--sign required` after configuring the signing and notarization secrets. Do not pass secret values as command-line arguments or print them in diagnostics.

## Dry-run and option diagnostics

Show the exact build plan and builder arguments without changing files:

```bash
npm run desktop:package -- --platform mac --arch all --sign never --version 0.3.32 --dry-run
```

Useful failures:

| Message | Resolution |
| --- | --- |
| `building <platform> on <host> is disabled` | Use a native runner, or explicitly install cross-build tooling and pass `--allow-cross`. |
| `universal architecture is supported only for macOS` | Use `x64`, `arm64`, or `all` on Windows/Linux. |
| `unsupported <platform> target` | Select a target from the platform lists above. |
| `invalid semantic version` | Use a valid `major.minor.patch` value with optional prerelease/build suffix. |
| `--skip-build requested but dist/index.html is missing` | Remove `--skip-build` or run the root build. |
| `--skip-payload requested but desktop/payload/server.mjs is missing` | Remove `--skip-payload` or run payload assembly. |
| `electron-builder is not installed` | Add `--install` or run `npm ci` under `desktop/`. |
| signing/notarization variable error | Supply the named complete credential set, use `auto`, or intentionally choose `never`. |
| `afterPack: packaged runtime is incomplete` | The package would not support its server/CLI. Restore the named missing payload file; do not publish the artifact. |

## Packaged CLI invariant

Every successful packaged application is checked for:

- `payload/server.mjs`
- `payload/scripts/thoughtdag-cli.mjs`
- `payload/shared/cli-commands.mjs`
- `payload/shared/cli-control-plane.mjs`
- `payload/dist/index.html`
- `payload/node_modules/express/package.json`

The payload preparation also rejects the first five `.node` native binaries it finds. This keeps optional unsigned native dependencies out of the resources bundle and makes the same check work on Windows, macOS, and Linux without relying on Unix `find` or `head` commands.
