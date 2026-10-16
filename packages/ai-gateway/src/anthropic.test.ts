import { describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesAdapter } from './index.js';
function response(text = 'Safe answer') {
  const start = { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], model: 'configured-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } };
  const events = [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }, { type: 'message_stop' }];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function toolResponse(argumentsJson: string, count = 1) {
  const events: unknown[] = [{ type: 'message_start', message: { id: 'tool_test', type: 'message', role: 'assistant', content: [], model: 'configured-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } }];
  for (let index = 0; index < count; index += 1) events.push(
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call_${index}`, name: 'read_record', input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: argumentsJson.slice(0, 5) } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: argumentsJson.slice(5) } },
    { type: 'content_block_stop', index }
  );
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }, { type: 'message_stop' });
  return new Response(events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const input = { credential: 'synthetic-server-key', model: 'configured-model', maxOutputTokens: 128, instructions: 'Trusted instructions', prompt: 'Question', requestId: 'r' };
describe('Anthropic Messages adapter', () => {
  it('uses the official server endpoint and accounts for the completed stream', async () => {
    let url = ''; let body: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (target, init) => { url = String(target); body = JSON.parse(String(init?.body)); return response(); };
    const result = await new AnthropicMessagesAdapter(fetcher).complete(input);
    expect(url).toBe('https://api.anthropic.com/v1/messages'); expect(body).toMatchObject({ model: 'configured-model', stream: true, max_tokens: 128 });
    expect(JSON.stringify(body)).not.toContain(input.credential); expect(result).toMatchObject({ text: 'Safe answer', inputTokens: 7, outputTokens: 3 });
  });
  it('redacts structured secrets before returning a completion', async () => {
    const result = await new AnthropicMessagesAdapter(async () => response('password=synthetic-secret')).complete(input);
    expect(result.text).not.toContain('synthetic-secret');
  });
  it('does not retry inside the SDK after a rate limit or cancellation', async () => {
    const fetcher = vi.fn(async () => new Response('{"error":{"type":"rate_limit_error","message":"busy"}}', { status: 429 }));
    await expect(new AnthropicMessagesAdapter(fetcher).complete(input)).rejects.toMatchObject({ code: 'AI_PROVIDER_RATE_LIMITED', retryable: false }); expect(fetcher).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort();
    await expect(new AnthropicMessagesAdapter(fetcher).complete({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: 'AI_CANCELLED' });
  });
  it('validates assembled tool arguments before execution', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const tool = { name: 'read_record', description: 'Read a scoped record', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, execute };
    let calls = 0; let followup = '';
    const fetcher: typeof fetch = async (_url, init) => { calls += 1; if (calls === 1) return toolResponse('{"id":42}'); followup = String(init?.body); return response(); };
    await new AnthropicMessagesAdapter(fetcher).complete({ ...input, tools: [tool] });
    expect(execute).not.toHaveBeenCalled(); expect(followup).toContain('TOOL_ARGUMENTS_INVALID');
  });
  it('does not replay an executed tool when the following provider request fails', async () => {
    const execute = vi.fn(async () => ({ ok: true })); let calls = 0;
    const fetcher: typeof fetch = async () => ++calls === 1 ? toolResponse('{"id":"record"}') : new Response('{"error":{"type":"api_error","message":"unavailable"}}', { status: 503 });
    await expect(new AnthropicMessagesAdapter(fetcher).complete({ ...input, tools: [{ name: 'read_record', description: 'Read', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, execute }] })).rejects.toMatchObject({ retryable: false });
    expect(execute).toHaveBeenCalledExactlyOnceWith({ id: 'record' }); expect(calls).toBe(2);
  });
  it('rejects an oversized batch before executing any tools', async () => {
    const execute = vi.fn();
    await expect(new AnthropicMessagesAdapter(async () => toolResponse('{}', 9)).complete({ ...input, tools: [{ name: 'read_record', description: 'Read', parameters: { type: 'object' }, execute }] })).rejects.toMatchObject({ code: 'AI_TOOL_LIMIT' });
    expect(execute).not.toHaveBeenCalled();
  });

});
