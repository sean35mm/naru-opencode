---
title: OpenCode v2 installation
description: Normal native-v2 install and qualification boundary.
---

## Normal native-v2 installation

Normal Naru installation uses an existing OpenCode **exactly 2.0.15** on `PATH` and Node 24; it does not install a host binary or run a broker. Bootstrap installs only the `naru` command. From a built checkout, `sh install.sh` takes the same normal route:

```sh
sh install.sh --preview
sh install.sh --apply
naru doctor
naru configure             # interactive preview; rerun with --apply to save
naru models --list
naru models --set provider/model#variant --apply
```

The default config root is `~/.config/opencode`, or specify `--dir PATH` for an exact directory. The installer copies the compiled native package to `.naru-native/package`, keeps its selected models and managed ownership under `.naru-native/`, and updates `opencode.json` without setting a default parent model. Native workers are selected explicitly; the normal installer does not import the OC2 preview pool, move conversations, touch an installed preview profile, or enable paid provider access. Restart OpenCode after applying or changing models. `naru upgrade` downloads a release and previews this same normal installation; `naru doctor --json` checks local registration and integrity only, not live behavior or account entitlement.

Normal install currently refuses JSONC/ambiguous configuration and existing v1 commands, plugin, or manifest ownership. It does not remove historical assets or user data automatically. Resolve any collision through a separately reviewed cutover; do not delete v1 data or stop running services blindly. The installed user OC2 profile remains untouched until a deliberate checkpoint. For historical v1 installation and doctor use explicit `--legacy`; native uninstall/rollback are not available yet.

From built source, the normal packaged qualification is:

```sh
node .naru-build/scripts/naru-compat-smoke.mjs \
  --profile native-v2 --opencode /absolute/path/to/opencode-2.0.15 \
  --source .naru-build
```

The gate installs into a disposable private HOME/XDG and checks native routes against a synthetic local model source. It has not established cross-platform release qualification or real-account entitlement. Do not print config or credentials for troubleshooting.

## Development verification

The capability smoke requires the exact 2.0.15 native executable and a loopback-only
synthetic provider:

```sh
npm run build
node .naru-build/scripts/naru-native-capabilities-smoke.mjs \
  /absolute/path/to/opencode-2.0.15
```

It verifies package-directory loading, all four specialized tools, trusted per-session
Git cwd, parent and worker skill loading, and worker review denial before transport.
These describe source capabilities and verification targets, not release qualification
or real-account validation.
