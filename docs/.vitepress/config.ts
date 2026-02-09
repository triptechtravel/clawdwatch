import { defineConfig } from "vitepress";

export default defineConfig({
  title: "ClawdWatch",
  description:
    "Synthetic monitoring for Cloudflare Workers — health checks, state machine alerts, and an embedded dashboard",
  base: "/clawdwatch/",
  head: [
    ["link", { rel: "icon", href: "https://openclaw.ai/favicon.svg" }],
  ],
  themeConfig: {
    logo: "https://openclaw.ai/logo.svg",
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Integration", link: "/integration/agent-setup" },
      { text: "OpenClaw", link: "https://openclaw.ai/" },
      {
        text: "GitHub",
        link: "https://github.com/triptechtravel/clawdwatch",
      },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Configuration", link: "/guide/configuration" },
          { text: "API Reference", link: "/guide/api-reference" },
        ],
      },
      {
        text: "Integration",
        items: [
          { text: "Agent Setup", link: "/integration/agent-setup" },
          { text: "Wrangler Bindings", link: "/integration/wrangler" },
        ],
      },
    ],
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/triptechtravel/clawdwatch",
      },
    ],
  },
});
