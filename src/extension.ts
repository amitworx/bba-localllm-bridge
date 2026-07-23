import * as vscode from 'vscode';

const PROVIDER_ID = 'bba-local-llm-bridge';
const CONFIG_SECTION = 'bbaLocalLlmBridge';
const CACHE_TTL_MS = 30_000;

type ProviderName = 'ollama' | 'lmstudio';
type ChatModelVisibilityMode = 'balanced' | 'strict' | 'all-chat-models';

interface ProviderConfig {
  defaultProvider: ProviderName;
  requestTimeoutMs: number;
  chatModelVisibility: ChatModelVisibilityMode;
  ollama: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
    toolCallingModels: string[];
  };
  lmStudio: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    models: string[];
    toolCallingModels: string[];
  };
}

interface BackendConfig {
  provider: ProviderName;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
}

interface ModelSupportDiagnostic {
  id: string;
  provider: ProviderName;
  name: string;
  toolCalling: boolean;
  reason: string;
}

interface FetchOptions {
  method: string;
  timeoutMs: number;
  token: vscode.CancellationToken;
  headers?: Record<string, string>;
  body?: string;
}

class HttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly responseText: string;

  constructor(url: string, status: number, statusText: string, responseText: string) {
    const detail = responseText ? `: ${responseText}` : '';
    super(`${url} returned ${status} ${statusText}${detail}`);
    this.name = 'HttpError';
    this.status = status;
    this.statusText = statusText;
    this.responseText = responseText;
  }
}

interface OllamaTagResponse {
  models?: Array<{
    name: string;
    modified_at?: string;
    digest?: string;
    details?: {
      family?: string;
      families?: string[];
    };
  }>;
}

interface LmStudioModelsResponse {
  data?: Array<{
    id: string;
    created?: string | number;
    capabilities?: string[];
  }>;
}

interface ProviderChatMessage {
  role: string;
  content?: string;
  tool_calls?: ProviderToolCall[];
  tool_name?: string;
}

interface ProviderToolCall {
  id?: string;
  type: 'function';
  function: {
    name: string;
    arguments: object | string;
  };
}

interface OpenAiToolDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAiTool {
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new LocalLlmChatProvider();

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(PROVIDER_ID, provider),
    vscode.commands.registerCommand('bbaLocalLlmBridge.manageProvider', () => manageProvider()),
    vscode.commands.registerCommand('bbaLocalLlmBridge.refreshModels', async () => {
      provider.clearCache();
      await vscode.window.showInformationMessage(
        'BBA LocalLLM Bridge model cache cleared. Open the model picker again to rediscover models.'
      );
    }),
    vscode.commands.registerCommand('bbaLocalLlmBridge.inspectToolSupport', async () => {
      await inspectToolSupport(provider);
    }),
    vscode.commands.registerCommand('bbaLocalLlmBridge.configureChatVisibility', async () => {
      await configureChatVisibility(provider);
    })
  );
}

export function deactivate(): void {}

class LocalLlmChatProvider implements vscode.LanguageModelChatProvider {
  private modelCache: vscode.LanguageModelChatInformation[] | undefined;
  private cacheTime = 0;

  clearCache(): void {
    this.modelCache = undefined;
    this.cacheTime = 0;
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const config = getConfig();
    const now = Date.now();

    if (this.modelCache && now - this.cacheTime < CACHE_TTL_MS) {
      return this.modelCache;
    }

    const tasks: Promise<vscode.LanguageModelChatInformation[]>[] = [];
    if (config.ollama.enabled) {
      tasks.push(discoverOllamaModels(config, token));
    }
    if (config.lmStudio.enabled) {
      tasks.push(discoverLmStudioModels(config, token));
    }

    if (tasks.length === 0) {
      if (!options.silent) {
        void vscode.window.showWarningMessage(
          'BBA LocalLLM Bridge is enabled, but both Ollama and LM Studio are turned off in settings.'
        );
      }
      return [];
    }

    const results = await Promise.allSettled(tasks);
    const models: vscode.LanguageModelChatInformation[] = [];
    const errors: string[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        models.push(...result.value);
      } else {
        errors.push(String(result.reason instanceof Error ? result.reason.message : result.reason));
      }
    }

    if (!models.length && !options.silent && errors.length) {
      void vscode.window.showWarningMessage(
        `BBA LocalLLM Bridge could not discover any models. ${errors.join(' | ')}`
      );
    }

    this.modelCache = models;
    this.cacheTime = now;
    return models;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const backend = getBackendForModel(model);
    const tools = getUsableTools(model, options.tools);
    if (backend.provider === 'ollama') {
      await streamOllamaChat(backend, messages, options, tools, progress, token);
      return;
    }

    await streamLmStudioChat(backend, messages, options, tools, progress, token);
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    void _token;
    const serialized = typeof text === 'string' ? text : JSON.stringify(text);
    return Math.max(1, Math.ceil(serialized.length / 4));
  }
}

async function manageProvider(): Promise<void> {
  const config = getConfig();
  const action = await vscode.window.showQuickPick(
    [
      {
        label: 'Open Settings',
        detail: 'Edit BBA LocalLLM Bridge endpoints and model allowlists.'
      },
      {
        label: `Set preferred provider (${config.defaultProvider})`,
        detail: 'Choose which provider to present first in this extension.'
      },
      {
        label: 'Refresh discovered models',
        detail: 'Clear the cached model list and rediscover on next use.'
      },
      {
        label: 'Inspect tool support',
        detail: 'See which discovered models are considered tool-capable and why.'
      },
      {
        label: 'Configure chat visibility',
        detail: 'Choose whether local models should appear in Chat more aggressively or more strictly.'
      }
    ],
    { placeHolder: 'Manage BBA LocalLLM Bridge' }
  );

  if (!action) {
    return;
  }

  if (action.label === 'Open Settings') {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      '@ext:local.bba-localllm-bridge bbaLocalLlmBridge'
    );
    return;
  }

  if (action.label === 'Refresh discovered models') {
    await vscode.commands.executeCommand('bbaLocalLlmBridge.refreshModels');
    return;
  }

  if (action.label === 'Inspect tool support') {
    await vscode.commands.executeCommand('bbaLocalLlmBridge.inspectToolSupport');
    return;
  }

  if (action.label === 'Configure chat visibility') {
    await vscode.commands.executeCommand('bbaLocalLlmBridge.configureChatVisibility');
    return;
  }

  const nextProvider = await vscode.window.showQuickPick(
    [
      { label: 'ollama', detail: 'Use Ollama as the primary local provider.' },
      { label: 'lmstudio', detail: 'Use LM Studio as the primary local provider.' }
    ],
    { placeHolder: 'Select the preferred provider' }
  );

  if (!nextProvider) {
    return;
  }

  await vscode.workspace
    .getConfiguration()
    .update(`${CONFIG_SECTION}.defaultProvider`, nextProvider.label, vscode.ConfigurationTarget.Global);

  await vscode.window.showInformationMessage(
    `BBA LocalLLM Bridge preferred provider set to ${nextProvider.label}.`
  );
}

function getConfig(): ProviderConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    defaultProvider: config.get<ProviderName>('defaultProvider', 'ollama'),
    requestTimeoutMs: config.get<number>('requestTimeoutMs', 120000),
    chatModelVisibility: config.get<ChatModelVisibilityMode>('chatModelVisibility', 'balanced'),
    ollama: {
      enabled: config.get<boolean>('ollama.enabled', true),
      baseUrl: config.get<string>('ollama.baseUrl', 'http://127.0.0.1:11434'),
      models: config.get<string[]>('ollama.models', []),
      toolCallingModels: config.get<string[]>('ollama.toolCallingModels', [])
    },
    lmStudio: {
      enabled: config.get<boolean>('lmStudio.enabled', true),
      baseUrl: config.get<string>('lmStudio.baseUrl', 'http://127.0.0.1:1234'),
      apiKey: config.get<string>('lmStudio.apiKey', 'lm-studio'),
      models: config.get<string[]>('lmStudio.models', []),
      toolCallingModels: config.get<string[]>('lmStudio.toolCallingModels', [])
    }
  };
}

function getBackendForModel(model: vscode.LanguageModelChatInformation): BackendConfig {
  const config = getConfig();
  const [provider, ...rest] = model.id.split('::');
  const modelId = rest.join('::');

  if (provider === 'ollama') {
    return {
      provider,
      modelId,
      baseUrl: trimTrailingSlash(config.ollama.baseUrl)
    };
  }

  return {
    provider: 'lmstudio',
    modelId,
    baseUrl: trimTrailingSlash(config.lmStudio.baseUrl),
    apiKey: config.lmStudio.apiKey
  };
}

async function discoverOllamaModels(
  config: ProviderConfig,
  token: vscode.CancellationToken
): Promise<vscode.LanguageModelChatInformation[]> {
  const url = `${trimTrailingSlash(config.ollama.baseUrl)}/api/tags`;
  const response = await fetchJson<OllamaTagResponse>(url, {
    method: 'GET',
    timeoutMs: config.requestTimeoutMs,
    token
  });

  const configured = normalizeAllowlist(config.ollama.models);
  const models = Array.isArray(response.models) ? response.models : [];

  return models
    .filter((entry) => !configured.size || configured.has(entry.name))
    .map((entry) => {
      const toolSupport = evaluateToolCalling({
        provider: 'ollama',
        modelId: entry.name,
        allowlist: config.ollama.toolCallingModels,
        metadataCapabilities: entry.details?.families || (entry.details?.family ? [entry.details.family] : []),
        visibilityMode: config.chatModelVisibility
      });
      return {
      id: `ollama::${entry.name}`,
      name: entry.name,
      family: guessFamily(entry.name),
      version: sanitizeVersion(entry.modified_at || entry.digest || 'local'),
      maxInputTokens: 32768,
      maxOutputTokens: 8192,
      tooltip: `Ollama (${trimTrailingSlash(config.ollama.baseUrl)})`,
      detail: 'Local Ollama model',
      capabilities: {
        imageInput: false,
        toolCalling: toolSupport.supported
      }
    };
    });
}

async function discoverLmStudioModels(
  config: ProviderConfig,
  token: vscode.CancellationToken
): Promise<vscode.LanguageModelChatInformation[]> {
  const url = `${trimTrailingSlash(config.lmStudio.baseUrl)}/v1/models`;
  const response = await fetchJson<LmStudioModelsResponse>(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.lmStudio.apiKey}`
    },
    timeoutMs: config.requestTimeoutMs,
    token
  });

  const configured = normalizeAllowlist(config.lmStudio.models);
  const models = Array.isArray(response.data) ? response.data : [];

  return models
    .filter((entry) => !configured.size || configured.has(entry.id))
    .map((entry) => {
      const toolSupport = evaluateToolCalling({
        provider: 'lmstudio',
        modelId: entry.id,
        allowlist: config.lmStudio.toolCallingModels,
        metadataCapabilities: entry.capabilities,
        visibilityMode: config.chatModelVisibility
      });
      return {
      id: `lmstudio::${entry.id}`,
      name: entry.id,
      family: guessFamily(entry.id),
      version: sanitizeVersion(entry.created || 'local'),
      maxInputTokens: 32768,
      maxOutputTokens: 8192,
      tooltip: `LM Studio (${trimTrailingSlash(config.lmStudio.baseUrl)})`,
      detail: 'Local LM Studio model',
      capabilities: {
        imageInput: false,
        toolCalling: toolSupport.supported
      }
    };
    });
}

async function streamOllamaChat(
  backend: BackendConfig,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  tools: readonly vscode.LanguageModelChatTool[],
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken
): Promise<void> {
  const backendMessages = convertMessages(messages);
  const requestUsesTools = tools.length > 0;
  let response: Response;
  try {
    response = await fetchWithTimeout(`${backend.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: backend.modelId,
        messages: maybeForceToolModeForOllama(backendMessages, options.toolMode, requestUsesTools),
        tools: requestUsesTools ? convertTools(tools) : undefined,
        stream: !requestUsesTools
      }),
      timeoutMs: getConfig().requestTimeoutMs,
      token
    });
  } catch (error) {
    if (shouldRetryWithoutTools(error, requestUsesTools)) {
      response = await fetchWithTimeout(`${backend.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: backend.modelId,
          messages: backendMessages,
          stream: true
        }),
        timeoutMs: getConfig().requestTimeoutMs,
        token
      });
      await readNdjsonStream(
        response,
        (json: { message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: object } }> } }) => {
          reportOllamaResponse(json.message, progress);
        }
      );
      return;
    }
    throw error;
  }

  if (requestUsesTools) {
    const json = await response.json() as {
      message?: {
        content?: string;
        tool_calls?: Array<{
          function?: {
            name?: string;
            arguments?: object;
          };
        }>;
      };
    };
    reportOllamaResponse(json.message, progress);
    return;
  }

  await readNdjsonStream(response, (json: { message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: object } }> } }) => {
    reportOllamaResponse(json.message, progress);
  });
}

async function streamLmStudioChat(
  backend: BackendConfig,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  tools: readonly vscode.LanguageModelChatTool[],
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken
): Promise<void> {
  const requestUsesTools = tools.length > 0;
  const backendMessages = convertMessages(messages);
  let response: Response;
  try {
    response = await fetchWithTimeout(`${backend.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${backend.apiKey || 'lm-studio'}`
      },
      body: JSON.stringify({
        model: backend.modelId,
        messages: backendMessages,
        tools: requestUsesTools ? convertTools(tools) : undefined,
        tool_choice: requestUsesTools ? convertToolChoice(options.toolMode) : undefined,
        stream: !requestUsesTools
      }),
      timeoutMs: getConfig().requestTimeoutMs,
      token
    });
  } catch (error) {
    if (shouldRetryWithoutTools(error, requestUsesTools)) {
      response = await fetchWithTimeout(`${backend.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${backend.apiKey || 'lm-studio'}`
        },
        body: JSON.stringify({
          model: backend.modelId,
          messages: backendMessages,
          stream: true
        }),
        timeoutMs: getConfig().requestTimeoutMs,
        token
      });

      const retryToolCalls = new Map<number, { id: string; name: string; argumentsText: string }>();
      await readSseStream(response, (data) => {
        if (data === '[DONE]') {
          flushOpenAiToolCalls(retryToolCalls, progress);
          return;
        }

        const json = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: OpenAiToolDelta[];
            };
          }>;
        };
        const delta = json.choices?.[0]?.delta;
        const content = typeof delta?.content === 'string' ? delta.content : '';

        if (content) {
          progress.report(new vscode.LanguageModelTextPart(content));
        }

        accumulateOpenAiToolCalls(retryToolCalls, delta?.tool_calls);
      });
      return;
    }
    throw error;
  }

  if (requestUsesTools) {
    const json = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: OpenAiTool[];
        };
      }>;
    };
    reportOpenAiMessage(json.choices?.[0]?.message, progress);
    return;
  }

  const toolCalls = new Map<number, { id: string; name: string; argumentsText: string }>();
  await readSseStream(response, (data) => {
    if (data === '[DONE]') {
      flushOpenAiToolCalls(toolCalls, progress);
      return;
    }

    const json = JSON.parse(data) as {
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: OpenAiToolDelta[];
        };
      }>;
    };
    const delta = json.choices?.[0]?.delta;
    const content = typeof delta?.content === 'string' ? delta.content : '';

    if (content) {
      progress.report(new vscode.LanguageModelTextPart(content));
    }

    accumulateOpenAiToolCalls(toolCalls, delta?.tool_calls);
  });
}

function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): ProviderChatMessage[] {
  const converted: ProviderChatMessage[] = [];
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    const role = convertRole(message.role);
    const textParts: string[] = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    const toolResults: vscode.LanguageModelToolResultPart[] = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textParts.push(part.value);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
        toolNames.set(part.callId, part.name);
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push(part);
      }
    }

    if (textParts.length || (!toolCalls.length && !toolResults.length)) {
      converted.push({
        role,
        content: textParts.join('')
      });
    }

    if (toolCalls.length) {
      converted.push({
        role: 'assistant',
        tool_calls: toolCalls.map((part) => ({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: part.input
          }
        }))
      });
    }

    for (const part of toolResults) {
      converted.push({
        role: 'tool',
        tool_name: toolNames.get(part.callId) || 'tool',
        content: part.content
          .map((entry) => {
            if (entry instanceof vscode.LanguageModelTextPart) {
              return entry.value;
            }
            return typeof entry === 'string' ? entry : JSON.stringify(entry);
          })
          .join('\n')
      });
    }
  }

  return converted;
}

function convertRole(role: vscode.LanguageModelChatMessageRole): string {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }
  if (role === vscode.LanguageModelChatMessageRole.User) {
    return 'user';
  }
  return 'system';
}

function getUsableTools(
  model: vscode.LanguageModelChatInformation,
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): readonly vscode.LanguageModelChatTool[] {
  if (!model.capabilities.toolCalling || !tools?.length) {
    return [];
  }
  return tools;
}

function convertTools(
  tools: readonly vscode.LanguageModelChatTool[]
): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema || {
        type: 'object',
        properties: {}
      }
    }
  }));
}

function convertToolChoice(toolMode: vscode.LanguageModelChatToolMode): 'auto' | 'required' {
  return toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
}

function maybeForceToolModeForOllama(
  messages: ProviderChatMessage[],
  toolMode: vscode.LanguageModelChatToolMode,
  hasTools: boolean
): ProviderChatMessage[] {
  if (!hasTools || toolMode !== vscode.LanguageModelChatToolMode.Required) {
    return messages;
  }

  return [
    {
      role: 'system',
      content: 'You must respond by selecting one or more of the provided tools. Do not answer with plain text until tool results are available.'
    },
    ...messages
  ];
}

function reportOllamaResponse(
  message: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: object } }> } | undefined,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
  if (!message) {
    return;
  }

  if (typeof message.content === 'string' && message.content) {
    progress.report(new vscode.LanguageModelTextPart(message.content));
  }

  for (const [index, toolCall] of (message.tool_calls || []).entries()) {
    const name = toolCall.function?.name;
    if (!name) {
      continue;
    }
    progress.report(
      new vscode.LanguageModelToolCallPart(
        `ollama-call-${Date.now()}-${index}`,
        name,
        normalizeToolArguments(toolCall.function?.arguments)
      )
    );
  }
}

function reportOpenAiMessage(
  message: { content?: string; tool_calls?: OpenAiTool[] } | undefined,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
  if (!message) {
    return;
  }

  if (typeof message.content === 'string' && message.content) {
    progress.report(new vscode.LanguageModelTextPart(message.content));
  }

  for (const [index, toolCall] of (message.tool_calls || []).entries()) {
    const name = toolCall.function?.name;
    if (!name) {
      continue;
    }
    progress.report(
      new vscode.LanguageModelToolCallPart(
        toolCall.id || `lmstudio-call-${Date.now()}-${index}`,
        name,
        parseOpenAiArguments(toolCall.function?.arguments)
      )
    );
  }
}

function accumulateOpenAiToolCalls(
  toolCalls: Map<number, { id: string; name: string; argumentsText: string }>,
  deltas: OpenAiToolDelta[] | undefined
): void {
  for (const delta of deltas || []) {
    const index = delta.index ?? toolCalls.size;
    const current = toolCalls.get(index) || {
      id: delta.id || `lmstudio-call-${Date.now()}-${index}`,
      name: '',
      argumentsText: ''
    };

    if (delta.id) {
      current.id = delta.id;
    }
    if (delta.function?.name) {
      current.name = delta.function.name;
    }
    if (delta.function?.arguments) {
      current.argumentsText += delta.function.arguments;
    }

    toolCalls.set(index, current);
  }
}

function flushOpenAiToolCalls(
  toolCalls: Map<number, { id: string; name: string; argumentsText: string }>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
  for (const [, toolCall] of [...toolCalls.entries()].sort((left, right) => left[0] - right[0])) {
    if (!toolCall.name) {
      continue;
    }
    progress.report(
      new vscode.LanguageModelToolCallPart(
        toolCall.id,
        toolCall.name,
        parseOpenAiArguments(toolCall.argumentsText)
      )
    );
  }
  toolCalls.clear();
}

function parseOpenAiArguments(value: string | undefined): object {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value) as object;
  } catch {
    return { raw: value };
  }
}

function normalizeToolArguments(value: object | string | undefined): object {
  if (!value) {
    return {};
  }
  if (typeof value === 'string') {
    return parseOpenAiArguments(value);
  }
  return value;
}

function evaluateToolCalling(options: {
  provider: ProviderName;
  modelId: string;
  allowlist: string[];
  metadataCapabilities?: string[];
  visibilityMode: ChatModelVisibilityMode;
}): { supported: boolean; reason: string } {
  const configured = normalizeAllowlist(options.allowlist);
  if (configured.size) {
    return configured.has(options.modelId)
      ? { supported: true, reason: 'Configured in tool-calling allowlist.' }
      : { supported: false, reason: 'Allowlist is configured and this model is not in it.' };
  }

  const metadata = (options.metadataCapabilities || []).map((entry) => entry.toLowerCase());
  if (metadata.includes('tool_use')) {
    return { supported: true, reason: 'Provider metadata reports tool_use capability.' };
  }

  if (isEmbeddingLikeModel(options.modelId)) {
    return {
      supported: false,
      reason: 'This looks like an embedding or non-chat model, so it is intentionally hidden from chat-focused tool advertising.'
    };
  }

  if (options.visibilityMode === 'all-chat-models') {
    return {
      supported: true,
      reason: 'Chat visibility mode is set to all-chat-models, so this non-embedding model is advertised in Chat.'
    };
  }

  if (options.visibilityMode === 'balanced') {
    return {
      supported: true,
      reason: 'Chat visibility mode is balanced, so this likely chat-capable model is advertised in Chat and normal chat requests will retry without tools if needed.'
    };
  }

  return {
    supported: false,
    reason: 'Tool calling is off by default unless provider metadata reports support or the model is explicitly allowlisted.'
  };
}

async function inspectToolSupport(provider: LocalLlmChatProvider): Promise<void> {
  provider.clearCache();
  const diagnostics = await collectModelSupportDiagnostics();

  if (!diagnostics.length) {
    await vscode.window.showWarningMessage(
      'BBA LocalLLM Bridge could not discover any models to inspect. Make sure Ollama or LM Studio is running.'
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    diagnostics.map((item) => ({
      label: `${item.provider === 'ollama' ? 'Ollama' : 'LM Studio'}: ${item.name}`,
      description: item.toolCalling ? 'Tool calling: supported' : 'Tool calling: not advertised',
      detail: item.reason,
      item
    })),
    {
      placeHolder: 'Inspect discovered model tool support'
    }
  );

  if (!picked) {
    return;
  }

  await vscode.window.showInformationMessage(
    `${picked.item.name} (${picked.item.provider}) ${picked.item.toolCalling ? 'supports' : 'does not advertise'} tool calling. ${picked.item.reason}`
  );
}

async function collectModelSupportDiagnostics(): Promise<ModelSupportDiagnostic[]> {
  const config = getConfig();
  const cancellation = new vscode.CancellationTokenSource();

  try {
    const tasks: Promise<ModelSupportDiagnostic[]>[] = [];
    if (config.ollama.enabled) {
      tasks.push(discoverOllamaSupportDiagnostics(config, cancellation.token));
    }
    if (config.lmStudio.enabled) {
      tasks.push(discoverLmStudioSupportDiagnostics(config, cancellation.token));
    }

    const results = await Promise.allSettled(tasks);
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  } finally {
    cancellation.dispose();
  }
}

async function discoverOllamaSupportDiagnostics(
  config: ProviderConfig,
  token: vscode.CancellationToken
): Promise<ModelSupportDiagnostic[]> {
  const url = `${trimTrailingSlash(config.ollama.baseUrl)}/api/tags`;
  const response = await fetchJson<OllamaTagResponse>(url, {
    method: 'GET',
    timeoutMs: config.requestTimeoutMs,
    token
  });

  const configured = normalizeAllowlist(config.ollama.models);
  const models = Array.isArray(response.models) ? response.models : [];

  return models
    .filter((entry) => !configured.size || configured.has(entry.name))
    .map((entry) => {
      const evaluation = evaluateToolCalling({
        provider: 'ollama',
        modelId: entry.name,
        allowlist: config.ollama.toolCallingModels,
        metadataCapabilities: entry.details?.families || (entry.details?.family ? [entry.details.family] : []),
        visibilityMode: config.chatModelVisibility
      });

      return {
        id: `ollama::${entry.name}`,
        provider: 'ollama',
        name: entry.name,
        toolCalling: evaluation.supported,
        reason: evaluation.reason
      };
    });
}

async function discoverLmStudioSupportDiagnostics(
  config: ProviderConfig,
  token: vscode.CancellationToken
): Promise<ModelSupportDiagnostic[]> {
  const url = `${trimTrailingSlash(config.lmStudio.baseUrl)}/v1/models`;
  const response = await fetchJson<LmStudioModelsResponse>(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.lmStudio.apiKey}`
    },
    timeoutMs: config.requestTimeoutMs,
    token
  });

  const configured = normalizeAllowlist(config.lmStudio.models);
  const models = Array.isArray(response.data) ? response.data : [];

  return models
    .filter((entry) => !configured.size || configured.has(entry.id))
    .map((entry) => {
      const evaluation = evaluateToolCalling({
        provider: 'lmstudio',
        modelId: entry.id,
        allowlist: config.lmStudio.toolCallingModels,
        metadataCapabilities: entry.capabilities,
        visibilityMode: config.chatModelVisibility
      });

      return {
        id: `lmstudio::${entry.id}`,
        provider: 'lmstudio',
        name: entry.id,
        toolCalling: evaluation.supported,
        reason: evaluation.reason
      };
    });
}

async function fetchJson<T>(url: string, options: FetchOptions): Promise<T> {
  const response = await fetchWithTimeout(url, options);
  return (await response.json()) as T;
}

async function fetchWithTimeout(url: string, options: FetchOptions): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Timed out calling ${url}`)),
    options.timeoutMs
  );
  const abortHandler = () => controller.abort(new Error('Request cancelled by VS Code'));
  const cancellationSubscription = options.token.onCancellationRequested(abortHandler);

  try {
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new HttpError(url, response.status, response.statusText, responseText);
    }

    return response;
  } finally {
    clearTimeout(timeout);
    cancellationSubscription.dispose();
  }
}

async function readSseStream(response: Response, onData: (data: string) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('LM Studio response body was empty.');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let boundary = findEventBoundary(buffer);

    while (boundary !== -1) {
      const event = buffer.slice(0, boundary);
      const offset = buffer.startsWith('\r\n', boundary) ? 4 : 2;
      buffer = buffer.slice(boundary + offset);

      for (const line of event.split(/\r?\n/)) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data) {
            onData(data);
          }
        }
      }

      boundary = findEventBoundary(buffer);
    }
  }
}

async function readNdjsonStream<T>(response: Response, onLine: (data: T) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Ollama response body was empty.');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n');

    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (line) {
        onLine(JSON.parse(line) as T);
      }
      boundary = buffer.indexOf('\n');
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    onLine(JSON.parse(trailing) as T);
  }
}

function normalizeAllowlist(models: string[]): Set<string> {
  return new Set((models || []).map((item) => String(item)));
}

function isEmbeddingLikeModel(modelId: string): boolean {
  const value = modelId.toLowerCase();
  return [
    'embed',
    'embedding',
    'rerank',
    'bge-m3',
    'nomic-embed',
    'text-embedding'
  ].some((token) => value.includes(token));
}

function shouldRetryWithoutTools(error: unknown, requestUsesTools: boolean): boolean {
  if (!requestUsesTools) {
    return false;
  }

  return error instanceof HttpError && error.status === 400;
}

async function configureChatVisibility(provider: LocalLlmChatProvider): Promise<void> {
  const current = getConfig().chatModelVisibility;
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: 'Balanced (Recommended)',
        value: 'balanced',
        detail: 'Show likely chat models in Chat. If a model rejects tool payloads, normal chat retries without tools.'
      },
      {
        label: 'Strict',
        value: 'strict',
        detail: 'Only show models as tool-capable when metadata or explicit allowlists say they support it.'
      },
      {
        label: 'All Chat Models',
        value: 'all-chat-models',
        detail: 'Advertise every non-embedding model in Chat. Most permissive, but some models may be flaky in tool-heavy flows.'
      }
    ],
    {
      placeHolder: `Current mode: ${current}`
    }
  );

  if (!picked) {
    return;
  }

  await vscode.workspace
    .getConfiguration()
    .update(`${CONFIG_SECTION}.chatModelVisibility`, picked.value, vscode.ConfigurationTarget.Global);

  provider.clearCache();
  await vscode.window.showInformationMessage(
    `BBA LocalLLM Bridge chat visibility set to ${picked.value}. Refresh the model picker or reload Chat if needed.`
  );
}

function guessFamily(modelName: string): string {
  const value = String(modelName || 'local').toLowerCase();
  if (value.includes('llama')) {
    return 'llama';
  }
  if (value.includes('qwen')) {
    return 'qwen';
  }
  if (value.includes('mistral')) {
    return 'mistral';
  }
  if (value.includes('gemma')) {
    return 'gemma';
  }
  return 'local';
}

function sanitizeVersion(value: string | number): string {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'local';
}

function trimTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function findEventBoundary(buffer: string): number {
  const unixBoundary = buffer.indexOf('\n\n');
  const windowsBoundary = buffer.indexOf('\r\n\r\n');
  if (unixBoundary === -1) {
    return windowsBoundary;
  }
  if (windowsBoundary === -1) {
    return unixBoundary;
  }
  return Math.min(unixBoundary, windowsBoundary);
}
