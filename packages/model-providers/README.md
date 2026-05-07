# Model Providers

This package isolates assistant-model calls used by MuseForge prompt and planning workflows.

Supported scaffold providers:

- `openai`
- `openai-compatible`
- `local`
- `anthropic`
- `mock`

Planned provider roles:

- `assistant`: GPT, Gemini, local models, Claude-like APIs, or OpenAI-compatible models used for planning, prompt writing, caption cleanup, and evaluation.
- `engine`: local A1111 / Aki, Jimeng-like image/video APIs, OpenAI image/video APIs, Gemini image/video capabilities, or custom platform adapters used for actual creative generation.

The current provider layer returns normalized shared objects such as `GenerationPlan`. MuseForge currently uses it for lightweight tag planning rather than a default multi-step tool-calling Agent.

No model weights or API keys are stored here.
