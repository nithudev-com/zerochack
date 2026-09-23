import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { Ajv } from 'ajv';
import { AiProviderError, redactSecrets, type AiProviderAdapter, type ProviderCompletion, type ProviderInput } from './index.js';

/** SDK retries are disabled: the gateway owns retry policy. No server-side tools are enabled. */
export class AnthropicMessagesAdapter implements AiProviderAdapter {
  readonly key = 'anthropic-messages' as const;
  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}
  async complete(input: ProviderInput): Promise<ProviderCompletion> {
    const client = new Anthropic({ apiKey: input.credential, maxRetries: 0, timeout: 60000, fetch: this.fetchImplementation });
    const messages: MessageParam[] = [{ role: 'user', content: input.prompt }];
    const tools = input.tools ?? []; const ajv = new Ajv({ strict: false, allErrors: false });
    const validators = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.parameters)]));
    let inputTokens = 0; let outputTokens = 0; let executedTool = false; let toolCalls = 0;
    try {
      for (let turn = 0; turn < 6; turn += 1) {
        input.signal?.throwIfAborted();
        const stream = client.messages.stream({ model: input.model, max_tokens: input.maxOutputTokens, system: input.instructions, messages, ...(tools.length ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: { ...tool.parameters, type: 'object' as const } })) } : {}) }, { ...(input.signal ? { signal: input.signal } : {}) });
        // Deliberately buffer text until output screening finishes. Never publish partial secrets.
        const response = await stream.finalMessage();
        inputTokens += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0); outputTokens += response.usage.output_tokens;
        if (response.stop_reason === 'refusal') throw new AiProviderError('AI_PROVIDER_REFUSAL', 'Provider declined the request', false);
        if (response.stop_reason === 'max_tokens') throw new AiProviderError('AI_PROVIDER_OUTPUT_LIMIT', 'Provider output was incomplete', false);
        const calls = response.content.filter((part) => part.type === 'tool_use');
        if (!calls.length) {
          const text = redactSecrets(response.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim());
          if (!text || response.stop_reason !== 'end_turn') throw new AiProviderError('AI_PROVIDER_INVALID_RESPONSE', 'Provider did not finish a text response', false);
          return { text, inputTokens, outputTokens, providerRequestId: response.id };
        }
        toolCalls += calls.length;
        if (response.stop_reason !== 'tool_use' || calls.length > 8 || toolCalls > 24) throw new AiProviderError('AI_TOOL_LIMIT', 'Invalid tool turn', false);
        messages.push({ role: 'assistant', content: response.content });
        const results: ToolResultBlockParam[] = [];
        for (const call of calls) {
          input.signal?.throwIfAborted();
          const tool = tools.find((item) => item.name === call.name); const validate = validators.get(call.name);
          let output: unknown;
          if (!tool || !validate || !validate(call.input)) output = { ok: false, errorCode: 'TOOL_ARGUMENTS_INVALID' };
          else { executedTool = true; try { output = await tool.execute(call.input); } catch { output = { ok: false, errorCode: 'TOOL_EXECUTION_FAILED' }; } }
          const content = redactSecrets(JSON.stringify(output ?? null));
          results.push({ type: 'tool_result', tool_use_id: call.id, content: content.length <= 65536 ? content : '{"ok":false,"errorCode":"TOOL_OUTPUT_LIMIT"}' });
        }
        messages.push({ role: 'user', content: results });
      }
      throw new AiProviderError('AI_TOOL_LIMIT', 'Tool-turn limit reached', false);
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (input.signal?.aborted) throw new AiProviderError('AI_CANCELLED', 'Request stopped', false);
      const status = error instanceof Anthropic.APIError ? error.status : undefined;
      throw new AiProviderError(status === 429 ? 'AI_PROVIDER_RATE_LIMITED' : 'AI_PROVIDER_HTTP_ERROR', 'Claude request failed', !executedTool && Boolean(status && status >= 500), status);
    }
  }
}
