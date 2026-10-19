/* ==========================================================================
   Zero Cost AI Dating — the stored theme, before the first paint
   The one script in a page's <head>. A theme chosen in Settings is kept under
   'zc.theme', and app.js applies it, but app.js runs at the end of the body
   and the browser paints the parsed body without waiting for it. So every
   load showed the OS theme first: with dark chosen on a light OS, settings
   painted light at 52ms and turned dark at 123ms, and with each script a
   100ms round trip away it stayed light until 882ms.
   This sets the same <html data-theme> from the same key before there is a
   body to paint. It only reads: app.js still owns the theme, writes the key
   and reconciles it with the account's saved preference once auth settles.
   'system', nothing stored, or no storage at all leaves the attribute off,
   which is the OS theme, and what app.js applies for them too.
   tests/static.test.js holds every page but 404.html to loading this in
   <head>, and this file to app.js's key and themes.
   ========================================================================== */
(function () {
  'use strict';

  try {
    const theme = window.localStorage.getItem('zc.theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (err) {
    // Storage refused (private mode, a file:// origin): the OS theme stands.
  }
})();
