import { defineConfig } from 'vitepress';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

const SITE_URL = 'https://blescalesync.dev';

export default defineConfig({
  // Planning and design notes live in the repo, not on the public site.
  srcExclude: ['superpowers/**'],
  title: 'BLE Scale Sync',
  description:
    'Automatic body composition sync from BLE smart scales to Garmin Connect, Home Assistant, InfluxDB and more.',
  lang: 'en-US',

  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#3b82f6' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ],

  // Per-page Open Graph tags, so a shared link shows the page's own title and
  // description instead of the site's.
  transformHead({ page, pageData, title, description }) {
    if (pageData.isNotFound) return;
    const path = page.replace(/\.md$/, '').replace(/(^|\/)index$/, '$1');
    return [
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: `${SITE_URL}/${path}` }],
    ];
  },

  sitemap: {
    hostname: SITE_URL,
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
        link: '/changelog',
      },
    ],

    sidebar: [
      {
        text: 'Get Started',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Home Assistant Add-on', link: '/guide/home-assistant-addon' },
        ],
      },
      {
        text: 'Scales',
        items: [
          { text: 'Supported Scales', link: '/guide/supported-scales' },
          { text: 'QN Scales', link: '/guide/scales/qn' },
          { text: 'Renpho Scales', link: '/guide/scales/renpho' },
          { text: 'Beurer and Sanitas', link: '/guide/scales/beurer' },
        ],
      },
      {
        text: 'Bluetooth',
        items: [
          { text: 'Bluetooth Transports', link: '/guide/transports' },
          { text: 'ESP32 BLE Proxy', link: '/guide/esp32-proxy' },
          { text: 'ESPHome Bluetooth Proxy', link: '/guide/esphome-proxy' },
          { text: 'Home Assistant Bluetooth', link: '/guide/ha-bluetooth' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Exporters', link: '/exporters' },
          { text: 'Multi-User', link: '/multi-user' },
          { text: 'Body Composition', link: '/body-composition' },
          { text: 'Auto Updates', link: '/guide/auto-update' },
        ],
      },
      {
        text: 'Help',
        items: [
          { text: 'Troubleshooting', link: '/troubleshooting' },
          { text: 'FAQ', link: '/faq' },
          { text: 'Alternatives', link: '/alternatives' },
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
