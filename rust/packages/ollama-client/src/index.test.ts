import { describe, it, expect } from 'vitest';
import { sanitizePrompt, validateModel } from './index.js';

describe('ollama-client', () => {
  it('sanitizes prompts', () => {
    expect(sanitizePrompt('hello')).toBe('hello');
    expect(() => sanitizePrompt('x'.repeat(100_001))).toThrow();
  });

  it('rejects shell injection in model names', () => {
    expect(() => validateModel('llama; rm -rf')).toThrow();
  });
});
