import { defineConfig } from "vitepress";

export default defineConfig({
  title: "clawdwatch",
  description:
    "Synthetic monitoring for Cloudflare Workers — deterministic detection, pluggable alerting, and a dashboard worth reading",
  base: "/clawdwatch/",
  cleanUrls: true,
  head: [
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
      },
    ],
  ],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Alerting", link: "/integration/notifiers" },
      { text: "thinkbot", link: "https://triptechtravel.github.io/thinkbot/" },
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
