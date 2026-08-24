import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

import { site } from './src/shared/config/site';

export default defineConfig({
  site: site.url,
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
