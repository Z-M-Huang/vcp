# Repository Scripts

This directory contains maintenance scripts for the VCP monorepo.

Run `bun scripts/sync-vcp-lib-vendor.ts` after changing packages under `lib/`
that are consumed by published plugins. Run it with `--check` in CI to verify
the plugin-local vendor copies are current.
