---
layout: home
hero:
  name: clawdwatch
  text: Synthetic monitoring for Cloudflare Workers
  tagline: Deterministic detection, pluggable alerting, and a dashboard that shows you what actually happened.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/triptechtravel/clawdwatch
features:
  - title: Detection stays deterministic
    details: Thresholds, a state machine, and maintenance windows decide whether something is broken. No model is in that loop.
  - title: Public code, private config
    details: Checks live in D1 and are editable through the UI, but secret values never enter the database — only references, resolved at request time.
  - title: Alerting is a plugin
    details: Slack needs one webhook URL. A signed webhook reaches anything else, including an AI agent, with no changes to the agent.
  - title: Honest history
    details: One mark per check run. A five-minute cron looks like five-minute samples, not a smoothed line that implies data you never collected.
