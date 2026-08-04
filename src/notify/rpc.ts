/**
 * Service-binding RPC notifier — for a receiver that is itself a Worker.
 *
 * The webhook notifier treats an agent inbox as a URL, which is what makes it
 * work with anything. When the receiver is a Worker in the same account, a
 * service binding is strictly better: the platform authenticates the call, so
 * there is no shared HMAC secret to distribute or rotate, no public inbox to
 * defend, and no replay window to reason about. The payload crosses as a
 * structured value rather than a JSON string.
 *
 * It is deliberately NOT a replacement. Service bindings are same-account
 * only, so an inbox that is not a Worker on your account — a self-hosted
 * agent, an automation platform, someone else's deployment — still needs
 * `webhook()`. Most deployments want one or the other; a few want both.
 *
 * The receiving Worker exposes a `WorkerEntrypoint`:
 *
 *   import { WorkerEntrypoint } from 'cloudflare:workers';
 *   export class AlertInbox extends WorkerEntrypoint<Env> {
 *     async alert(event: AlertEvent) { ... }
 *   }
 *
 * and the sender binds it:
 *
 *   "services": [
 *     { "binding": "AGENT", "service": "thinkbot", "entrypoint": "AlertInbox" }
 *   ]
 *
 *   notifiers: [rpc({ binding: (env) => env.AGENT })]
 *
 * Note that an RPC call carries no signature: authenticity comes from the
 * binding itself. A receiver must not assume a verification step ran, so keep
 * signature checking in the HTTP adapter only.
 */

import type { AlertEvent, AlertEventKind, Notifier, NotifierContext } from '../types';

/** The shape `rpc()` needs from the bound entrypoint. */
export type AlertReceiver = Record<string, (event: AlertEvent) => unknown>;

export interface RpcOptions<TEnv> {
  /**
   * Pick the service binding out of the Worker env. Returning undefined is
   * treated as a misconfiguration rather than a no-op — see `notify`.
   */
  binding: (env: TEnv) => AlertReceiver | undefined;
  /** Method to call on the entrypoint. Defaults to `alert`. */
  method?: string;
  /** Override the notifier name (useful when routing to several receivers). */
  name?: string;
  /** Restrict which event kinds are sent. Defaults to all. */
  on?: AlertEventKind[];
}

export function rpc<TEnv = unknown>(options: RpcOptions<TEnv>): Notifier<TEnv> {
  const method = options.method ?? 'alert';

  return {
    name: options.name ?? 'rpc',
    on: options.on,
    async notify(event: AlertEvent, ctx: NotifierContext<TEnv>) {
      const target = options.binding(ctx.env);

      // Throwing rather than returning quietly: dispatch records delivery
      // outcomes, and an unconfigured binding must show up there as a failure.
      // A silent success is how a dead alert path stays invisible.
      if (!target) {
        throw new Error(
          'rpc notifier: service binding is not configured. Add it to your Worker ' +
            'config under "services" and make sure the accessor returns it.',
        );
      }

      const fn = target[method];
      if (typeof fn !== 'function') {
        throw new Error(
          `rpc notifier: the bound entrypoint has no \`${method}\` method. ` +
            'Check the `entrypoint` in your service binding, or set `method`.',
        );
      }

      await fn.call(target, event);
    },
  };
}
