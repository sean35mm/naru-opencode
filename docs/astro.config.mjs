import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import { defineConfig } from 'astro/config';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: 'https://sean35mm.github.io',
  base: '/naru-opencode',
  integrations: [
    mermaid({
      theme: 'default',
      autoTheme: true,
      enableLog: false,
      mermaidConfig: {
        securityLevel: 'strict',
      },
    }),
    starlight({
      title: 'Naru for OpenCode',
      description: 'Adaptive multi-agent workflows for OpenCode.',
      favicon: '/favicon.svg',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/sean35mm/naru-opencode',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/sean35mm/naru-opencode/edit/main/docs/',
      },
      customCss: ['./src/styles/custom.css'],
      plugins: [starlightLlmsTxt()],
      sidebar: [
        { label: 'Overview', slug: 'index' },
        {
          label: 'Getting started',
          items: [
            { label: 'Quickstart', slug: 'getting-started/quickstart' },
            { label: 'Installation', slug: 'getting-started/installation' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Adaptive delegation', slug: 'concepts/adaptive-delegation' },
            { label: 'Protocols', slug: 'concepts/protocols' },
          ],
        },
        {
          label: 'Runtime',
          items: [
            { label: 'Scheduler modes', slug: 'runtime/scheduler-modes' },
            { label: 'Dashboard and telemetry', slug: 'runtime/dashboard-telemetry' },
          ],
        },
        {
          label: 'Workflows',
          items: [
            { label: 'Agents', slug: 'workflows/agents' },
            { label: 'Review lane', slug: 'workflows/review-lane' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Runtime configuration', slug: 'reference/runtime-config' },
            { label: 'Limitations', slug: 'reference/limitations' },
            { label: 'For LLMs', slug: 'reference/for-llms' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'User guide', slug: 'user-guide' },
            { label: 'Agent integration', slug: 'agent-integration' },
            { label: 'Development', slug: 'development' },
          ],
        },
      ],
    }),
  ],
});
