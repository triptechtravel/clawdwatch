# Configuration

## `createMonitor<TEnv>(options)`

| Option | Type | Description |
|---|---|---|
| `storage.getD1` | `(env) => D1Database` | Returns your D1 binding |
| `storage.getR2` | `(env) => R2Bucket` | Returns your R2 bucket binding |
| `storage.getAnalyticsEngine` | `(env) => AnalyticsEngineDataset` | Returns your AE binding |
| `resolveUrl` | `(url, env) => string` | Resolve `{{WORKER_URL}}` and other placeholders |
| `onAlert` | `(alert, env) => Promise<void>` | Called on state transitions (failure/recovery) |
| `defaults.stateKey` | `string` | R2 key for state (default: `clawdwatch/state.json`) |
| `defaults.failureThreshold` | `number` | Consecutive failures before alert (default: 2) |
| `defaults.timeoutMs` | `number` | Check timeout (default: 10,000) |
| `defaults.userAgent` | `string` | User-Agent header (default: `clawdwatch/2.0`) |

## Check Config

Checks are stored in D1 and managed via the [CRUD API](/guide/api-reference).

```typescript
interface CheckConfig {
  id: string; // unique identifier (lowercase, hyphens)
  name: string; // human-readable name
  type?: string; // 'api' (default) or 'browser' (coming soon)
  url: string; // supports {{WORKER_URL}} placeholder
  method?: string; // HTTP method (default: 'GET')
  headers?: object; // custom request headers
  body?: string; // request body for POST/PUT
  assertions?: Assertion[]; // custom assertions (default: statusCode 200)
  retry_count?: number; // retries on failure (default: 0)
  retry_delay_ms?: number; // delay between retries (default: 300)
  timeout_ms?: number; // override default (default: 10000)
  failure_threshold?: number; // override default (default: 2)
  tags?: string[];
  enabled?: boolean; // default: true
}
```

## Assertions

Assertions let you validate more than just the HTTP status code.

### Status Code

```typescript
{ type: 'statusCode', operator: 'is', value: 200 }
```

### Response Header

```typescript
{ type: 'header', name: 'Content-Type', operator: 'contains', value: 'application/json' }
```

### Response Body

```typescript
{ type: 'body', operator: 'contains', value: '"status":"ok"' }
```

### Response Time

```typescript
{ type: 'responseTime', operator: 'lessThan', value: 5000 }
```
