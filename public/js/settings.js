/* ==========================================================================
   Zero Cost AI Dating — settings
   Everything about an account that is not the profile itself: the display
   name, the discovery filters the matching engine reads, theme and
   notifications, the "bring your own Firebase project" panel, the reports the
   account has filed (with retraction), and the data tools (export, demo
   reset, delete).

   Reads and writes go through ZC.store, with one deliberate exception that is
   commented where it happens: deleting an account needs to remove the user
   document, which the store facade does not expose.
   ========================================================================== */
(function () {
  'use strict';

  window.ZC = window.ZC || {};
  const ZC = window.ZC;

  // This file is the settings page script; every other page has no such root.
  const root = document.getElementById('settings-page');
  if (!root) return;
  if (!ZC.util || typeof ZC.util.el !== 'function') {
    console.error('[zc] settings.js needs js/utils.js to be loaded first.');
    return;
  }
  // Tolerate being loaded twice.
  if (root.dataset.zcSettings === '1') return;
  root.dataset.zcSettings = '1';

  const util = ZC.util;
  const ui = ZC.ui || {};

  /* ------------------------------------------------------------------------
     1. Constants
     ------------------------------------------------------------------------ */

  const NAME_MIN = 2;
  const NAME_MAX = 40;
  const AGE_MIN = 18;
  const AGE_MAX = 100;
  const DISTANCE_MIN = 1;
  const DISTANCE_MAX = 500;          // the slider maximum reads "Anywhere"
  const DELETE_PHRASE = 'DELETE';
  const EXPORT_MESSAGE_LIMIT = 500;  // messages pulled per conversation for the export

  /** Where the Firebase override lives, mirroring firebase-config.js. */
  const OVERRIDE_KEY = (ZC.config && ZC.config.overrideKey) || 'zc.firebaseConfig';
  const REQUIRED_CONFIG_FIELDS = ['apiKey', 'authDomain', 'projectId', 'appId'];
  const OPTIONAL_CONFIG_FIELDS = ['storageBucket', 'messagingSenderId'];
  const PLACEHOLDER_RE = /^your-|^AIza\.\.\.|REPLACE_ME/i;

  /** Demo credentials are auth.js's key; account deletion has to clear it too. */
  const CREDENTIALS_KEY = 'zc.demo.credentials';

  const GENDERS = ['woman', 'man', 'nonbinary', 'other'];

  /* ------------------------------------------------------------------------
     2. DOM handles and small helpers
     ------------------------------------------------------------------------ */

  const dom = {
    accountForm: document.getElementById('account-form'),
    accountBadge: document.getElementById('account-badge'),
    accountStatus: document.getElementById('account-status'),
    email: document.getElementById('input-email'),
    nameField: document.getElementById('field-name'),
    nameInput: document.getElementById('input-name'),
    nameError: document.getElementById('error-name'),
    saveAccount: document.getElementById('save-account'),

    discoveryForm: document.getElementById('discovery-form'),
    interestedField: document.getElementById('field-interested'),
    interestedError: document.getElementById('error-interested'),
    ageMin: document.getElementById('age-min'),
    ageMax: document.getElementById('age-max'),
    ageValue: document.getElementById('age-value'),
    distance: document.getElementById('distance'),
    distanceValue: document.getElementById('distance-value'),
    discoverable: document.getElementById('switch-discoverable'),
    discoveryStatus: document.getElementById('discovery-status'),
    saveDiscovery: document.getElementById('save-discovery'),

    themeGroup: document.getElementById('theme-group'),
    notifications: document.getElementById('switch-notifications'),
    appearanceStatus: document.getElementById('appearance-status'),

    firebaseForm: document.getElementById('firebase-form'),
    firebaseMode: document.getElementById('firebase-mode'),
    firebaseField: document.getElementById('field-firebase'),
    firebaseInput: document.getElementById('firebase-config'),
    firebaseError: document.getElementById('error-firebase'),
    saveFirebase: document.getElementById('save-firebase'),
    resetFirebase: document.getElementById('reset-firebase'),

    reportsStatus: document.getElementById('reports-status'),
    reportsList: document.getElementById('reports-list'),

    exportData: document.getElementById('export-data'),
    demoTools: document.getElementById('demo-tools'),
    resetDemo: document.getElementById('reset-demo'),
    signoutHint: document.getElementById('signout-hint'),
    deleteField: document.getElementById('field-delete'),
    deleteInput: document.getElementById('delete-confirm'),
    deleteError: document.getElementById('error-delete'),
    deleteButton: document.getElementById('delete-account')
  };

  /** The signed-in user document, refreshed after every successful save. */
  let me = null;

  /**
   * Fire a toast when the overlay layer is present.
   * @param {string} message text to show
   * @param {'info'|'success'|'warn'|'error'} [kind='info'] tone
   * @param {number} [ms] lifetime, for messages that need longer to read
   * @returns {void}
   */
  function toast(message, kind, ms) {
    if (typeof ui.toast === 'function') ui.toast(message, kind || 'info', ms);
  }

  /**
   * Put a button into or out of its loading state.
   * @param {HTMLElement} button the control
   * @param {boolean} on whether work is running
   * @param {string} [label] text while busy
   * @returns {void}
   */
  function busy(button, on, label) {
    if (!button) return;
    if (typeof ui.setBusy === 'function') {
      ui.setBusy(button, on, label);
      return;
    }
    button.disabled = !!on;
  }

  /**
   * Write a short confirmation into one of the section status lines.
   * @param {HTMLElement} node the live region
   * @param {string} message text to announce
   * @returns {void}
   */
  function setStatus(node, message) {
    if (node) node.textContent = message;
  }

  /**
   * Mark a field as invalid.
   * @param {HTMLElement} field the .field wrapper
   * @param {HTMLElement} error the .field-error node
   * @param {string} message what is wrong
   * @param {HTMLElement} [input] control to flag with aria-invalid
   * @returns {void}
   */
  function setFieldError(field, error, message, input) {
    if (field) field.classList.add('has-error');
    if (error) error.textContent = message;
    if (input) input.setAttribute('aria-invalid', 'true');
  }

  /**
   * Clear a field's invalid state.
   * @param {HTMLElement} field the .field wrapper
   * @param {HTMLElement} error the .field-error node
   * @param {HTMLElement} [input] control to unflag
   * @returns {void}
   */
  function clearFieldError(field, error, input) {
    if (field) field.classList.remove('has-error');
    if (error) error.textContent = '';
    if (input) input.removeAttribute('aria-invalid');
  }

  /**
   * Persist a patch onto the signed-in user and keep the cached doc in step.
   * @param {Object} patch deep-merged into the user document
   * @returns {Promise<Object>} the updated UserDoc
   */
  async function saveUser(patch) {
    const updated = await ZC.store.updateUser(me.uid, patch);
    me = updated || me;
    // auth.js caches the doc for the nav and the guards; keep it honest.
    if (ZC.auth && typeof ZC.auth.refresh === 'function') {
      try {
        await ZC.auth.refresh();
      } catch (err) {
        console.warn('[zc] Settings saved but the cached profile did not refresh.', err);
      }
    }
    return me;
  }

  /* ------------------------------------------------------------------------
     3. Account
     ------------------------------------------------------------------------ */

  /**
   * Fill the account card from a user document.
   * @param {Object} doc UserDoc
   * @returns {void}
   */
  function fillAccount(doc) {
    dom.email.value = doc.email || '';
    dom.nameInput.value = doc.displayName || '';
    const premium = doc.plan === 'premium';
    dom.accountBadge.textContent = premium ? 'Premium (simulated)' : 'Free';
    dom.accountBadge.classList.toggle('badge-premium', premium);
  }

  /**
   * Validate and save the display name.
   * @param {Event} event the form submit
   * @returns {Promise<void>}
   */
  async function onSaveAccount(event) {
    event.preventDefault();
    clearFieldError(dom.nameField, dom.nameError, dom.nameInput);
    setStatus(dom.accountStatus, '');

    const name = dom.nameInput.value.trim();
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      setFieldError(dom.nameField, dom.nameError,
        'Use between ' + NAME_MIN + ' and ' + NAME_MAX + ' characters.', dom.nameInput);
      dom.nameInput.focus();
      return;
    }

    busy(dom.saveAccount, true, 'Saving…');
    try {
      await saveUser({ displayName: name });
      setStatus(dom.accountStatus, 'Saved.');
      toast('Display name updated.', 'success');
    } catch (err) {
      console.error('[zc] Could not save the account details:', err);
      toast('Could not save that. Please try again.', 'error');
    } finally {
      busy(dom.saveAccount, false);
    }
  }

  /* ------------------------------------------------------------------------
     4. Discovery preferences
     ------------------------------------------------------------------------ */

  /**
   * Every "show me" checkbox, in document order.
   * @returns {HTMLInputElement[]}
   */
  function genderBoxes() {
    return util.$$('input[data-gender]', dom.interestedField);
  }

  /**
   * The genders currently ticked.
   * @returns {string[]} slugs from GENDERS
   */
  function selectedGenders() {
    return genderBoxes()
      .filter(function (box) { return box.checked; })
      .map(function (box) { return box.dataset.gender; });
  }

  /**
   * Repaint the age-range read-out.
   * @returns {void}
   */
  function renderAgeValue() {
    const min = Number(dom.ageMin.value);
    const max = Number(dom.ageMax.value);
    dom.ageValue.textContent = min === max ? min + ' only' : min + ' to ' + max;
  }

  /**
   * Repaint the distance read-out, where the maximum means "anywhere".
   * @returns {void}
   */
  function renderDistanceValue() {
    const km = Number(dom.distance.value);
    dom.distanceValue.textContent = km >= DISTANCE_MAX ? 'Anywhere' : 'Up to ' + km + ' km away';
  }

  /**
   * Keep the two age handles from crossing: whichever one moved wins, the
   * other is pushed along in front of it.
   * @param {'min'|'max'} moved which handle the person dragged
   * @returns {void}
   */
  function clampAgeHandles(moved) {
    const min = Number(dom.ageMin.value);
    const max = Number(dom.ageMax.value);
    if (min <= max) return;
    if (moved === 'min') dom.ageMax.value = String(min);
    else dom.ageMin.value = String(max);
  }

  /**
   * A stored number, or the default when it is missing or unusable.
   * @param {*} value stored preference
   * @param {number} fallback value to use instead
   * @returns {number}
   */
  function numberOr(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  /**
   * Fill the discovery card from a user document.
   * @param {Object} doc UserDoc
   * @returns {void}
   */
  function fillDiscovery(doc) {
    const prefs = doc.preferences || {};
    const wanted = Array.isArray(prefs.interestedIn) && prefs.interestedIn.length
      ? prefs.interestedIn
      : GENDERS.slice();
    genderBoxes().forEach(function (box) {
      box.checked = wanted.indexOf(box.dataset.gender) !== -1;
    });

    const min = util.clamp(numberOr(prefs.ageMin, AGE_MIN), AGE_MIN, AGE_MAX);
    const max = util.clamp(numberOr(prefs.ageMax, AGE_MAX), AGE_MIN, AGE_MAX);
    dom.ageMin.value = String(Math.round(Math.min(min, max)));
    dom.ageMax.value = String(Math.round(Math.max(min, max)));
    renderAgeValue();

    dom.distance.value = String(Math.round(
      util.clamp(numberOr(prefs.maxDistanceKm, DISTANCE_MAX), DISTANCE_MIN, DISTANCE_MAX)
    ));
    renderDistanceValue();

    dom.discoverable.checked = prefs.discoverable !== false;
  }

  /**
   * Validate and save the discovery filters.
   * @param {Event} event the form submit
   * @returns {Promise<void>}
   */
  async function onSaveDiscovery(event) {
    event.preventDefault();
    clearFieldError(dom.interestedField, dom.interestedError);
    setStatus(dom.discoveryStatus, '');

    const interestedIn = selectedGenders();
    if (!interestedIn.length) {
      setFieldError(dom.interestedField, dom.interestedError,
        'Pick at least one — otherwise your deck has nobody in it.');
      genderBoxes()[0].focus();
      return;
    }

    const ageMin = Math.round(util.clamp(dom.ageMin.value, AGE_MIN, AGE_MAX));
    const ageMax = Math.round(util.clamp(dom.ageMax.value, AGE_MIN, AGE_MAX));

    busy(dom.saveDiscovery, true, 'Saving…');
    try {
      await saveUser({
        preferences: {
          interestedIn: interestedIn,
          ageMin: Math.min(ageMin, ageMax),
          ageMax: Math.max(ageMin, ageMax),
          maxDistanceKm: Math.round(util.clamp(dom.distance.value, DISTANCE_MIN, DISTANCE_MAX)),
          discoverable: !!dom.discoverable.checked
        }
      });
      setStatus(dom.discoveryStatus, 'Saved. Your deck reranks on its next load.');
      toast('Discovery preferences saved.', 'success');
    } catch (err) {
      console.error('[zc] Could not save the discovery preferences:', err);
      toast('Could not save those preferences. Please try again.', 'error');
    } finally {
      busy(dom.saveDiscovery, false);
    }
  }

  /* ------------------------------------------------------------------------
     5. Appearance and notifications
     ------------------------------------------------------------------------ */

  /**
   * Every theme radio on the page.
   * @returns {HTMLInputElement[]}
   */
  function themeRadios() {
    return util.$$('input[name="theme"]', dom.themeGroup);
  }

  /**
   * Tick the matching radio and mark its chip. The chip styling also works via
   * `:has()`, but the class keeps older engines correct.
   * @param {'system'|'light'|'dark'} value theme preference
   * @returns {void}
   */
  function markThemeChoice(value) {
    themeRadios().forEach(function (radio) {
      const on = radio.value === value;
      radio.checked = on;
      if (radio.parentNode && radio.parentNode.classList) {
        radio.parentNode.classList.toggle('is-selected', on);
      }
    });
  }

  /**
   * Apply a theme immediately, then persist it to the profile.
   * @param {'system'|'light'|'dark'} value theme preference
   * @returns {Promise<void>}
   */
  async function onThemeChange(value) {
    // Live first: the page must react before any storage round-trip.
    const applied = (ZC.app && typeof ZC.app.applyTheme === 'function')
      ? ZC.app.applyTheme(value)
      : value;
    markThemeChoice(applied);
    setStatus(dom.appearanceStatus, 'Theme set to ' + applied + '.');
    try {
      await saveUser({ preferences: { theme: applied } });
    } catch (err) {
      console.warn('[zc] Theme applied but not saved to the profile.', err);
      setStatus(dom.appearanceStatus, 'Theme applied in this browser, but it could not be saved to your profile.');
    }
  }

  /**
   * Persist the notifications toggle.
   * @param {boolean} enabled new state
   * @returns {Promise<void>}
   */
  async function onNotificationsChange(enabled) {
    setStatus(dom.appearanceStatus, enabled ? 'In-app notifications on.' : 'In-app notifications off.');
    try {
      await saveUser({ preferences: { notifications: !!enabled } });
    } catch (err) {
      console.error('[zc] Could not save the notification preference:', err);
      // Put the control back where the stored value says it should be.
      dom.notifications.checked = !enabled;
      toast('Could not save that preference. Please try again.', 'error');
    }
  }

  /* ------------------------------------------------------------------------
     6. Bring your own Firebase project
     ------------------------------------------------------------------------ */

  /**
   * Read the stored override, if this browser has one.
   * @returns {Object|null} parsed config or null
   */
  function readOverride() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(OVERRIDE_KEY);
    } catch (err) {
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Describe the mode this browser is in, and pre-fill the textarea with the
   * stored override so it can be edited rather than retyped.
   * @returns {void}
   */
  function renderFirebaseState() {
    const override = readOverride();
    const live = ZC.config || {};
    const projectId = (live.firebase && live.firebase.projectId) || '';

    if (live.mode === 'firebase') {
      dom.firebaseMode.textContent = 'Connected to the Firebase project “' + projectId + '”' +
        (override ? ', using the config saved in this browser.' : ', using the config baked into js/firebase-config.js.');
    } else if (override) {
      dom.firebaseMode.textContent =
        'A config is saved in this browser, but the app is still in demo mode — reload the page, and check the project details below if it stays in demo mode.';
    } else {
      dom.firebaseMode.textContent =
        'Demo mode: no Firebase project is configured, so accounts, swipes, matches and messages live in this browser only.';
    }

    if (override && !dom.firebaseInput.value) {
      dom.firebaseInput.value = JSON.stringify(override, null, 2);
    }
    dom.resetFirebase.disabled = !override;
  }

  /**
   * Validate a pasted config.
   * @param {string} text raw textarea contents
   * @returns {{ok:boolean, config?:Object, error?:string}}
   */
  function parseConfig(text) {
    const raw = String(text || '').trim();
    if (!raw) return { ok: false, error: 'Paste the config JSON from your Firebase console first.' };

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        error: 'That is not valid JSON. Every key and every value needs double quotes, and there can be no trailing comma — for example {"apiKey": "…", "projectId": "…"}.'
      };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'The config has to be a JSON object wrapped in { }.' };
    }

    // Required keys first, so the message names the one that is missing.
    const missing = REQUIRED_CONFIG_FIELDS.filter(function (key) {
      return typeof parsed[key] !== 'string' || !parsed[key].trim();
    });
    if (missing.length) {
      return { ok: false, error: 'Missing or empty: ' + missing.join(', ') + '.' };
    }
    if (PLACEHOLDER_RE.test(parsed.apiKey.trim())) {
      return { ok: false, error: 'That apiKey is still a placeholder. Copy the real one from your Firebase console.' };
    }
    if (parsed.projectId.trim().indexOf('your-') === 0) {
      return { ok: false, error: 'That projectId is still a placeholder. Copy the real one from your Firebase console.' };
    }

    // Keep only the fields the app uses, so nothing unexpected is stored.
    const config = {};
    REQUIRED_CONFIG_FIELDS.concat(OPTIONAL_CONFIG_FIELDS).forEach(function (key) {
      if (typeof parsed[key] === 'string' && parsed[key].trim()) config[key] = parsed[key].trim();
    });
    return { ok: true, config: config };
  }

  /**
   * Validate, store and reload with the pasted config.
   * @param {Event} event the form submit
   * @returns {void}
   */
  function onSaveFirebase(event) {
    event.preventDefault();
    clearFieldError(dom.firebaseField, dom.firebaseError, dom.firebaseInput);

    const result = parseConfig(dom.firebaseInput.value);
    if (!result.ok) {
      setFieldError(dom.firebaseField, dom.firebaseError, result.error, dom.firebaseInput);
      dom.firebaseInput.focus();
      return;
    }

    try {
      window.localStorage.setItem(OVERRIDE_KEY, JSON.stringify(result.config));
    } catch (err) {
      console.error('[zc] Could not store the Firebase config:', err);
      setFieldError(dom.firebaseField, dom.firebaseError,
        'This browser refused to save the config — storage may be full or blocked.', dom.firebaseInput);
      return;
    }

    toast('Config saved. Reloading to connect to “' + result.config.projectId + '”…', 'success');
    busy(dom.saveFirebase, true, 'Reloading…');
    // A page reload is the only way to re-run firebase-config.js.
    window.setTimeout(function () { window.location.reload(); }, 700);
  }

  /**
   * Drop the stored config and go back to demo mode.
   * @returns {Promise<void>}
   */
  async function onResetFirebase() {
    if (!readOverride()) {
      toast('There is no saved config in this browser.', 'info');
      return;
    }
    const ok = typeof ui.confirm === 'function'
      ? await ui.confirm(
        'This removes the Firebase config saved in this browser and reloads the app in demo mode.\nYour Firebase project is untouched — nothing is deleted from it — but anything created while in demo mode stays in this browser only.',
        { title: 'Go back to demo mode?', confirmLabel: 'Reset and reload', variant: 'danger' }
      )
      : true;
    if (!ok) return;

    try {
      window.localStorage.removeItem(OVERRIDE_KEY);
    } catch (err) {
      console.warn('[zc] Could not clear the Firebase config.', err);
    }
    dom.firebaseInput.value = '';
    toast('Config cleared. Reloading in demo mode…', 'success');
    busy(dom.resetFirebase, true, 'Reloading…');
    window.setTimeout(function () { window.location.reload(); }, 700);
  }

  /* ------------------------------------------------------------------------
     7. Your reports
     ------------------------------------------------------------------------ */

  /**
   * The human label for a report reason slug, from the store's closed list.
   * @param {string} slug reason slug as stored on the report
   * @returns {string} the UI label, or a neutral fallback for unknown slugs
   */
  function reasonLabel(slug) {
    const reasons = (ZC.store && ZC.store.REPORT_REASONS) || [];
    for (let i = 0; i < reasons.length; i += 1) {
      if (reasons[i].slug === slug) return reasons[i].label;
    }
    return 'Reported';
  }

  /**
   * Build one list row for a filed report: who, why, when, and the button
   * that takes it back. Every string here is user-authored or derived from
   * user input, so it all goes through el({text}).
   * @param {Object} report ReportDoc
   * @param {string} name the subject's display name (already resolved)
   * @returns {HTMLElement} the <li>
   */
  function reportRow(report, name) {
    const meta = reasonLabel(report.reason) + ' · ' + (util.timeAgo(report.createdAt) || 'some time ago');
    const body = util.el('div', { class: 'stack stack-sm' }, [
      util.el('strong', { text: name }),
      util.el('p', { class: 'field-hint', text: meta })
    ]);
    if (report.details) {
      body.appendChild(util.el('p', { class: 'field-hint text-muted', text: '“' + report.details + '”' }));
    }
    const button = util.el('button', {
      class: 'btn btn-sm btn-ghost',
      text: 'Retract',
      attrs: { type: 'button' },
      on: { click: function () { onRetractReport(report, name, button); } }
    });
    return util.el('li', { class: 'spread' }, [body, button]);
  }

  /**
   * Paint the reports list from resolved data. The empty state is a sentence,
   * never a blank hole.
   * @param {Object[]} reports ReportDocs, newest first
   * @param {Array<Object|null>} subjects public profile (or null) per report
   * @returns {void}
   */
  function renderReports(reports, subjects) {
    dom.reportsList.textContent = '';
    if (!reports.length) {
      dom.reportsList.classList.add('hidden');
      setStatus(dom.reportsStatus, 'You have not reported anyone.');
      return;
    }
    setStatus(dom.reportsStatus, '');
    dom.reportsList.classList.remove('hidden');
    reports.forEach(function (report, index) {
      const subject = subjects[index];
      // A missing subject is expected: deleted accounts keep their reports.
      const name = (subject && subject.displayName) || 'a deleted account';
      dom.reportsList.appendChild(reportRow(report, name));
    });
  }

  /**
   * Load the reports this account has filed and resolve each subject's public
   * name, then paint the panel. Called on boot and after every retraction.
   * @returns {Promise<void>}
   */
  async function loadReports() {
    setStatus(dom.reportsStatus, 'Loading your reports…');
    try {
      const reports = await ZC.store.getMyReports(me.uid);
      const subjects = await Promise.all(reports.map(function (report) {
        return ZC.store.getPublicProfile(report.about).catch(function () { return null; });
      }));
      renderReports(reports, subjects);
    } catch (err) {
      console.error('[zc] Could not load your reports:', err);
      setStatus(dom.reportsStatus, 'Could not load your reports. Reload the page to try again.');
    }
  }

  /**
   * Confirm, retract one report, then repaint the panel.
   * @param {Object} report the ReportDoc being withdrawn
   * @param {string} name the subject's resolved display name
   * @param {HTMLElement} button the row's Retract control
   * @returns {Promise<void>}
   */
  async function onRetractReport(report, name, button) {
    const ok = typeof ui.confirm === 'function'
      ? await ui.confirm(
        'Retract your report about ' + name + '? The project owner will no longer see it.',
        { title: 'Retract this report?', confirmLabel: 'Retract it', variant: 'danger' }
      )
      : true;
    if (!ok) return;

    busy(button, true, 'Retracting…');
    try {
      const result = await ZC.store.retractReport(me.uid, report.about);
      toast(result.removed ? 'Report retracted.' : 'That report had already been removed.', 'success');
    } catch (err) {
      console.error('[zc] Could not retract the report:', err);
      toast('Could not retract that report. Please try again.', 'error');
    } finally {
      busy(button, false);
    }
    await loadReports();
  }

  /* ------------------------------------------------------------------------
     8. Export
     ------------------------------------------------------------------------ */

  /**
   * Hand a JSON string to the browser as a download.
   * @param {string} filename suggested file name
   * @param {string} text file contents
   * @returns {void}
   */
  function downloadJson(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const href = window.URL.createObjectURL(blob);
    const link = util.el('a', { class: 'hidden', attrs: { href: href, download: filename } });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Give the download a moment to start before the blob goes away.
    window.setTimeout(function () { window.URL.revokeObjectURL(href); }, 4000);
  }

  /**
   * Build the export payload: everything of yours, and only a name and an id
   * for the people you matched with.
   * @param {string} uid the account being exported
   * @returns {Promise<Object>} JSON-serialisable export
   */
  async function collectExport(uid) {
    const [swipes, matches] = await Promise.all([
      ZC.store.getSwipes(uid),
      ZC.store.getMatches(uid)
    ]);

    const conversations = [];
    for (let i = 0; i < matches.length; i += 1) {
      const view = matches[i];
      let messages = [];
      try {
        messages = await ZC.store.getMessages(view.matchId, { limit: EXPORT_MESSAGE_LIMIT });
      } catch (err) {
        console.warn('[zc] Could not read one conversation for the export.', err);
      }
      conversations.push({
        matchId: view.matchId,
        with: { uid: view.otherUid, displayName: (view.other && view.other.displayName) || '' },
        matchedAt: view.createdAt || null,
        messages: messages
      });
    }

    return {
      app: 'zero-cost-ai-dating',
      version: (ZC.config && ZC.config.version) || '1.0.0',
      storage: ZC.store.mode,
      exportedAt: new Date().toISOString(),
      account: me,
      swipes: swipes,
      conversations: conversations
    };
  }

  /**
   * Build and download the export file.
   * @returns {Promise<void>}
   */
  async function onExport() {
    busy(dom.exportData, true, 'Gathering…');
    try {
      const payload = await collectExport(me.uid);
      downloadJson('zero-cost-ai-dating-' + util.todayKey() + '.json', JSON.stringify(payload, null, 2));
      toast('Export downloaded.', 'success');
    } catch (err) {
      console.error('[zc] Export failed:', err);
      toast('Could not build the export. Please try again.', 'error');
    } finally {
      busy(dom.exportData, false);
    }
  }

  /* ------------------------------------------------------------------------
     9. Demo reset
     ------------------------------------------------------------------------ */

  /**
   * Wipe and re-seed the demo database, then reload so every page is looking
   * at the same data again.
   * @returns {Promise<void>}
   */
  async function onResetDemo() {
    const ok = typeof ui.confirm === 'function'
      ? await ui.confirm(
        'This wipes the demo database in this browser and seeds the bundled sample profiles again.\nYour swipes, matches and messages are deleted. Accounts you created stay signed up, but their profile data is rebuilt from the seed.',
        { title: 'Reset the demo data?', confirmLabel: 'Reset it', variant: 'danger' }
      )
      : true;
    if (!ok) return;

    busy(dom.resetDemo, true, 'Resetting…');
    try {
      await ZC.store.resetDemo();
      toast('Demo data reset. Reloading…', 'success');
      window.setTimeout(function () { window.location.reload(); }, 700);
    } catch (err) {
      console.error('[zc] Could not reset the demo data:', err);
      busy(dom.resetDemo, false);
      toast('Could not reset the demo data.', 'error');
    }
  }

  /* ------------------------------------------------------------------------
     10. Account deletion

     ZC.store has no "delete this user" method — nothing else in the app needs
     one — so the last step reaches past the facade on purpose: localStorage in
     demo mode, the users collection in Firebase mode. Everything before it
     (swipes, matches, conversations) goes through the store as normal.
     ------------------------------------------------------------------------ */

  /**
   * Read a JSON map out of localStorage, tolerating corrupt entries.
   * @param {string} key storage key
   * @returns {Object} the map, or an empty object
   */
  function readMap(key) {
    let raw = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch (err) {
      return {};
    }
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  /**
   * Store a JSON map, reporting failure to the caller.
   * @param {string} key storage key
   * @param {Object} value the map
   * @returns {boolean} true when it landed
   */
  function writeMap(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn('[zc] Could not write ' + key + ' while deleting the account.', err);
      return false;
    }
  }

  /**
   * Drop a demo account's saved credentials. The account's data itself is
   * removed by ZC.store.deleteAccountData; the credential vault is auth's
   * private key-by-email map, so it is cleared separately here.
   * @param {string} email the address the credentials are keyed by
   * @returns {void}
   */
  function removeDemoCredentials(email) {
    const address = String(email || '').trim().toLowerCase();
    if (!address) return;
    const credentials = readMap(CREDENTIALS_KEY);
    if (credentials[address]) {
      delete credentials[address];
      writeMap(CREDENTIALS_KEY, credentials);
    }
  }

  /**
   * Ask for the account password and reauthenticate a stale Firebase session
   * so it becomes fresh enough to delete itself. Google sign-ins reauth via
   * the provider popup instead.
   * @param {Object} account firebase.auth().currentUser
   * @returns {Promise<boolean>} true when reauthentication succeeded
   */
  async function reauthenticateForDeletion(account) {
    const providers = Array.isArray(account.providerData) ? account.providerData : [];
    const usesPassword = providers.some(function (p) { return p && p.providerId === 'password'; });

    if (!usesPassword) {
      // Google (or any popup provider): re-run the provider flow.
      try {
        await account.reauthenticateWithPopup(new firebase.auth.GoogleAuthProvider());
        return true;
      } catch (err) {
        console.warn('[zc] Reauthentication popup failed.', err);
        return false;
      }
    }

    // Email/password: collect the password in a modal and reauthenticate.
    let password = '';
    const input = ZC.util.el('input', {
      class: 'input',
      attrs: { type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password' },
      on: { input: function (event) { password = event.target.value; } }
    });
    const body = ZC.util.el('div', { class: 'stack stack-sm' }, [
      ZC.util.el('p', { text: 'Deleting an account needs a recent sign-in. Enter your password to continue.' }),
      input
    ]);
    const choice = await ZC.ui.modal({
      title: 'Confirm it’s you',
      body: body,
      actions: [
        { id: 'cancel', label: 'Cancel', variant: 'ghost' },
        { id: 'confirm', label: 'Continue', variant: 'danger' }
      ]
    });
    if (choice !== 'confirm' || !password) return false;
    try {
      const credential = firebase.auth.EmailAuthProvider.credential(account.email, password);
      await account.reauthenticateWithCredential(credential);
      return true;
    } catch (err) {
      console.warn('[zc] Reauthentication failed.', err);
      return false;
    }
  }

  /**
   * Delete the Firebase sign-in itself, reauthenticating first if the session
   * is too old. Throws when the login could not be removed, so the caller
   * never reports a deletion that did not fully happen.
   * @returns {Promise<void>}
   */
  async function deleteFirebaseSignIn() {
    const handles = ZC.firebase;
    const account = handles && handles.auth && handles.auth.currentUser;
    if (!account || typeof account.delete !== 'function') return;
    try {
      await account.delete();
    } catch (err) {
      if (!err || err.code !== 'auth/requires-recent-login') throw err;
      const fresh = await reauthenticateForDeletion(account);
      if (!fresh) {
        const abort = new Error('Reauthentication was cancelled or failed.');
        abort.code = 'auth/requires-recent-login';
        throw abort;
      }
      await account.delete();
    }
  }

  /**
   * Delete the account and everything attached to it, then sign out.
   * @returns {Promise<void>}
   */
  async function onDeleteAccount() {
    if (dom.deleteInput.value.trim().toUpperCase() !== DELETE_PHRASE) {
      setFieldError(dom.deleteField, dom.deleteError,
        'Type ' + DELETE_PHRASE + ' exactly to confirm.', dom.deleteInput);
      dom.deleteInput.focus();
      return;
    }

    const uid = me.uid;
    const email = me.email;
    busy(dom.deleteButton, true, 'Deleting…');
    let dataGone = false;
    try {
      // 1. Every stored trace of the account: swipes in both directions,
      //    matches with their messages, the discovery projection and the
      //    account document.
      await ZC.store.deleteAccountData(uid);
      dataGone = true;

      // 2. The sign-in itself. In firebase mode this reauthenticates a stale
      //    session first and throws if the login could not be removed — the
      //    flow never claims success while the identity is still usable.
      if (ZC.store.mode === 'firebase') await deleteFirebaseSignIn();
      else removeDemoCredentials(email);

      // 3. End the session and leave.
      if (ZC.auth && typeof ZC.auth.signOut === 'function') {
        try {
          await ZC.auth.signOut();
        } catch (err) {
          console.warn('[zc] Account deleted but sign-out complained.', err);
        }
      }
      toast('Your account and its data have been deleted.', 'success');
      const home = (ZC.app && typeof ZC.app.url === 'function') ? ZC.app.url('index.html') : 'index.html';
      window.location.replace(home);
    } catch (err) {
      console.error('[zc] Account deletion failed:', err);
      busy(dom.deleteButton, false);
      if (dataGone) {
        // The data was removed but the sign-in survives; be precise about it.
        setFieldError(dom.deleteField, dom.deleteError,
          'Your data was deleted, but the sign-in itself was not. Sign in again and repeat “Delete account” to finish.',
          dom.deleteInput);
        toast('Data deleted, but the sign-in remains. Sign in again to finish.', 'warn', 8000);
      } else {
        setFieldError(dom.deleteField, dom.deleteError,
          'Deletion did not finish. Nothing else was changed — please try again.', dom.deleteInput);
        toast('Could not delete the account.', 'error');
      }
    }
  }

  /* ------------------------------------------------------------------------
     11. Wiring
     ------------------------------------------------------------------------ */

  /**
   * Attach every handler on the page. Called once, after the user document is
   * loaded, so no control can be used before it has a value.
   * @returns {void}
   */
  function wire() {
    dom.accountForm.addEventListener('submit', onSaveAccount);
    dom.nameInput.addEventListener('input', function () {
      clearFieldError(dom.nameField, dom.nameError, dom.nameInput);
      setStatus(dom.accountStatus, '');
    });

    dom.discoveryForm.addEventListener('submit', onSaveDiscovery);
    genderBoxes().forEach(function (box) {
      box.addEventListener('change', function () {
        clearFieldError(dom.interestedField, dom.interestedError);
        setStatus(dom.discoveryStatus, '');
      });
    });
    dom.ageMin.addEventListener('input', function () {
      clampAgeHandles('min');
      renderAgeValue();
    });
    dom.ageMax.addEventListener('input', function () {
      clampAgeHandles('max');
      renderAgeValue();
    });
    dom.distance.addEventListener('input', renderDistanceValue);

    themeRadios().forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (radio.checked) onThemeChange(radio.value);
      });
    });
    dom.notifications.addEventListener('change', function () {
      onNotificationsChange(dom.notifications.checked);
    });

    dom.firebaseForm.addEventListener('submit', onSaveFirebase);
    dom.resetFirebase.addEventListener('click', onResetFirebase);
    dom.firebaseInput.addEventListener('input', function () {
      clearFieldError(dom.firebaseField, dom.firebaseError, dom.firebaseInput);
    });

    // The reports list is a plain semantic <ul> with no dedicated CSS class,
    // so the marker comes off here via CSSOM (the CSP forbids style="...").
    dom.reportsList.style.setProperty('list-style', 'none');

    dom.exportData.addEventListener('click', onExport);
    dom.resetDemo.addEventListener('click', onResetDemo);

    // The delete button unlocks only once the confirmation phrase is exact.
    dom.deleteInput.addEventListener('input', function () {
      clearFieldError(dom.deleteField, dom.deleteError, dom.deleteInput);
      dom.deleteButton.disabled = dom.deleteInput.value.trim().toUpperCase() !== DELETE_PHRASE;
    });
    dom.deleteButton.addEventListener('click', onDeleteAccount);
  }

  /**
   * Paint every section from the user document.
   * @param {Object} doc UserDoc
   * @returns {void}
   */
  function render(doc) {
    fillAccount(doc);
    fillDiscovery(doc);
    markThemeChoice((doc.preferences && doc.preferences.theme) || 'system');
    dom.notifications.checked = !(doc.preferences && doc.preferences.notifications === false);
    renderFirebaseState();

    // Mode-specific affordances: the demo reset only exists in demo mode, and
    // the sign-out hint should not promise more than the backend can do.
    const demo = ZC.store.mode !== 'firebase';
    dom.demoTools.classList.toggle('hidden', !demo);
    dom.signoutHint.textContent = demo
      ? 'Ends the demo session in this browser. Your account and its data stay where they are.'
      : 'Ends the session in this browser. Firebase sessions on other devices are not revoked — that needs a server, and this app does not have one.';
  }

  /**
   * Start the page: require an account, then fill and wire the forms.
   * @returns {Promise<void>}
   */
  async function boot() {
    if (!ZC.auth || typeof ZC.auth.requireAuth !== 'function' || !ZC.store) {
      console.error('[zc] settings.js needs auth.js and data-store.js.');
      toast('The app scripts did not all load. Try reloading the page.', 'error');
      return;
    }
    try {
      // Redirects (and never resolves) when signed out.
      const doc = await ZC.auth.requireAuth();
      if (!doc) return;
      me = doc;
      render(me);
      wire();
      // Async on purpose: the rest of the page must not wait on this list,
      // and loadReports handles its own failures.
      loadReports();
    } catch (err) {
      console.error('[zc] Settings could not start:', err);
      toast('Could not load your settings. Please reload the page.', 'error');
    }
  }

  // app.js resolves this once the DOM and the first auth state are settled.
  if (ZC.app && typeof ZC.app.onReady === 'function') {
    ZC.app.onReady(function () { return boot(); });
  } else {
    boot();
  }
})();
