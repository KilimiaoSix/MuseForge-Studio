# Model Providers

This package isolates all LLM provider calls.

Supported scaffold providers:

- `openai`
- `openai-compatible`
- `local`
- `anthropic`
- `mock`

The provider layer returns normalized shared objects such as `GenerationPlan`.

No model weights or API keys are stored here.

