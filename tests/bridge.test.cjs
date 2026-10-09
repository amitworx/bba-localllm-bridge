const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
const vscode = { LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
 LanguageModelChatMessageRole: { User: 1, Assistant: 2 }, LanguageModelChatToolMode: { Required: 2 },
 workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback }) } };
const original = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
const { testing: t } = require('../out/extension.js');
Module._load = original;
const tool = { name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: { startLine: { type: 'number' } }, required: ['startLine'] } };
test('startLine schema reaches backend unchanged; missing argument is rejected', () => {
 assert.deepEqual(t.convertTools([tool])[0].function.parameters, tool.inputSchema);
 assert.throws(() => t.validateToolCall('read_file', {}, [tool]), /startLine/);
 t.validateToolCall('read_file', { startLine: 1 }, [tool]);
});
test('malformed, null and array arguments cannot become executable calls', () => {
 for (const input of ['{', 'null', '[]', undefined]) assert.throws(() => t.normalizeToolArguments(input));
 assert.deepEqual(t.normalizeToolArguments('{"startLine":1}'), { startLine: 1 });
 assert.throws(() => t.validateToolCall('invented', {}, [tool]), /unrequested/);
});
test('visibility and allowlist never establish tool support', () => {
 for (const visibilityMode of ['balanced', 'strict', 'all-chat-models']) {
 assert.equal(t.evaluateToolCalling({ modelId: 'qwen', allowlist: ['qwen'], visibilityMode }).supported, false);
 }
 assert.equal(t.evaluateToolCalling({ modelId: 'qwen', metadataCapabilities: ['tools'] }).supported, true);
});
test('provider-specific tool history retains correlation and encoding', () => {
 const messages = [{ role: 2, content: [new Call('call-1', 'read_file', { startLine: 1 })] },
 { role: 1, content: [new Result('call-1', [new Text('file contents')])] }];
 const lm = t.convertMessages(messages, 'lmstudio');
 assert.equal(lm[0].tool_calls[0].function.arguments, '{"startLine":1}');
 assert.equal(lm[1].tool_call_id, 'call-1');
 const ollama = t.convertMessages(messages, 'ollama');
 assert.deepEqual(ollama[0].tool_calls[0].function.arguments, { startLine: 1 });
 assert.equal(ollama[1].tool_name, 'read_file');
});
test('Ask attached text and plain JSON remain text on Ollama and LM Studio', async () => {
 const oldFetch = global.fetch;
 try {
 for (const provider of ['ollama', 'lmstudio']) {
 let body; const parts = [];
 global.fetch = async (_, options) => {
 body = JSON.parse(options.body);
 const content = '{"name":"read_file"}';
 return new Response(provider === 'ollama' ? JSON.stringify({ message: { content } })+'\n' : 'data: '+JSON.stringify({ choices: [{ delta: { content } }] })+'\n\ndata: [DONE]\n\n');
 };
 await new t.LocalLlmChatProvider().provideLanguageModelChatResponse({ id: provider+'::qwen', capabilities: { toolCalling: false } },
 [{ role: 1, content: [new Text('Attached ROADMAP.md: M0 setup')] }], { toolMode: 1 }, { report: p => parts.push(p) },
 { onCancellationRequested: () => ({ dispose() {} }) });
 assert.equal(body.messages[0].content, 'Attached ROADMAP.md: M0 setup');
 assert.equal(body.tools, undefined);
 assert.equal(parts[0].value, '{"name":"read_file"}');
 }
 } finally { global.fetch = oldFetch; }
});
test('Agent invalid call fails before VS Code receives executable part', async () => {
 const oldFetch = global.fetch; const parts = [];
 try {
 global.fetch = async () => new Response(JSON.stringify({ message: { tool_calls: [{ function: { name: 'read_file', arguments: {} } }] } }));
 await assert.rejects(new t.LocalLlmChatProvider().provideLanguageModelChatResponse({ id: 'ollama::qwen', capabilities: { toolCalling: true } }, [],
 { tools: [tool], toolMode: 2 }, { report: p => parts.push(p) }, { onCancellationRequested: () => ({ dispose() {} }) }), /startLine/);
 assert.equal(parts.length, 0);
 } finally { global.fetch = oldFetch; }
});
test('schema types are validated without coercion or defaults', () => {
 assert.throws(() => t.validateToolCall('read_file', { startLine: '1' }, [tool]), /number/);
});
test('native valid tool calls reach VS Code on both backends', async () => {
 const oldFetch = global.fetch;
 try {
 for (const provider of ['ollama', 'lmstudio']) {
 const parts = [];
 const call = { id: 'native-1', type: 'function', function: { name: 'read_file', arguments: provider === 'ollama' ? { startLine: 1 } : '{"startLine":1}' } };
 global.fetch = async () => new Response(JSON.stringify(provider === 'ollama' ? { message: { tool_calls: [call] } } : { choices: [{ message: { tool_calls: [call] } }] }));
 await new t.LocalLlmChatProvider().provideLanguageModelChatResponse({ id: provider+'::qwen', capabilities: { toolCalling: true } }, [],
 { tools: [tool], toolMode: 2 }, { report: p => parts.push(p) }, { onCancellationRequested: () => ({ dispose() {} }) });
 assert.equal(parts.length, 1); assert.ok(parts[0] instanceof Call); assert.deepEqual(parts[0].input, { startLine: 1 });
 if (provider === 'lmstudio') assert.equal(parts[0].callId, 'native-1');
 }
 } finally { global.fetch = oldFetch; }
});
test('diagnostics distinguish text-only tool request and omit private content', async () => {
 const oldFetch = global.fetch; const logs = [];
 try {
 global.fetch = async () => new Response(JSON.stringify({ message: { content: 'PRIVATE_RESPONSE' } }));
 await new t.LocalLlmChatProvider(line => logs.push(JSON.parse(line))).provideLanguageModelChatResponse(
 { id: 'ollama::qwen3:8b', capabilities: { toolCalling: true } },
 [{ role: 1, content: [new Text('PRIVATE_PROMPT')] }], { tools: [tool], toolMode: 1 }, { report() {} },
 { onCancellationRequested: () => ({ dispose() {} }) });
 assert.equal(logs[0].sentToolCount, 1);
 assert.deepEqual(logs[0].sentTools, [{ name: 'read_file', required: ['startLine'] }]);
 assert.equal(logs.at(-1).structuredCalls, 0);
 assert.equal(logs.at(-1).textCharacters, 16);
 assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
 } finally { global.fetch = oldFetch; }
});
test('diagnostics identify rejected native call without leaking argument values', async () => {
 const oldFetch = global.fetch; const logs = [];
 try {
 global.fetch = async () => new Response(JSON.stringify({ message: { tool_calls: [{ function: { name: 'read_file', arguments: { secret: 'PRIVATE_VALUE' } } }] } }));
 await assert.rejects(new t.LocalLlmChatProvider(line => logs.push(JSON.parse(line))).provideLanguageModelChatResponse(
 { id: 'ollama::qwen', capabilities: { toolCalling: true } }, [], { tools: [tool], toolMode: 2 }, { report() {} },
 { onCancellationRequested: () => ({ dispose() {} }) }));
 assert.deepEqual(logs.map(x => x.event), ['request', 'native-tool-call', 'validation-rejected', 'failed']);
 assert.ok(!JSON.stringify(logs).includes('PRIVATE_VALUE'));
 } finally { global.fetch = oldFetch; }
});
