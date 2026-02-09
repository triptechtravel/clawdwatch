import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadState, saveState, createEmptyState, createEmptyCheckState } from './state';

function createMockBucket() {
  return {
    get: vi.fn(),
    put: vi.fn().mockResolvedValue(undefined),
  } as unknown as R2Bucket;
}

function suppressConsole() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
}

describe('state', () => {
  beforeEach(() => {
    suppressConsole();
  });

  describe('createEmptyState', () => {
    it('returns empty monitoring state', () => {
      const state = createEmptyState();
      expect(state).toEqual({ checks: {}, lastRun: null });
    });
  });

  describe('createEmptyCheckState', () => {
    it('returns unknown check state with the given id', () => {
      const check = createEmptyCheckState('test-check');
      expect(check).toEqual({
        id: 'test-check',
        status: 'unknown',
        consecutiveFailures: 0,
        lastCheck: null,
        lastSuccess: null,
        lastError: null,
        responseTimeMs: null,
        history: [],
      });
    });
  });

  describe('loadState', () => {
    it('returns empty state when no object exists in R2', async () => {
      const bucket = createMockBucket();
      (bucket.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const state = await loadState(bucket, 'clawdwatch/state.json');
      expect(state).toEqual(createEmptyState());
      expect(bucket.get).toHaveBeenCalledWith('clawdwatch/state.json');
    });

    it('parses existing state from R2', async () => {
      const bucket = createMockBucket();
      const existingState = {
        checks: {
          'test-check': {
            id: 'test-check',
            status: 'healthy',
            consecutiveFailures: 0,
            lastCheck: '2025-01-01T00:00:00Z',
            lastSuccess: '2025-01-01T00:00:00Z',
            lastError: null,
            responseTimeMs: 150,
          },
        },
        lastRun: '2025-01-01T00:00:00Z',
      };
      (bucket.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: () => Promise.resolve(JSON.stringify(existingState)),
      });

      const state = await loadState(bucket, 'clawdwatch/state.json');
      expect(state).toEqual(existingState);
    });

    it('returns empty state on parse error', async () => {
      const bucket = createMockBucket();
      (bucket.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: () => Promise.resolve('invalid json'),
      });

      const state = await loadState(bucket, 'clawdwatch/state.json');
      expect(state).toEqual(createEmptyState());
    });

    it('returns empty state on R2 error', async () => {
      const bucket = createMockBucket();
      (bucket.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('R2 down'));

      const state = await loadState(bucket, 'clawdwatch/state.json');
      expect(state).toEqual(createEmptyState());
    });

    it('uses configurable state key', async () => {
      const bucket = createMockBucket();
      (bucket.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await loadState(bucket, 'custom/key.json');
      expect(bucket.get).toHaveBeenCalledWith('custom/key.json');
    });
  });

  describe('saveState', () => {
    it('writes state as JSON to R2', async () => {
      const bucket = createMockBucket();
      const state = {
        checks: {
          'test-check': createEmptyCheckState('test-check'),
        },
        lastRun: '2025-01-01T00:00:00Z',
      };

      await saveState(bucket, 'clawdwatch/state.json', state);

      expect(bucket.put).toHaveBeenCalledWith(
        'clawdwatch/state.json',
        JSON.stringify(state, null, 2),
        { httpMetadata: { contentType: 'application/json' } },
      );
    });
  });
});
