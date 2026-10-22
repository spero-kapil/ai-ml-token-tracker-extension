// Provider cards shown in the popup. `details` names the <template> used for the
// card's expandable section, so each provider can get its own layout later.
// Only ChatGPT is integrated; the others are UI placeholders with no data source.
// Icons are generic glyphs, not the providers' official logos.

const svg = (body) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const PROVIDERS = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    integrated: true,
    details: 'details-chatgpt',
    color: '#10a37f',
    icon: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>')
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    integrated: false,
    details: 'details-placeholder',
    color: '#d97757',
    icon: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>')
  },
  {
    id: 'cursor',
    name: 'Cursor',
    integrated: false,
    details: 'details-placeholder',
    color: '#5b6cff',
    icon: svg('<path d="M5 3l14 7-6 2-2 6z"/>')
  },
  {
    id: 'devin',
    name: 'Devin',
    integrated: false,
    details: 'details-placeholder',
    color: '#2f80ed',
    icon: svg('<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5"/>')
  }
];
