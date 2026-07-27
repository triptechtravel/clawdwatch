/**
 * Slack notifier — Block Kit messages, no agent required.
 *
 * A faithful port of the private healthcheck worker's `slack-messages.ts`:
 * same colours, same header wording, same four message shapes. What changes is
 * the input (an `AlertEvent` rather than ad-hoc structs) and the error
 * handling — the original swallowed every failure, so a dead webhook was
 * indistinguishable from a working one. Here a failed POST throws, and
 * `dispatch` records it in a DeliveryReport.
 */

import type { AlertEvent, CheckSummary, FailureDetail, Notifier, NotifierContext } from '../types';

const COLOR = {
  incident: '#E01E5A',
  recovered: '#2EB67D',
  reminder: '#ECB22E',
} as const;

export interface SlackOptions {
  /** Incoming-webhook URL. May be a `${SECRET_NAME}` reference. */
  webhook: string;
  /** Restrict which event kinds are sent. Defaults to all. */
  on?: AlertEvent['kind'][];
  /** Override the notifier name (useful when routing to several channels). */
  name?: string;
  /** Injected for tests. */
  now?: () => number;
}

interface SlackPayload {
  attachments: Array<{ color: string; blocks: Record<string, unknown>[] }>;
}

/** `1d 3h`, `2h 10m`, `45m`, `12s` — same rules as the original. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function context(text: string) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function header(text: string) {
  return { type: 'header', text: { type: 'plain_text', text, emoji: true } };
}

function section(text: string) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function failureLines(check: CheckSummary, failure: FailureDetail): string {
  const lines = [`*${check.name}*`, check.url];
  lines.push(`Status: \`${failure.statusCode ?? 'unreachable'}\``);
  if (failure.assertions.length > 0) {
    lines.push(...failure.assertions.map((a) => `Error: _${a}_`));
  }
  return lines.join('\n');
}

export function buildIncidentMessage(
  failures: Array<{ check: CheckSummary; failure: FailureDetail }>,
  at: string,
): SlackPayload {
  const threshold = failures[0]?.failure.consecutiveFailures ?? 0;
  return {
    attachments: [
      {
        color: COLOR.incident,
        blocks: [
          header(`\u{1F534} Incident — ${plural(failures.length, 'endpoint')} down`),
          ...failures.map((f) => section(failureLines(f.check, f.failure))),
          { type: 'divider' },
          context(
            `Confirmed after ${plural(threshold, 'consecutive failure')} · Checked at ${at}`,
          ),
        ],
      },
    ],
  };
}

export function buildRecoveryMessage(
  recoveries: Array<{ check: CheckSummary; downtimeMs: number }>,
  at: string,
): SlackPayload {
  return {
    attachments: [
      {
        color: COLOR.recovered,
        blocks: [
          header(`\u{1F7E2} Recovered — ${plural(recoveries.length, 'endpoint')}`),
          ...recoveries.map((r) =>
            section(
              [`*${r.check.name}*`, r.check.url, `Downtime: ${formatDuration(r.downtimeMs)}`].join(
                '\n',
              ),
            ),
          ),
          { type: 'divider' },
          context(`Checked at ${at}`),
        ],
      },
    ],
  };
}

export function buildReminderMessage(
  reminders: Array<{ check: CheckSummary; downSinceMs: number }>,
  at: string,
): SlackPayload {
  const lines = reminders.map(
    (r) => `*${r.check.name}* — down ${formatDuration(r.downSinceMs)}`,
  );
  return {
    attachments: [
      {
        color: COLOR.reminder,
        blocks: [
          header(`⚠️ Still down — ${plural(reminders.length, 'endpoint')}`),
          section(lines.join('\n')),
          { type: 'divider' },
          context(`Checked at ${at}`),
        ],
      },
    ],
  };
}

export function buildAllClearMessage(totalChecks: number, at: string): SlackPayload {
  return {
    attachments: [
      {
        color: COLOR.recovered,
        blocks: [
          header('✅ All Clear'),
          section(`All ${totalChecks} monitored endpoints are healthy.`),
          { type: 'divider' },
          context(`Checked at ${at}`),
        ],
      },
    ],
  };
}

/** Turn an event into a payload, or null when it warrants no message. */
export function buildPayload(event: AlertEvent): SlackPayload | null {
  switch (event.kind) {
    case 'opened':
      return buildIncidentMessage([{ check: event.check, failure: event.failure }], event.at);

    case 'recovered':
      return buildRecoveryMessage(
        [{ check: event.check, downtimeMs: event.downtimeMs }],
        event.at,
      );

    case 'reminder':
      return buildReminderMessage(
        [{ check: event.check, downSinceMs: event.downSinceMs }],
        event.at,
      );

    case 'summary':
      // The per-check events already covered the detail; the summary only adds
      // the all-clear, which is the one message that needs the fleet view.
      return event.allClear ? buildAllClearMessage(event.totalChecks, event.at) : null;
  }
}

export function slack<TEnv = unknown>(options: SlackOptions): Notifier<TEnv> {
  return {
    name: options.name ?? 'slack',
    on: options.on,
    async notify(event: AlertEvent, ctx: NotifierContext<TEnv>) {
      const payload = buildPayload(event);
      if (!payload) return;

      const url = ctx.resolve(options.webhook);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      // Unlike the original, a bad response is an error. A webhook that 404s
      // must not look like a delivered alert.
      if (!response.ok) {
        throw new Error(`Slack webhook returned ${response.status}`);
      }
    },
  };
}
