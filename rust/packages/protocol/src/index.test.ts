import { describe, it, expect } from 'vitest';
import { WSMessageSchema, CreateTaskRequestSchema } from './index.js';

describe('protocol schemas', () => {
  it('validates websocket message', () => {
    const msg = WSMessageSchema.parse({
      type: 'NODE_HEARTBEAT',
      message_id: '550e8400-e29b-41d4-a716-446655440000',
      timestamp: 1783745000,
      sender: 'abc123',
      payload: { status: 'available' },
      signature: 'sig',
    });
    expect(msg.type).toBe('NODE_HEARTBEAT');
  });

  it('rejects oversized prompts', () => {
    expect(() =>
      CreateTaskRequestSchema.parse({
        wallet_address: 'noet1abc',
        prompt: 'x'.repeat(100_001),
        model: 'llama3.2:3b',
        max_output_tokens: 512,
        verification_level: 'low',
        processing_mode: 'single',
        signature: 'sig',
        timestamp: Date.now(),
        nonce: 'n1',
      })
    ).toThrow();
  });
});
