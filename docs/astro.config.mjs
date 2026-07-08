// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// kura is hosted at https://kechol.github.io/kura/. The `base` matches the
// repository name so all links resolve under that prefix.
export default defineConfig({
  site: 'https://kechol.github.io',
  base: '/kura',
  integrations: [
    starlight({
      title: 'kura',
      description:
        'A local knowledge management CLI backed by SQLite, with Japanese-aware hybrid search for both humans and AI agents.',
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      // Drop the macOS-style terminal header (three traffic-light dots)
      // Expressive Code adds to sh / bash blocks by default; keep the rounded
      // code box but remove the window chrome.
      expressiveCode: {
        defaultProps: { frame: 'code' },
      },
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        ja: { label: '日本語', lang: 'ja' },
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/kechol/kura',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/kechol/kura/edit/main/docs/',
      },
      sidebar: [
        {
          label: 'Start Here',
          translations: { ja: 'はじめに' },
          items: [
            {
              label: 'Quick Start',
              translations: { ja: 'クイックスタート' },
              slug: 'quick-start',
            },
            {
              label: 'Concept',
              translations: { ja: 'コンセプト' },
              slug: 'concept',
            },
            {
              label: 'Installation',
              translations: { ja: 'インストール' },
              slug: 'installation',
            },
          ],
        },
        {
          label: 'Reference',
          translations: { ja: 'リファレンス' },
          items: [
            {
              label: 'CLI',
              translations: { ja: 'CLI' },
              slug: 'cli',
            },
            {
              label: 'Search',
              translations: { ja: '検索' },
              slug: 'search',
            },
            {
              label: 'AI Agents (MCP)',
              translations: { ja: 'AI エージェント (MCP)' },
              slug: 'mcp',
            },
            {
              label: 'Configuration',
              translations: { ja: '設定' },
              slug: 'configuration',
            },
          ],
        },
      ],
    }),
  ],
});
