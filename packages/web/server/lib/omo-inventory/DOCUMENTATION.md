# OMO Inventory Module Documentation

## Purpose
This module provides a portable, data-only inventory of the Oh-My-OpenCode (OA) behavioral kernel. It classifies OA kernel files and patterns into three categories that OpenChamber can consume without depending on an OA checkout:
- `portable`: specification/behavioral assets that can be transplanted without native OpenCode adapters.
- `needs-native-adapter`: behavior that is conceptually portable but coupled to OpenCode runtime, tools, or UI glue.
- `drop`: non-portable glue and integration surfaces that must not be treated as portable kernel.

The inventory is intentionally static and based on a curated OA scan so downstream tasks can reuse the same classification.

## Entrypoints and structure
- `packages/web/server/lib/omo-inventory/index.js`: public data exports for kernel category lists and vertical slice identifiers.
- `packages/web/server/lib/omo-inventory/OMO_KERNEL_MAP.md`: human-readable mapping table and vertical slice description.
- `packages/web/server/lib/omo-inventory/omo-inventory.test.js`: Bun unit tests that enforce classification invariants and guard against accidental drift.

## Data exports
- `PORTABLE`: readonly list of OA paths/patterns that are considered portable kernel specifications or behavior.
- `NEEDS_NATIVE_ADAPTER`: readonly list of OA paths/patterns that require an OpenCode-native adapter to use safely.
- `DROP`: readonly list of OA paths/patterns that are explicitly non-portable glue.
- `VERTICAL_SLICE_ENTRYPOINTS`: readonly object describing the minimal plan → start-work → boulder → atlas → task → continuation → idle-hook vertical slice using OA entrypoint identifiers.

All paths are stored as opaque strings prefixed with `[OA]/` and are not resolved at runtime. The module does not reach into the OA filesystem.

## Usage
- Import the lists from `index.js` to drive future transplant tasks, documentation generators, or runtime contract validation.
- Prefer treating these exports as canonical classification data instead of re-scanning OA.

The module is contract-only and does not introduce any new runtime behavior in OpenChamber.
