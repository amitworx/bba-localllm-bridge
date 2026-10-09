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
 global.fetch = async () => new Response(JSON.stringify({ done: true, message: { tool_calls: [{ function: { name: 'read_file', arguments: {} } }] } }));
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
 global.fetch = async () => new Response(JSON.stringify(provider === 'ollama' ? { done: true, message: { tool_calls: [call] } } : { choices: [{ done: true, message: { tool_calls: [call] } }] }));
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
 global.fetch = async () => new Response(JSON.stringify({ done: true, message: { content: 'PRIVATE_RESPONSE' } }));
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
 global.fetch = async () => new Response(JSON.stringify({ done: true, message: { tool_calls: [{ function: { name: 'read_file', arguments: { secret: 'PRIVATE_VALUE' } } }] } }));
 await assert.rejects(new t.LocalLlmChatProvider(line => logs.push(JSON.parse(line))).provideLanguageModelChatResponse(
 { id: 'ollama::qwen', capabilities: { toolCalling: true } }, [], { tools: [tool], toolMode: 2 }, { report() {} },
 { onCancellationRequested: () => ({ dispose() {} }) }));
 assert.deepEqual(logs.map(x => x.event), ['request', 'request-size', 'stream-progress', 'stream-finished', 'native-tool-call', 'validation-rejected', 'failed']);
 assert.ok(!JSON.stringify(logs).includes('PRIVATE_VALUE'));
 } finally { global.fetch = oldFetch; }
});
test('diagnostic filter is disabled by default and preserves selected schema', () => {
 const model = { capabilities: { toolCalling: true } };
 const tools = [tool, { name: 'send_to_terminal', inputSchema: { type: 'object' } }];
 assert.equal(t.getUsableTools(model, tools), tools);
 const selected = t.getUsableTools(model, tools, ['read_file']);
 assert.equal(selected.length, 1);
 assert.equal(selected[0], tool);
 assert.equal(t.convertTools(selected)[0].function.parameters, tool.inputSchema);
 assert.deepEqual(t.getUsableTools(model, undefined, ['read_file']), []);
 assert.deepEqual(t.getUsableTools({ capabilities: { toolCalling: false } }, tools, ['read_file']), []);
});
test('diagnostic filter sends only read_file and rejects a typo before HTTP', async () => {
 const oldFetch = global.fetch;
 const oldConfiguration = vscode.workspace.getConfiguration;
 let filter = ['read_file']; let body; let requests = 0;
 try {
 vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => key === 'diagnosticToolFilter' ? filter : fallback });
 global.fetch = async (_, options) => { requests++; body = JSON.parse(options.body); return new Response(JSON.stringify({ done: true, message: { content: 'test' } })); };
 const provider = new t.LocalLlmChatProvider();
 const model = { id: 'ollama::qwen', capabilities: { toolCalling: true } };
 const options = { tools: [tool, { name: 'send_to_terminal', description: 'terminal' }], toolMode: 1 };
 const token = { onCancellationRequested: () => ({ dispose() {} }) };
 await provider.provideLanguageModelChatResponse(model, [], options, { report() {} }, token);
 assert.deepEqual(body.tools.map(x => x.function.name), ['read_file']);
 assert.equal(body.stream, true); assert.equal(body.options.num_predict, 1024); assert.equal(body.options.num_ctx, 4096);
 assert.deepEqual(body.tools[0].function.parameters, tool.inputSchema);
 filter = ['readFile'];
 await assert.rejects(provider.provideLanguageModelChatResponse(model, [], options, { report() {} }, token), /matched no usable tools/);
 assert.equal(requests, 1);
 // Attached Ask has no tools; an enabled filter must leave it working.
 global.fetch = async (_, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ message: { content: 'BRIDGE-7429' } })+'\n'); };
 await provider.provideLanguageModelChatResponse(model, [{ role: 1, content: [new Text('Attached fixture')] }], { toolMode: 1 }, { report() {} }, token);
 assert.equal(body.tools, undefined); assert.equal(body.options.num_predict, undefined); assert.equal(body.messages[0].content, 'Attached fixture');
 } finally { global.fetch = oldFetch; vscode.workspace.getConfiguration = oldConfiguration; }
});
test('Ollama streaming handles split UTF-8 chunks and emits calls only after completion', async () => {
 const parts = []; const logs = [];
 const payload = JSON.stringify({ message: { thinking: 'PRIVATE_THINKING', content: 'héllo', tool_calls: [{ function: { name: 'read_file', arguments: { startLine: 1 } } }] } })+'\n'+JSON.stringify({ done: true })+'\n';
 const bytes = new TextEncoder().encode(payload);
 const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
 await t.readOllamaToolStream(response, { report: p => parts.push(p) }, (event, data) => logs.push({ event, ...data }));
 assert.equal(parts[0].value, 'héllo'); assert.ok(parts[1] instanceof Call);
 assert.ok(!JSON.stringify(logs).includes('PRIVATE_THINKING'));
});
test('truncated or token-limited Ollama streams never emit buffered tool calls', async () => {
 const chunk = { message: { tool_calls: [{ function: { name: 'read_file', arguments: { startLine: 1 } } }] } };
 for (const tail of ['', '\n'+JSON.stringify({ done: true, done_reason: 'length' })]) {
 const parts = [];
 await assert.rejects(t.readOllamaToolStream(new Response(JSON.stringify(chunk)+tail), { report: p => parts.push(p) }, () => {}));
 assert.equal(parts.length, 0);
 }
});
test('safe fetch diagnostics expose known cause codes without messages or secrets', () => {
 const error = new TypeError('PRIVATE_ENDPOINT'); error.cause = { code: 'UND_ERR_HEADERS_TIMEOUT', message: 'PRIVATE_SECRET' };
 assert.deepEqual(t.safeFailureDetails(error), { errorType: 'type-error', causeCode: 'UND_ERR_HEADERS_TIMEOUT' });
 error.cause.code = 'PRIVATE_SECRET'; assert.equal(t.safeFailureDetails(error).causeCode, undefined);
});
test('request size diagnostics expose counts, label estimates, and omit content', () => {
 const messages = [{ role: 'user', content: 'PRIVATE_内容' }];
 const data = t.requestSizeDiagnostic(messages, [{ description: 'PRIVATE_SCHEMA' }], 1);
 assert.ok(data.messageBytes > JSON.stringify(messages).length);
 assert.equal(data.estimateExceedsContext, true);
 assert.match(data.estimateMethod, /not a tokenizer/);
 assert.ok(!JSON.stringify(data).includes('PRIVATE_'));
});
test('oversized tool requests fail before HTTP; explicit guard override sends unchanged tools', async () => {
 const oldFetch = global.fetch; const oldConfiguration = vscode.workspace.getConfiguration;
 let guard = true; let requests = 0; let body; const logs = [];
 try {
 vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => key === 'ollama.guardToolContext' ? guard : fallback });
 global.fetch = async (_, options) => { requests++; body = JSON.parse(options.body); return new Response(JSON.stringify({ done: true, message: { content: 'ok' } })+'\n'); };
 const provider = new t.LocalLlmChatProvider(line => logs.push(JSON.parse(line)));
 const model = { id: 'ollama::qwen', capabilities: { toolCalling: true } };
 const messages = [{ role: 1, content: [new Text('PRIVATE_CONTENT'.repeat(2000))] }];
 const options = { tools: [tool], toolMode: 1 };
 const token = { onCancellationRequested: () => ({ dispose() {} }) };
 await assert.rejects(provider.provideLanguageModelChatResponse(model, messages, options, { report() {} }, token), /rough estimate/);
 assert.equal(requests, 0); assert.ok(logs.some(x => x.event === 'context-budget-rejected'));
 assert.ok(!JSON.stringify(logs).includes('PRIVATE_CONTENT'));
 guard = false;
 await provider.provideLanguageModelChatResponse(model, messages, options, { report() {} }, token);
 assert.equal(requests, 1); assert.equal(body.tools[0].function.name, 'read_file');
 guard = true;
 await provider.provideLanguageModelChatResponse(model, messages, { toolMode: 1 }, { report() {} }, token);
 assert.equal(requests, 2); assert.equal(body.tools, undefined);
 } finally { global.fetch = oldFetch; vscode.workspace.getConfiguration = oldConfiguration; }
});
