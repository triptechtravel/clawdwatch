import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoutes } from './index';

// Mock the db module
vi.mock('../engine/db', () => ({
  loadAllChecks: vi.fn().mockResolvedValue([]),
  loadCheck: vi.fn().mockResolvedValue(null),
  createCheck: vi.fn().mockResolvedValue(undefined),
  updateCheck: vi.fn().mockResolvedValue(true),
  deleteCheck: vi.fn().mockResolvedValue(true),
  toggleCheck: vi.fn().mockResolvedValue(true),
  listIncidents: vi.fn().mockResolvedValue([]),
  loadAllAlertRules: vi.fn().mockResolvedValue([]),
  createAlertRule: vi.fn().mockResolvedValue(1),
  deleteAlertRule: vi.fn().mockResolvedValue(true),
  listMaintenanceWindows: vi.fn().mockResolvedValue([]),
  createMaintenanceWindow: vi.fn().mockResolvedValue(1),
  deleteMaintenanceWindow: vi.fn().mockResolvedValue(true),
}));

vi.mock('../engine/state', () => ({
  loadState: vi.fn().mockResolvedValue({ checks: {}, lastRun: null }),
}));

vi.mock('../engine/runner', () => ({
  runCheck: vi.fn().mockResolvedValue({ id: 'test', success: true, statusCode: 200, responseTimeMs: 50, error: null }),
}));

import {
  loadAllAlertRules,
  createAlertRule,
  deleteAlertRule,
  listMaintenanceWindows,
  createMaintenanceWindow,
  deleteMaintenanceWindow,
} from '../engine/db';

const mockD1 = {} as D1Database;
const mockBucket = {} as R2Bucket;

function createTestApp() {
  return createRoutes({
    stateKey: 'clawdwatch/state.json',
    userAgent: 'clawdwatch/test',
    getD1: () => mockD1,
    getBucket: () => mockBucket,
  });
}

describe('routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Alert Rules ──

  describe('GET /api/alert-rules', () => {
    it('returns alert rules', async () => {
      const rules = [{ id: 1, channel: 'gateway', config: {}, on_failure: true, on_recovery: true, enabled: true, check_id: null, group_id: null }];
      vi.mocked(loadAllAlertRules).mockResolvedValueOnce(rules);

      const app = createTestApp();
      const res = await app.request('/api/alert-rules');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.alertRules).toEqual(rules);
    });
  });

  describe('POST /api/alert-rules', () => {
    it('creates an alert rule', async () => {
      vi.mocked(createAlertRule).mockResolvedValueOnce(42);

      const app = createTestApp();
      const res = await app.request('/api/alert-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'slack', config: { webhook: 'https://hooks.slack.com/...' } }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toEqual({ ok: true, id: 42 });
      expect(createAlertRule).toHaveBeenCalledWith(mockD1, {
        channel: 'slack',
        config: { webhook: 'https://hooks.slack.com/...' },
      });
    });

    it('rejects when channel is missing', async () => {
      const app = createTestApp();
      const res = await app.request('/api/alert-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: {} }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('channel is required');
    });
  });

  describe('DELETE /api/alert-rules/:id', () => {
    it('deletes an alert rule', async () => {
      vi.mocked(deleteAlertRule).mockResolvedValueOnce(true);

      const app = createTestApp();
      const res = await app.request('/api/alert-rules/5', { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(deleteAlertRule).toHaveBeenCalledWith(mockD1, 5);
    });

    it('returns 404 when rule not found', async () => {
      vi.mocked(deleteAlertRule).mockResolvedValueOnce(false);

      const app = createTestApp();
      const res = await app.request('/api/alert-rules/999', { method: 'DELETE' });

      expect(res.status).toBe(404);
    });
  });

  // ── Maintenance Windows ──

  describe('GET /api/maintenance', () => {
    it('returns maintenance windows', async () => {
      const windows = [{
        id: 1, check_id: null, group_id: null,
        starts_at: '2026-02-09T00:00:00Z', ends_at: '2026-02-09T06:00:00Z',
        reason: 'Deploy', suppress_alerts: true, skip_checks: false,
      }];
      vi.mocked(listMaintenanceWindows).mockResolvedValueOnce(windows);

      const app = createTestApp();
      const res = await app.request('/api/maintenance');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.maintenanceWindows).toEqual(windows);
    });
  });

  describe('POST /api/maintenance', () => {
    it('creates a maintenance window', async () => {
      vi.mocked(createMaintenanceWindow).mockResolvedValueOnce(7);

      const app = createTestApp();
      const res = await app.request('/api/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          starts_at: '2026-02-09T00:00:00Z',
          ends_at: '2026-02-09T06:00:00Z',
          reason: 'Deploy',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toEqual({ ok: true, id: 7 });
      expect(createMaintenanceWindow).toHaveBeenCalledWith(mockD1, {
        starts_at: '2026-02-09T00:00:00Z',
        ends_at: '2026-02-09T06:00:00Z',
        reason: 'Deploy',
      });
    });

    it('rejects when starts_at is missing', async () => {
      const app = createTestApp();
      const res = await app.request('/api/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ends_at: '2026-02-09T06:00:00Z' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('starts_at and ends_at are required');
    });

    it('rejects when ends_at is missing', async () => {
      const app = createTestApp();
      const res = await app.request('/api/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ starts_at: '2026-02-09T00:00:00Z' }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/maintenance/:id', () => {
    it('deletes a maintenance window', async () => {
      vi.mocked(deleteMaintenanceWindow).mockResolvedValueOnce(true);

      const app = createTestApp();
      const res = await app.request('/api/maintenance/3', { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(deleteMaintenanceWindow).toHaveBeenCalledWith(mockD1, 3);
    });

    it('returns 404 when window not found', async () => {
      vi.mocked(deleteMaintenanceWindow).mockResolvedValueOnce(false);

      const app = createTestApp();
      const res = await app.request('/api/maintenance/999', { method: 'DELETE' });

      expect(res.status).toBe(404);
    });
  });
});
