// Where the API lives. Empty = same origin (Render serving everything, or local dev).
// On any other host (e.g. Vercel) the frontend calls the Render backend instead.
const RENDER_URL = 'https://tracker-9fs2.onrender.com';
const API_BASE = /onrender\.com$|^localhost$|^127\./.test(location.hostname) ? '' : RENDER_URL;
