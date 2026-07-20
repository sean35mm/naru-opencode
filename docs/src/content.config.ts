import { docsSchema } from '@astrojs/starlight/schema';
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

const docs = defineCollection({
  loader: glob({
    base: '.',
    pattern: ['*.md', 'src/content/docs/**/*.(md|mdx)'],
    generateId: ({ entry }) => entry
      .replace(/^src\/content\/docs\//, '')
      .replace(/\.(md|mdx)$/, ''),
  }),
  schema: docsSchema(),
});

export const collections = { docs };
