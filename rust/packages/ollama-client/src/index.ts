import { hash } from '@noetis/crypto';

export interface OllamaModel {
  name: string;
  model_hash: string;
  context_length: number;
  size: number;
}

export interface GenerateOptions {
  model: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  seed?: number;
  timeoutMs?: number;
}

export interface GenerateResult {
  response: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  model: string;
}

const DEFAULT_TIMEOUT = 120_000;
const ALLOWED_MODELS = new Set<string>();

export function setModelAllowlist(models: string[]): void {
  ALLOWED_MODELS.clear();
  for (const m of models) ALLOWED_MODELS.add(m);
}

export function validateModel(model: string): void {
  if (ALLOWED_MODELS.size > 0 && !ALLOWED_MODELS.has(model) && ![...ALLOWED_MODELS].some((m) => model.startsWith(m))) {
    throw new Error(`Model not in allowlist: ${model}`);
  }
  if (/[;&|`$]/.test(model)) {
    throw new Error('Invalid model name');
  }
}

export function sanitizePrompt(prompt: string): string {
  if (typeof prompt !== 'string') throw new Error('Prompt must be a string');
  if (prompt.length > 100_000) throw new Error('Prompt too large');
  return prompt;
}

export class OllamaClient {
  constructor(private baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(this.url('/api/tags'), { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<OllamaModel[]> {
    const res = await fetch(this.url('/api/tags'), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Ollama list models failed: ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name: string; size: number; details?: { parameter_size?: string } }> };
    return (data.models ?? []).map((m) => ({
      name: m.name,
      model_hash: hash(m.name + String(m.size)),
      context_length: 8192,
      size: m.size,
    }));
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    validateModel(options.model);
    const prompt = sanitizePrompt(options.prompt);
    const start = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;

    const body = {
      model: options.model,
      prompt,
      system: options.system ?? 'You are a helpful assistant.',
      stream: false,
      options: {
        temperature: options.temperature ?? 0,
        num_predict: options.maxTokens ?? 512,
        seed: options.seed ?? 42,
      },
    };

    const res = await fetch(this.url('/api/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama generate failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as {
      response?: string;
      eval_count?: number;
      prompt_eval_count?: number;
    };

    const durationMs = Date.now() - start;
    const response = data.response ?? '';
    return {
      response,
      inputTokens: data.prompt_eval_count ?? Math.ceil(prompt.length / 4),
      outputTokens: data.eval_count ?? Math.ceil(response.length / 4),
      durationMs,
      model: options.model,
    };
  }
}
