import { defineConfig } from 'vitepress';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

export default defineConfig({
  title: 'BLE Scale Sync',
  description:
    'Automatic body composition sync from BLE smart scales to Garmin Connect, Home Assistant, InfluxDB and more.',
  lang: 'en-US',

  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#3b82f6' }],
    [
      'meta',
      {
        name: 'keywords',
        content:
          'ble scale, smart scale, body composition, garmin connect, strava, bluetooth scale, weight sync, raspberry pi, home assistant, mqtt, self-hosted, docker, body fat, impedance',
      },
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'BLE Scale Sync' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Automatic body composition sync from BLE smart scales to Garmin Connect, Strava, Home Assistant, InfluxDB and more.',
      },
    ],
    ['meta', { property: 'og:url', content: 'https://blescalesync.dev' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],

  sitemap: {
    hostname: 'https://blescalesync.dev',
  },

  cleanUrls: true,

  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'BLE Scale Sync',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Exporters', link: '/exporters' },
      { text: 'Changelog', link: '/changelog' },
      { text: 'Stats', link: 'https://stats.blescalesync.dev' },
      {
        text: `v${pkg.version}`,
        link: `https://github.com/KristianP26/ble-scale-sync/releases/tag/v${pkg.version}`,
      },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Supported Scales', link: '/guide/supported-scales' },
        ],
      },
      {
        text: 'Deployment',
        items: [
          { text: 'Home Assistant Add-on', link: '/guide/home-assistant-addon' },
          { text: 'ESP32 BLE Proxy', link: '/guide/esp32-proxy' },
          { text: 'ESPHome Bluetooth Proxy', link: '/guide/esphome-proxy' },
          { text: 'Auto Updates', link: '/guide/auto-update' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Exporters', link: '/exporters' },
          { text: 'Multi-User', link: '/multi-user' },
          { text: 'Body Composition', link: '/body-composition' },
        ],
      },
      {
        text: 'Help',
        items: [
          { text: 'FAQ', link: '/faq' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
          { text: 'Alternatives', link: '/alternatives' },
          { text: 'Changelog', link: '/changelog' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/KristianP26/ble-scale-sync' }],

    editLink: {
      pattern: 'https://github.com/KristianP26/ble-scale-sync/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the GPL-3.0 License.',
      copyright: 'Copyright &copy; 2026 Kristi\u00e1n Partl',
    },
  },
});
