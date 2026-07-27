import { defineConfig } from "vitepress";

export default defineConfig({
  title: "clawdwatch",
  description:
    "Synthetic monitoring for Cloudflare Workers — deterministic detection, pluggable alerting, and a dashboard worth reading",
  base: "/clawdwatch/",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Alerting", link: "/integration/notifiers" },
      { text: "GitHub", link: "https://github.com/triptechtravel/clawdwatch" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Configuration", link: "/guide/configuration" },
          { text: "Secrets", link: "/guide/secrets" },
          { text: "API reference", link: "/guide/api-reference" },
        ],
      },
      {
        text: "Alerting",
        items: [
          { text: "Notifiers", link: "/integration/notifiers" },
          { text: "AI agents", link: "/integration/agents" },
        ],
      },
      {
        text: "Deploying",
        items: [
          { text: "Worker setup", link: "/integration/wrangler" },
          { text: "Authentication", link: "/integration/auth" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/triptechtravel/clawdwatch" },
    ],
    search: { provider: "local" },
  },
});
