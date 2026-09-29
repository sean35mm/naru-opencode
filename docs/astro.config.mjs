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
        themeVariables: {
          fontFamily:
            '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '14px',
        },
        flowchart: {
          curve: 'basis',
          nodeSpacing: 44,
          rankSpacing: 52,
          padding: 12,
          // Render at intrinsic size and let .mermaid scroll horizontally. With
          // useMaxWidth, wide diagrams are scaled down until labels are unreadable.
          useMaxWidth: false,
        },
        sequence: {
          useMaxWidth: false,
          mirrorActors: false,
          messageFontFamily:
            '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
        },
      },
    }),
    starlight({
      title: 'Naru for OpenCode',
      description: 'A coordinator and model-pinned worker pool for OpenCode v2.',
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
          label: 'Workflows',
          items: [
            { label: 'Agents and workers', slug: 'workflows/agents' },
            { label: 'Review lane', slug: 'workflows/review-lane' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Compatibility', slug: 'reference/compatibility' },
            { label: 'Limitations', slug: 'reference/limitations' },
            { label: 'Development', slug: 'development' },
          ],
        },
      ],
    }),
  ],
});
