import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

import { site } from './src/shared/config/site';

export default defineConfig({
  site: site.url,
  integrations: [
    react(),
    starlight({
      title: site.docsTitle,
      description: site.description,
      logo: {
        src: './src/shared/assets/logo.svg',
        alt: site.name,
      },
      favicon: '/favicon.svg',
      locales: {
        root: {
          label: '简体中文',
          lang: site.defaultLocale,
        },
      },
      sidebar: [
        {
          label: '开始',
          items: [
            { label: '概览', slug: 'docs/introduction/overview' },
            { label: '安装与更新', slug: 'docs/getting-started/installation' },
            { label: '快速开始', slug: 'docs/getting-started/quick-start' },
            { label: '工作台概念', slug: 'docs/getting-started/workbench-concepts' },
          ],
        },
        {
          label: '引导',
          items: [
            { label: '数据库连接', slug: 'docs/guides/managing-connections' },
            { label: '浏览对象与数据', slug: 'docs/guides/browsing-objects-and-data' },
            { label: 'AI 助手', slug: 'docs/guides/using-ai-assistant' },
          ],
        },
        {
          label: '帮助',
          items: [
            { label: '常见问题', slug: 'docs/help/faq' },
            { label: '故障排查', slug: 'docs/help/troubleshooting' },
          ],
        },
        {
          label: '项目',
          items: [
            { label: '发布日志', slug: 'docs/releases' },
            { label: '开源计划', slug: 'docs/project/open-source-plan' },
            { label: '参与贡献', slug: 'docs/project/contributing' },
            { label: '联系我们', slug: 'docs/project/contact' },
          ],
        },
      ],
      social: [],
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 3,
      },
      pagination: true,
      credits: false,
      disable404Route: true,
      head: [
        {
          tag: 'meta',
          attrs: {
            property: 'og:site_name',
            content: site.name,
          },
        },
      ],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
