# Shared Contracts

Shared constants, default values, normalization helpers, and example payloads.

Important objects:

- `GenerationPlan`
- `EditPlan`
- `LoraTrainingPlan`
- `ReferenceControlPlan`

Product-facing UI should map these technical plans into ordinary creative language. For example, LoRA becomes a reusable asset, ControlNet becomes reference control, and provider details stay in advanced mode unless the user needs to fix a connection.

This package intentionally uses plain JavaScript for easy portability across vibe coding platforms.
