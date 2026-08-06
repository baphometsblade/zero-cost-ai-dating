/* ==========================================================================
   Zero Cost AI Dating — profile editor
   Everything the matching engine reads about you, edited in one place: name,
   birthdate (with the 18+ guard), bio, interest chips, the five personality
   sliders, an optional location, photo links and the visibility toggles.
   The page keeps a live completeness meter and a live copy of the card other
   people swipe on, and it refuses to lose your work: edits are guarded by
   beforeunload until they are saved.
   Page script for profile.html. Adds nothing to ZC beyond ZC.profile.
   ========================================================================== */
(function () {
  'use strict';

  window.ZC = window.ZC || {};
  const ZC = window.ZC;

  // Tolerate a duplicated <script> tag.
  if (ZC.profile && ZC.profile.mounted) return;

  // utils.js and data-store.js load before this file on every page. Without
  // them there is no editor to build, and saying so beats a half-drawn form.
  if (!ZC.util || typeof ZC.util.el !== 'function' || !ZC.store) {
    console.error('[zc.profile] profile.js needs js/utils.js and js/data-store.js first.');
    return;
  }

  const util = ZC.util;
  const el = util.el;

  /* ------------------------------------------------------------------------
     1. Constants
     ------------------------------------------------------------------------ */

  const NAME_MIN = 2;
  const NAME_MAX = 40;
  const BIO_MAX = 500;
  const BIO_GOOD = 40;
  const PRONOUN_MAX = 40;
  const LABEL_MAX = 60;
  const MAX_INTERESTS = 12;
  const MIN_INTERESTS = 3;
  const MAX_PHOTOS = 6;
  const MIN_AGE = 18;
  const MAX_AGE = 120;
  const PREVIEW_TAGS = 6;

  // Two columns only when there is genuinely room for the form and the card.
  const WIDE_QUERY = '(min-width: 1000px)';

  const GENDERS = { woman: 'Woman', man: 'Man', nonbinary: 'Non-binary', other: 'Something else' };

  // The five axes, in the order they appear in the form. `key` matches both
  // the input ids in profile.html and the UserDoc personality fields.
  const AXES = [
    { key: 'openness', label: 'Openness' },
    { key: 'conscientiousness', label: 'Reliability' },
    { key: 'extraversion', label: 'Social energy' },
    { key: 'agreeableness', label: 'Warmth' },
    { key: 'stability', label: 'Emotional steadiness' }
  ];

  // Friendly names for the interest categories defined in seed-data.js.
  const CATEGORY_LABELS = {
    outdoors: 'Outdoors',
    arts: 'Arts and culture',
    food: 'Food and drink',
    music: 'Music',
    fitness: 'Fitness',
    tech: 'Tech and science',
    travel: 'Travel',
    homebody: 'Homebody',
    social: 'Social',
    mindful: 'Mindful'
  };

  // A small bundled gazetteer — enough to place everyone in the seed data plus
  // a spread of other cities. Approximate city-centre coordinates only: this
  // app never stores a precise position.
  const CITIES = [
    { label: 'Portland, OR', lat: 45.5152, lng: -122.6784 },
    { label: 'Vancouver, WA', lat: 45.6387, lng: -122.6615 },
    { label: 'Seattle, WA', lat: 47.6062, lng: -122.3321 },
    { label: 'San Francisco, CA', lat: 37.7749, lng: -122.4194 },
    { label: 'Oakland, CA', lat: 37.8044, lng: -122.2712 },
    { label: 'Los Angeles, CA', lat: 34.0522, lng: -118.2437 },
    { label: 'San Diego, CA', lat: 32.7157, lng: -117.1611 },
    { label: 'Denver, CO', lat: 39.7392, lng: -104.9903 },
    { label: 'Austin, TX', lat: 30.2672, lng: -97.7431 },
    { label: 'Chicago, IL', lat: 41.8781, lng: -87.6298 },
    { label: 'Minneapolis, MN', lat: 44.9778, lng: -93.265 },
    { label: 'Atlanta, GA', lat: 33.749, lng: -84.388 },
    { label: 'Brooklyn, NY', lat: 40.6782, lng: -73.9442 },
    { label: 'New York, NY', lat: 40.7128, lng: -74.006 },
    { label: 'Boston, MA', lat: 42.3601, lng: -71.0589 },
    { label: 'Philadelphia, PA', lat: 39.9526, lng: -75.1652 },
    { label: 'Miami, FL', lat: 25.7617, lng: -80.1918 },
    { label: 'Mexico City, MX', lat: 19.4326, lng: -99.1332 },
    { label: 'Toronto, ON', lat: 43.6532, lng: -79.3832 },
    { label: 'Vancouver, BC', lat: 49.2827, lng: -123.1207 },
    { label: 'London, UK', lat: 51.5074, lng: -0.1278 },
    { label: 'Manchester, UK', lat: 53.4808, lng: -2.2426 },
    { label: 'Dublin, IE', lat: 53.3498, lng: -6.2603 },
    { label: 'Paris, FR', lat: 48.8566, lng: 2.3522 },
    { label: 'Berlin, DE', lat: 52.52, lng: 13.405 },
    { label: 'Amsterdam, NL', lat: 52.3676, lng: 4.9041 },
    { label: 'Barcelona, ES', lat: 41.3874, lng: 2.1686 },
    { label: 'Lisbon, PT', lat: 38.7223, lng: -9.1393 },
    { label: 'Stockholm, SE', lat: 59.3293, lng: 18.0686 },
    { label: 'Lagos, NG', lat: 6.5244, lng: 3.3792 },
    { label: 'Nairobi, KE', lat: -1.2921, lng: 36.8219 },
    { label: 'Cape Town, ZA', lat: -33.9249, lng: 18.4241 },
    { label: 'Mumbai, IN', lat: 19.076, lng: 72.8777 },
    { label: 'Bengaluru, IN', lat: 12.9716, lng: 77.5946 },
    { label: 'Singapore, SG', lat: 1.3521, lng: 103.8198 },
    { label: 'Seoul, KR', lat: 37.5665, lng: 126.978 },
    { label: 'Tokyo, JP', lat: 35.6762, lng: 139.6503 },
    { label: 'Sydney, AU', lat: -33.8688, lng: 151.2093 },
    { label: 'Melbourne, AU', lat: -37.8136, lng: 144.9631 },
    { label: 'Auckland, NZ', lat: -36.8485, lng: 174.7633 },
    { label: 'São Paulo, BR', lat: -23.5505, lng: -46.6333 },
    { label: 'Buenos Aires, AR', lat: -34.6037, lng: -58.3816 }
  ];

  // The completeness meter. Weights add up to 100; every entry doubles as the
  // "next thing to do" hint, so the copy has to read as an instruction.
  const COMPLETENESS = [
    { weight: 10, label: 'a display name', test: function (s) { return s.displayName.trim().length >= NAME_MIN; } },
    { weight: 15, label: 'your birthdate', test: function (s) { return isAdult(s.birthdate); } },
    { weight: 5, label: 'your pronouns', test: function (s) { return s.pronouns.trim().length > 0; } },
    { weight: 20, label: 'a bio of at least ' + BIO_GOOD + ' characters', test: function (s) { return s.bio.trim().length >= BIO_GOOD; } },
    { weight: 15, label: 'at least ' + MIN_INTERESTS + ' interests', test: function (s) { return s.interests.length >= MIN_INTERESTS; } },
    { weight: 10, label: 'a move on the personality sliders', test: function (s) { return AXES.some(function (axis) { return s.personality[axis.key] !== 50; }); } },
    { weight: 15, label: 'a location', test: function (s) { return !!s.coords; } },
    { weight: 10, label: 'a photo link', test: function (s) { return s.photos.length > 0; } }
  ];

  // Fields that can show an inline error, in the order we focus them.
  const ERROR_FIELDS = {
    name: { field: 'field-name', error: 'error-name', input: 'input-name' },
    birthdate: { field: 'field-birthdate', error: 'error-birthdate', input: 'input-birthdate' },
    pronouns: { field: 'field-pronouns', error: 'error-pronouns', input: 'input-pronouns' },
    bio: { field: 'field-bio', error: 'error-bio', input: 'input-bio' },
    interests: { field: 'field-interests', error: 'error-interests', input: null },
    location: { field: 'field-location', error: 'error-location', input: 'input-location' },
    photo: { field: 'field-photo', error: 'error-photo', input: 'input-photo' }
  };
  const ERROR_ORDER = ['name', 'birthdate', 'pronouns', 'bio', 'interests', 'location', 'photo'];

  /* ------------------------------------------------------------------------
     2. Small helpers
     ------------------------------------------------------------------------ */

  function id(name) {
    return document.getElementById(name);
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function toast(message, kind) {
    if (ZC.ui && typeof ZC.ui.toast === 'function') ZC.ui.toast(message, kind || 'info');
  }

  function setBusy(button, busy, label) {
    if (ZC.ui && typeof ZC.ui.setBusy === 'function') ZC.ui.setBusy(button, busy, label);
  }

  /**
   * Join a short list into English prose: 'a', 'a and b', 'a, b and c'.
   * @param {string[]} items phrases to join
   * @returns {string}
   */
  function joinList(items) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return '';
    if (list.length === 1) return list[0];
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  /**
   * Is this birthdate a real date that makes the owner 18 or over?
   * @param {string} value 'YYYY-MM-DD'
   * @returns {boolean}
   */
  function isAdult(value) {
    const age = value ? util.ageFromBirthdate(value) : null;
    return age !== null && age >= MIN_AGE && age <= MAX_AGE;
  }

  /**
   * 'YYYY-MM-DD' for a date this many years before today — used for the
   * birthdate input's min/max, which would otherwise rot in the markup.
   * @param {number} years how far back to go
   * @returns {string}
   */
  function isoYearsAgo(years) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return d.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
  }

  /**
   * Human coordinates, e.g. '45.52°N, 122.68°W'.
   * @param {number} lat latitude
   * @param {number} lng longitude
   * @returns {string}
   */
  function formatCoords(lat, lng) {
    return Math.abs(lat).toFixed(2) + '°' + (lat >= 0 ? 'N' : 'S') + ', ' +
      Math.abs(lng).toFixed(2) + '°' + (lng >= 0 ? 'E' : 'W');
  }

  /**
   * The closest bundled city to a point.
   * @param {number} lat latitude
   * @param {number} lng longitude
   * @returns {{city: Object, km: number}|null}
   */
  function nearestCity(lat, lng) {
    let best = null;
    CITIES.forEach(function (city) {
      const km = util.haversineKm({ lat: lat, lng: lng }, { lat: city.lat, lng: city.lng });
      if (km === null) return;
      if (!best || km < best.km) best = { city: city, km: km };
    });
    return best;
  }

  /* ------------------------------------------------------------------------
     3. Element references
     ------------------------------------------------------------------------ */

  const refs = {
    loading: id('profile-loading'),
    error: id('profile-error'),
    errorText: id('profile-error-text'),
    retry: id('retry-btn'),
    main: id('profile-main'),
    layout: id('profile-layout'),
    previewPane: id('preview-pane'),

    pageTitle: id('page-title'),
    pageSub: id('page-sub'),
    onboardingPill: id('onboarding-pill'),
    onboardingHead: id('onboarding-head'),

    heroPhoto: id('hero-photo'),
    heroName: id('hero-name'),
    heroMeta: id('hero-meta'),
    heroBadge: id('hero-badge'),
    completenessBar: id('completeness-bar'),
    completenessFill: id('completeness-fill'),
    completenessLabel: id('completeness-label'),
    completenessHint: id('completeness-hint'),

    form: id('profile-form'),
    name: id('input-name'),
    birthdate: id('input-birthdate'),
    gender: id('input-gender'),
    pronouns: id('input-pronouns'),
    bio: id('input-bio'),
    bioCount: id('bio-count'),

    interestGroups: id('interest-groups'),
    interestCount: id('interest-count'),
    interestBadge: id('interest-badge'),

    city: id('select-city'),
    location: id('input-location'),
    locationStatus: id('location-status'),
    locate: id('btn-locate'),
    clearLocation: id('btn-clear-location'),

    photoGrid: id('photo-grid'),
    photoInput: id('input-photo'),
    photoAdd: id('btn-add-photo'),
    photoAddRow: id('photo-add-row'),
    photoBadge: id('photo-badge'),

    showAge: id('toggle-show-age'),
    showDistance: id('toggle-show-distance'),

    saveStatus: id('save-status'),
    save: id('save-btn'),
    discard: id('discard-btn'),
    start: id('start-btn'),

    previewPhoto: id('preview-photo'),
    previewName: id('preview-name'),
    previewAge: id('preview-age'),
    previewMeta: id('preview-meta'),
    previewBio: id('preview-bio'),
    previewTags: id('preview-tags')
  };

  // Nothing to do unless we are actually on profile.html.
  if (!refs.form || !refs.main) return;

  /* ------------------------------------------------------------------------
     4. State
     ------------------------------------------------------------------------ */

  const state = {
    uid: '',
    doc: null,
    displayName: '',
    birthdate: '',
    gender: 'other',
    pronouns: '',
    bio: '',
    interests: [],
    personality: { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, stability: 50 },
    coords: null,
    locationLabel: '',
    photos: [],
    showAge: true,
    showDistance: true,
    dirty: false
  };

  const chipInputs = {};
  const chipLabels = {};
  let tagOrder = [];
  let baseline = '';
  let savedText = 'Everything here is saved.';
  let saving = false;
  let leaving = false;
  const onboarding = util.qs('onboarding') === '1';

  /**
   * A stable string of everything the Save button would write. Comparing it
   * with the copy taken at load is all the unsaved-changes tracking we need.
   * @returns {string}
   */
  function snapshot() {
    return JSON.stringify({
      displayName: state.displayName.trim(),
      birthdate: state.birthdate,
      gender: state.gender,
      pronouns: state.pronouns.trim(),
      bio: state.bio.trim(),
      interests: state.interests,
      personality: state.personality,
      coords: state.coords,
      locationLabel: state.locationLabel.trim(),
      photos: state.photos,
      showAge: state.showAge,
      showDistance: state.showDistance
    });
  }

  /**
   * Recompute the unsaved-changes flag and reflect it in the save bar.
   * @returns {void}
   */
  function markDirty() {
    state.dirty = snapshot() !== baseline;
    const text = state.dirty ? 'Unsaved changes.' : savedText;
    // Only write when it actually changed: this is a live region, and it runs
    // on every keystroke.
    if (refs.saveStatus.textContent !== text) refs.saveStatus.textContent = text;
    refs.discard.disabled = !state.dirty;
  }

  /* ------------------------------------------------------------------------
     5. Reading the user document into the form
     ------------------------------------------------------------------------ */

  /**
   * Copy a UserDoc into the editor's state, dropping anything that no longer
   * matches the contract (unknown interest slugs, non-https photos).
   * @param {Object} doc UserDoc
   * @returns {void}
   */
  function readDoc(doc) {
    const user = doc || {};
    const profile = user.profile || {};
    const personality = profile.personality || {};
    const known = ZC.INTEREST_BY_SLUG || {};

    state.doc = user;
    state.uid = user.uid || state.uid;
    state.displayName = String(user.displayName || '');
    state.birthdate = typeof profile.birthdate === 'string' ? profile.birthdate : '';
    state.gender = GENDERS[profile.gender] ? profile.gender : 'other';
    state.pronouns = String(profile.pronouns || '');
    state.bio = String(profile.bio || '').slice(0, BIO_MAX);

    state.interests = (Array.isArray(profile.interests) ? profile.interests : [])
      .filter(function (slug) { return typeof slug === 'string' && known[slug]; })
      .slice(0, MAX_INTERESTS);

    AXES.forEach(function (axis) {
      const raw = Number(personality[axis.key]);
      // A missing axis means "no opinion", which is the middle, not zero.
      state.personality[axis.key] = isFinite(raw) ? Math.round(util.clamp(raw, 0, 100)) : 50;
    });

    const location = profile.location;
    if (location && isFinite(Number(location.lat)) && isFinite(Number(location.lng))) {
      state.coords = { lat: Number(location.lat), lng: Number(location.lng) };
      state.locationLabel = String(location.label || '');
    } else {
      state.coords = null;
      state.locationLabel = '';
    }

    state.photos = (Array.isArray(profile.photos) ? profile.photos : [])
      .map(function (url) { return typeof url === 'string' ? url.trim() : ''; })
      .filter(function (url) { return /^https:\/\//i.test(url); })
      .slice(0, MAX_PHOTOS);

    state.showAge = profile.showAge !== false;
    state.showDistance = profile.showDistance !== false;
  }

  /**
   * Write the state into every control. Used on load and on discard.
   * @returns {void}
   */
  function paintForm() {
    refs.name.value = state.displayName;
    refs.birthdate.value = state.birthdate;
    refs.gender.value = state.gender;
    refs.pronouns.value = state.pronouns;
    refs.bio.value = state.bio;
    refs.location.value = state.locationLabel;
    refs.showAge.checked = state.showAge;
    refs.showDistance.checked = state.showDistance;

    AXES.forEach(function (axis) {
      const slider = id('range-' + axis.key);
      if (slider) slider.value = String(state.personality[axis.key]);
    });

    tagOrder.forEach(function (slug) {
      if (chipInputs[slug]) chipInputs[slug].checked = state.interests.indexOf(slug) !== -1;
    });

    syncCitySelect();
    applyInterestState();
    renderPhotos();
    updateBioCount();
    updateAxisOutputs();
    updateLocationStatus();
    clearErrors();
  }

  /* ------------------------------------------------------------------------
     6. Interests
     ------------------------------------------------------------------------ */

  /**
   * Display name for an interest category.
   * @param {string} category category key from the tag table
   * @returns {string}
   */
  function categoryLabel(category) {
    if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
    const text = String(category || 'Other');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /**
   * Build every interest chip once, grouped by category in tag-table order.
   * @returns {void}
   */
  function buildInterestChips() {
    const tags = Array.isArray(ZC.INTEREST_TAGS) ? ZC.INTEREST_TAGS : [];
    const order = [];
    const byCategory = {};

    tags.forEach(function (tag) {
      if (!tag || !tag.slug) return;
      const category = tag.category || 'other';
      if (!byCategory[category]) {
        byCategory[category] = [];
        order.push(category);
      }
      byCategory[category].push(tag);
      tagOrder.push(tag.slug);
    });

    clearNode(refs.interestGroups);

    if (!order.length) {
      refs.interestGroups.appendChild(el('p', {
        class: 'field-hint',
        text: 'The interest list could not be loaded, so interests cannot be edited right now.'
      }));
      return;
    }

    order.forEach(function (category) {
      refs.interestGroups.appendChild(el('fieldset', { class: 'stack stack-sm' }, [
        el('legend', { text: categoryLabel(category) }),
        el('div', { class: 'chip-group' }, byCategory[category].map(buildChip))
      ]));
    });
  }

  /**
   * One chip: a label carrying a visually hidden checkbox, so it keeps native
   * keyboard and screen-reader behaviour.
   * @param {Object} tag entry from ZC.INTEREST_TAGS
   * @returns {HTMLElement}
   */
  function buildChip(tag) {
    const input = el('input', {
      attrs: { type: 'checkbox', name: 'interests', value: tag.slug },
      on: { change: onInterestChange }
    });
    const children = [input];
    if (tag.emoji) children.push(el('span', { text: tag.emoji, attrs: { 'aria-hidden': 'true' } }));
    children.push(el('span', { text: tag.label || tag.slug }));

    const label = el('label', { class: 'chip' }, children);
    chipInputs[tag.slug] = input;
    chipLabels[tag.slug] = label;
    return label;
  }

  /**
   * Enforce the 12-tag cap the moment a chip is ticked, then re-read them all.
   * @param {Event} event change event from a chip checkbox
   * @returns {void}
   */
  function onInterestChange(event) {
    const input = event.currentTarget;
    const checked = tagOrder.filter(function (slug) {
      return chipInputs[slug] && chipInputs[slug].checked;
    });
    if (input.checked && checked.length > MAX_INTERESTS) {
      input.checked = false;
      toast('Twelve interests is the cap — take one off to add another.', 'warn');
    }
    state.interests = tagOrder.filter(function (slug) {
      return chipInputs[slug] && chipInputs[slug].checked;
    });
    applyInterestState();
    refreshAll();
  }

  /**
   * Reflect the current selection on the chips: tick marks, the disabled look
   * once the cap is reached, and the two counters.
   * @returns {void}
   */
  function applyInterestState() {
    const count = state.interests.length;
    const atCap = count >= MAX_INTERESTS;

    tagOrder.forEach(function (slug) {
      const input = chipInputs[slug];
      const label = chipLabels[slug];
      if (!input || !label) return;
      const selected = input.checked;
      label.classList.toggle('is-selected', selected);
      // Past the cap, unpicked chips go quiet rather than silently failing.
      input.disabled = !selected && atCap;
      label.classList.toggle('is-disabled', !selected && atCap);
    });

    refs.interestBadge.textContent = count + ' / ' + MAX_INTERESTS;
    refs.interestCount.textContent = atCap
      ? 'All ' + MAX_INTERESTS + ' chosen — remove one to pick something else.'
      : count + ' of ' + MAX_INTERESTS + ' chosen.';
  }

  /* ------------------------------------------------------------------------
     7. Photos
     ------------------------------------------------------------------------ */

  // Links that have already failed once, so a rerender does not queue the
  // same doomed request again on every keystroke.
  const brokenPhotos = {};
  let avatarCache = { key: '', uri: '' };

  /**
   * The generated avatar this account falls back to, which follows the name
   * as you type it. Memoised because it is asked for on every render.
   * @returns {string} data URI
   */
  function avatarFallback() {
    const name = state.displayName.trim() || 'You';
    const key = state.uid + '|' + name;
    if (avatarCache.key !== key) {
      avatarCache = { key: key, uri: util.avatarDataUri(state.uid || 'zc', name) };
    }
    return avatarCache.uri;
  }

  /**
   * Point an <img> at a URL, falling back to the generated avatar when the
   * link is empty or the image fails to load (hotlinks break all the time).
   * @param {HTMLImageElement} img target image
   * @param {string} url candidate URL
   * @returns {void}
   */
  function setImage(img, url) {
    const fallback = avatarFallback();
    const target = url && !brokenPhotos[url] ? url : fallback;
    img.onerror = function () {
      img.onerror = null;
      if (url) brokenPhotos[url] = true;
      img.src = avatarFallback();
    };
    if (img.getAttribute('src') !== target) img.src = target;
  }

  /**
   * Draw the six photo slots: filled ones preview the link and offer a remove
   * button, empty ones show as dashed placeholders.
   * @returns {void}
   */
  function renderPhotos() {
    clearNode(refs.photoGrid);

    for (let i = 0; i < MAX_PHOTOS; i += 1) {
      const url = state.photos[i];
      if (url) {
        const img = el('img', {
          attrs: { alt: 'Photo ' + (i + 1), loading: 'lazy', referrerpolicy: 'no-referrer' }
        });
        setImage(img, url);
        const remove = el('button', {
          class: 'photo-remove',
          text: '×',
          attrs: { type: 'button', 'aria-label': 'Remove photo ' + (i + 1) },
          on: { click: removePhoto(i) }
        });
        refs.photoGrid.appendChild(el('div', { class: 'photo-slot' }, [img, remove]));
      } else {
        refs.photoGrid.appendChild(el('div', { class: 'photo-slot is-empty' }, [
          el('span', { text: i === state.photos.length ? 'Next slot' : 'Empty' })
        ]));
      }
    }

    refs.photoBadge.textContent = state.photos.length + ' / ' + MAX_PHOTOS;
    refs.photoInput.disabled = state.photos.length >= MAX_PHOTOS;
    refs.photoAdd.disabled = state.photos.length >= MAX_PHOTOS;
  }

  /**
   * Handler factory for the per-slot remove button.
   * @param {number} index slot index
   * @returns {Function} click handler
   */
  function removePhoto(index) {
    return function () {
      state.photos.splice(index, 1);
      setError('photo', '');
      renderPhotos();
      refreshAll();
      toast('Photo removed.', 'info');
    };
  }

  /**
   * Validate a pasted photo link and add it to the first free slot.
   * @returns {void}
   */
  function addPhoto() {
    const raw = refs.photoInput.value.trim();

    if (!raw) {
      setError('photo', 'Paste a link to an image first.');
      refs.photoInput.focus();
      return;
    }
    if (state.photos.length >= MAX_PHOTOS) {
      setError('photo', 'You already have ' + MAX_PHOTOS + ' photos. Remove one to add another.');
      return;
    }
    // https only: http images are blocked on a secure page anyway, and they
    // leak the visit to the host in the clear.
    if (!/^https:\/\//i.test(raw)) {
      setError('photo', 'Photo links must start with https:// — anything else gets blocked by the browser.');
      refs.photoInput.focus();
      return;
    }
    try {
      const parsed = new URL(raw);
      if (!parsed.hostname) throw new Error('no host');
    } catch (err) {
      setError('photo', 'That does not look like a complete web address.');
      refs.photoInput.focus();
      return;
    }
    if (state.photos.indexOf(raw) !== -1) {
      setError('photo', 'That photo is already on your profile.');
      return;
    }

    state.photos.push(raw);
    refs.photoInput.value = '';
    setError('photo', '');
    renderPhotos();
    refreshAll();
    toast('Photo added. If the preview shows your avatar instead, the link did not load.', 'success');
  }

  /* ------------------------------------------------------------------------
     8. Location
     ------------------------------------------------------------------------ */

  /**
   * Fill the city picker from the bundled gazetteer.
   * @returns {void}
   */
  function buildCitySelect() {
    clearNode(refs.city);
    refs.city.appendChild(el('option', { text: 'Choose a city…', attrs: { value: '' } }));
    CITIES.forEach(function (city, index) {
      refs.city.appendChild(el('option', { text: city.label, attrs: { value: String(index) } }));
    });
  }

  /**
   * Select the bundled city that matches the saved label, if any.
   * @returns {void}
   */
  function syncCitySelect() {
    const label = state.locationLabel.trim().toLowerCase();
    let match = '';
    CITIES.forEach(function (city, index) {
      if (city.label.toLowerCase() === label) match = String(index);
    });
    refs.city.value = match;
  }

  /**
   * Describe the stored coordinates under the label field.
   * @returns {void}
   */
  function updateLocationStatus() {
    if (!state.coords) {
      refs.locationStatus.textContent = 'No location set. Distance scoring falls back to neutral for everyone.';
      return;
    }
    refs.locationStatus.textContent = 'Using ' + formatCoords(state.coords.lat, state.coords.lng) +
      ' — city-level only, accurate to about a kilometre.';
  }

  /**
   * Apply a chosen city to the location fields.
   * @param {Object} city entry from CITIES
   * @returns {void}
   */
  function applyCity(city) {
    state.coords = { lat: city.lat, lng: city.lng };
    state.locationLabel = city.label;
    refs.location.value = city.label;
    setError('location', '');
    updateLocationStatus();
    refreshAll();
  }

  /**
   * Forget the location entirely.
   * @returns {void}
   */
  function clearLocation() {
    state.coords = null;
    state.locationLabel = '';
    refs.location.value = '';
    refs.city.value = '';
    setError('location', '');
    updateLocationStatus();
    refreshAll();
  }

  /**
   * Ask the browser where we are. Denial, timeouts and browsers without the
   * API all end in a plain sentence and a working city picker — never a dead
   * end and never a repeated prompt.
   * @returns {void}
   */
  function useMyLocation() {
    if (!navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== 'function') {
      refs.locationStatus.textContent = 'This browser will not share a location. Pick a city from the list instead.';
      toast('Location is not available in this browser.', 'warn');
      return;
    }

    setBusy(refs.locate, true, 'Locating…');
    refs.locationStatus.textContent = 'Asking your browser for a rough position…';

    navigator.geolocation.getCurrentPosition(function (position) {
      setBusy(refs.locate, false);
      const coords = position && position.coords ? position.coords : {};
      const lat = Number(coords.latitude);
      const lng = Number(coords.longitude);
      if (!isFinite(lat) || !isFinite(lng)) {
        refs.locationStatus.textContent = 'That position did not make sense. Pick a city from the list instead.';
        return;
      }

      // Rounded to two decimals (about a kilometre) before it is stored: the
      // app only ever needs a neighbourhood, never a doorstep.
      state.coords = { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 };

      const near = nearestCity(state.coords.lat, state.coords.lng);
      if (near && near.km <= 25) state.locationLabel = near.city.label;
      else if (near && near.km <= 120) state.locationLabel = 'Near ' + near.city.label;
      else state.locationLabel = formatCoords(state.coords.lat, state.coords.lng);

      refs.location.value = state.locationLabel;
      syncCitySelect();
      setError('location', '');
      updateLocationStatus();
      refreshAll();
      toast('Location set to ' + state.locationLabel + '.', 'success');
    }, function (error) {
      setBusy(refs.locate, false);
      const code = error && error.code;
      let message = 'Your browser could not work out where you are. Pick a city from the list instead.';
      if (code === 1) message = 'Location permission was declined — no problem. Pick a city from the list instead.';
      else if (code === 3) message = 'That took too long. Try again, or pick a city from the list.';
      refs.locationStatus.textContent = message;
      toast(message, 'warn');
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  /* ------------------------------------------------------------------------
     9. Live rendering: bio counter, sliders, hero, meter, preview
     ------------------------------------------------------------------------ */

  /** Keep the 500-character counter in step with the bio. */
  function updateBioCount() {
    const used = state.bio.length;
    refs.bioCount.textContent = used + ' / ' + BIO_MAX;
    refs.bioCount.classList.toggle('is-over', used > BIO_MAX);
  }

  /** Mirror each slider's value into its <output>. */
  function updateAxisOutputs() {
    AXES.forEach(function (axis) {
      const out = id('value-' + axis.key);
      if (out) out.textContent = String(state.personality[axis.key]);
    });
  }

  /**
   * Score the profile out of 100 and work out what is still missing.
   * @returns {{percent: number, missing: string[]}}
   */
  function completeness() {
    let percent = 0;
    const missing = [];
    COMPLETENESS.forEach(function (item) {
      if (item.test(state)) percent += item.weight;
      else missing.push(item.label);
    });
    return { percent: percent, missing: missing };
  }

  /** Paint the completeness meter and its "next up" hint. */
  function renderCompleteness() {
    const result = completeness();
    refs.completenessFill.style.setProperty('width', result.percent + '%');
    refs.completenessLabel.textContent = result.percent + '% complete';
    refs.completenessBar.setAttribute('aria-valuenow', String(result.percent));
    refs.completenessBar.setAttribute('aria-valuetext', result.percent + ' per cent complete');
    refs.completenessHint.textContent = result.missing.length
      ? 'Next: add ' + joinList(result.missing.slice(0, 2)) + '.'
      : 'Every section is filled in — the engine has plenty to work with.';
  }

  /** Paint the header card: photo, name, one line of facts, plan badge. */
  function renderHero() {
    // The photo sits right beside the name, so it stays decorative (alt="").
    setImage(refs.heroPhoto, state.photos[0] || '');
    refs.heroName.textContent = state.displayName.trim() || 'Your profile';

    const bits = [];
    const age = util.ageFromBirthdate(state.birthdate);
    if (age !== null) bits.push(age + ' years old');
    if (state.pronouns.trim()) bits.push(state.pronouns.trim());
    if (state.coords && state.locationLabel.trim()) bits.push(state.locationLabel.trim());
    refs.heroMeta.textContent = bits.length ? bits.join(' · ') : 'Nothing filled in yet';

    const premium = !!(state.doc && state.doc.plan === 'premium');
    refs.heroBadge.classList.remove('hidden');
    refs.heroBadge.classList.toggle('badge-premium', premium);
    refs.heroBadge.textContent = premium ? 'Premium' : 'Free plan';
  }

  /**
   * Redraw the preview card — the same `.swipe-card` markup the deck uses, so
   * what you see here is what people swipe on.
   * @returns {void}
   */
  function renderPreview() {
    setImage(refs.previewPhoto, state.photos[0] || '');
    refs.previewName.textContent = state.displayName.trim() || 'Your name';

    const age = util.ageFromBirthdate(state.birthdate);
    refs.previewAge.textContent = state.showAge && age !== null ? String(age) : '';

    // Meta pills: pronouns, gender, place, plus honest notes about what you
    // have chosen to hide.
    clearNode(refs.previewMeta);
    const pills = [];
    if (state.pronouns.trim()) pills.push(state.pronouns.trim());
    pills.push(GENDERS[state.gender] || GENDERS.other);
    if (state.coords && state.locationLabel.trim()) pills.push('📍 ' + state.locationLabel.trim());
    if (!state.showAge) pills.push('Age hidden');
    if (!state.showDistance) pills.push('Distance hidden');
    pills.forEach(function (text) {
      refs.previewMeta.appendChild(el('span', { class: 'pill', text: text }));
    });

    refs.previewBio.textContent = state.bio.trim() ||
      'Your bio goes here — a couple of sentences in your own voice.';

    clearNode(refs.previewTags);
    const lookup = ZC.INTEREST_BY_SLUG || {};
    state.interests.slice(0, PREVIEW_TAGS).forEach(function (slug) {
      const tag = lookup[slug] || { label: slug, emoji: '' };
      refs.previewTags.appendChild(el('span', { class: 'swipe-tag' }, [
        tag.emoji ? el('span', { text: tag.emoji, attrs: { 'aria-hidden': 'true' } }) : null,
        el('span', { text: tag.label || slug })
      ]));
    });
    const extra = state.interests.length - PREVIEW_TAGS;
    if (extra > 0) {
      refs.previewTags.appendChild(el('span', { class: 'swipe-tag', text: '+' + extra + ' more' }));
    }
  }

  /** Everything that has to follow a keystroke, in one call. */
  function refreshAll() {
    renderCompleteness();
    renderHero();
    renderPreview();
    markDirty();
  }

  /* ------------------------------------------------------------------------
     10. Validation
     ------------------------------------------------------------------------ */

  /**
   * Show or clear one field's inline error.
   * @param {string} key key from ERROR_FIELDS
   * @param {string} message message, or '' to clear
   * @returns {void}
   */
  function setError(key, message) {
    const map = ERROR_FIELDS[key];
    if (!map) return;
    const field = id(map.field);
    const error = id(map.error);
    const input = map.input ? id(map.input) : null;
    if (error) error.textContent = message || '';
    if (field) field.classList.toggle('has-error', !!message);
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  /** Clear every inline error at once. */
  function clearErrors() {
    ERROR_ORDER.forEach(function (key) { setError(key, ''); });
  }

  /**
   * Check everything the Save button is about to write.
   * @returns {Object} map of field key to message; empty when the form is good
   */
  function validate() {
    const errors = {};
    const name = state.displayName.trim();

    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      errors.name = 'Use a display name between ' + NAME_MIN + ' and ' + NAME_MAX + ' characters.';
    }

    if (!state.birthdate) {
      errors.birthdate = 'Add your birthdate so your age can be shown and matched on.';
    } else {
      const age = util.ageFromBirthdate(state.birthdate);
      if (age === null) errors.birthdate = 'That is not a date we can read. Use the date picker.';
      else if (age < MIN_AGE) errors.birthdate = 'You have to be ' + MIN_AGE + ' or over to use this app.';
      else if (age > MAX_AGE) errors.birthdate = 'Please check that year — it puts you over ' + MAX_AGE + '.';
    }

    if (state.pronouns.trim().length > PRONOUN_MAX) {
      errors.pronouns = 'Pronouns are capped at ' + PRONOUN_MAX + ' characters.';
    }

    if (state.bio.length > BIO_MAX) {
      errors.bio = 'Your bio is ' + (state.bio.length - BIO_MAX) + ' characters over the ' + BIO_MAX + ' limit.';
    }

    if (state.interests.length > MAX_INTERESTS) {
      errors.interests = 'Pick at most ' + MAX_INTERESTS + ' interests.';
    }

    const label = state.locationLabel.trim();
    if (label.length > LABEL_MAX) {
      errors.location = 'Keep the location label under ' + LABEL_MAX + ' characters.';
    } else if (label && !state.coords) {
      // A label with no coordinates cannot be turned into a distance, so it
      // would silently do nothing.
      errors.location = 'Pick a city from the list, or use your location, so this label has coordinates behind it.';
    }

    if (state.photos.some(function (url) { return !/^https:\/\//i.test(url); })) {
      errors.photo = 'Every photo link has to start with https://.';
    }

    return errors;
  }

  /**
   * Paint a validation result and move focus to the first problem.
   * @param {Object} errors map from validate()
   * @returns {void}
   */
  function applyErrors(errors) {
    let focused = false;
    ERROR_ORDER.forEach(function (key) {
      const message = errors[key] || '';
      setError(key, message);
      if (!message || focused) return;
      focused = true;
      const map = ERROR_FIELDS[key];
      const target = map.input ? id(map.input) : id(map.field);
      if (target && typeof target.focus === 'function') target.focus();
      if (target && typeof target.scrollIntoView === 'function') {
        // Smooth scrolling is motion, so it follows the same preference the
        // stylesheet respects.
        const still = typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
      }
    });
  }

  /* ------------------------------------------------------------------------
     11. Saving
     ------------------------------------------------------------------------ */

  /**
   * The label to store with a set of coordinates: whatever the user typed,
   * else the nearest bundled city, else the coordinates themselves. A
   * location is never saved without something readable attached to it.
   * @param {{lat:number,lng:number}} coords stored coordinates
   * @returns {string}
   */
  function locationLabelFor(coords) {
    const typed = state.locationLabel.trim();
    if (typed) return typed;
    const near = nearestCity(coords.lat, coords.lng);
    if (near && near.km <= 120) return near.city.label;
    return formatCoords(coords.lat, coords.lng);
  }

  /**
   * Build the patch ZC.store.updateUser merges into the user document.
   * @returns {Object} partial UserDoc
   */
  function buildPatch() {
    const personality = {};
    AXES.forEach(function (axis) {
      personality[axis.key] = Math.round(util.clamp(state.personality[axis.key], 0, 100));
    });

    const location = state.coords
      ? { label: locationLabelFor(state.coords), lat: state.coords.lat, lng: state.coords.lng }
      : null;

    return {
      displayName: state.displayName.trim(),
      // Reaching a valid save means the account has a name and a verified
      // 18+ birthdate, which is exactly what requireProfile() waits for.
      profileComplete: true,
      profile: {
        birthdate: state.birthdate || null,
        age: state.birthdate ? util.ageFromBirthdate(state.birthdate) : null,
        gender: state.gender,
        pronouns: state.pronouns.trim(),
        bio: state.bio.trim(),
        photos: state.photos.slice(),
        interests: state.interests.slice(),
        personality: personality,
        location: location,
        showAge: !!state.showAge,
        showDistance: !!state.showDistance
      }
    };
  }

  /**
   * Validate, then write the profile. Any failure leaves the form exactly as
   * it was, with the changes still in it.
   * @param {Object} [options] save options
   * @param {HTMLElement} [options.button] control to show the busy state on
   * @param {string} [options.busyLabel] label while saving
   * @param {string} [options.savedMessage] toast shown on success
   * @returns {Promise<boolean>} true when the write landed
   */
  async function save(options) {
    const opts = options || {};
    if (saving) return false;

    const errors = validate();
    if (Object.keys(errors).length) {
      applyErrors(errors);
      toast('Some fields need another look.', 'warn');
      return false;
    }
    clearErrors();

    const button = opts.button || refs.save;
    saving = true;
    setBusy(button, true, opts.busyLabel || 'Saving…');

    try {
      const updated = await ZC.store.updateUser(state.uid, buildPatch());
      if (updated) state.doc = updated;
      baseline = snapshot();
      savedText = 'Saved just now.';
      markDirty();
      renderHero();
      // Let the rest of the app (nav, deck, matches) see the new document.
      if (ZC.auth && typeof ZC.auth.refresh === 'function') await ZC.auth.refresh();
      toast(opts.savedMessage || 'Profile saved.', 'success');
      return true;
    } catch (err) {
      console.warn('[zc.profile] Could not save the profile.', err);
      toast('Could not save your profile. Your changes are still here — try again.', 'error');
      return false;
    } finally {
      saving = false;
      setBusy(button, false);
    }
  }

  /**
   * Throw away unsaved edits and repaint from the last stored document.
   * @returns {Promise<void>}
   */
  async function discard() {
    if (!state.dirty) return;
    let confirmed = true;
    if (ZC.ui && typeof ZC.ui.confirm === 'function') {
      confirmed = await ZC.ui.confirm(
        'Your unsaved edits will be dropped and the form goes back to the last saved version.',
        { title: 'Discard changes?', confirmLabel: 'Discard', variant: 'danger' }
      );
    }
    if (!confirmed) return;
    readDoc(state.doc);
    paintForm();
    refreshAll();
    toast('Changes discarded.', 'info');
  }

  /**
   * Onboarding CTA: save, then head for the deck.
   * @returns {Promise<void>}
   */
  async function startMatching() {
    const ok = await save({
      button: refs.start,
      busyLabel: 'Saving…',
      savedMessage: 'Profile saved. Off you go.'
    });
    if (!ok) return;
    leaving = true;
    window.location.href = 'dashboard.html';
  }

  /* ------------------------------------------------------------------------
     12. Wiring
     ------------------------------------------------------------------------ */

  /**
   * Bind every control to the state. Called once, before the document loads,
   * so a slow network cannot leave a control dead.
   * @returns {void}
   */
  function wireControls() {
    refs.name.addEventListener('input', function () {
      state.displayName = refs.name.value;
      setError('name', '');
      refreshAll();
    });

    refs.birthdate.addEventListener('input', function () {
      state.birthdate = refs.birthdate.value;
      setError('birthdate', '');
      refreshAll();
    });
    // The 18+ guard is enforced on save; this also tells the date picker.
    refs.birthdate.setAttribute('max', isoYearsAgo(MIN_AGE));
    refs.birthdate.setAttribute('min', isoYearsAgo(MAX_AGE));

    refs.gender.addEventListener('change', function () {
      state.gender = GENDERS[refs.gender.value] ? refs.gender.value : 'other';
      refreshAll();
    });

    refs.pronouns.addEventListener('input', function () {
      state.pronouns = refs.pronouns.value;
      setError('pronouns', '');
      refreshAll();
    });

    refs.bio.addEventListener('input', function () {
      state.bio = refs.bio.value.slice(0, BIO_MAX);
      if (refs.bio.value.length > BIO_MAX) refs.bio.value = state.bio;
      setError('bio', '');
      updateBioCount();
      refreshAll();
    });

    AXES.forEach(function (axis) {
      const slider = id('range-' + axis.key);
      if (!slider) return;
      slider.addEventListener('input', function () {
        state.personality[axis.key] = Math.round(util.clamp(slider.value, 0, 100));
        updateAxisOutputs();
        refreshAll();
      });
    });

    refs.city.addEventListener('change', function () {
      const city = CITIES[Number(refs.city.value)];
      if (city) applyCity(city);
    });

    refs.location.addEventListener('input', function () {
      state.locationLabel = refs.location.value;
      setError('location', '');
      syncCitySelect();
      refreshAll();
    });

    refs.locate.addEventListener('click', useMyLocation);
    refs.clearLocation.addEventListener('click', clearLocation);

    refs.photoAdd.addEventListener('click', addPhoto);
    refs.photoInput.addEventListener('keydown', function (event) {
      // Enter inside the URL box adds the photo instead of submitting the form.
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addPhoto();
    });

    refs.showAge.addEventListener('change', function () {
      state.showAge = refs.showAge.checked;
      refreshAll();
    });
    refs.showDistance.addEventListener('change', function () {
      state.showDistance = refs.showDistance.checked;
      refreshAll();
    });

    refs.form.addEventListener('submit', function (event) {
      event.preventDefault();
      save();
    });
    refs.discard.addEventListener('click', discard);
    refs.start.addEventListener('click', startMatching);
    refs.retry.addEventListener('click', function () { load(); });

    // The unsaved-changes guard. Browsers show their own wording; all we can
    // do is ask for the prompt.
    window.addEventListener('beforeunload', function (event) {
      if (!state.dirty || saving || leaving) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  /**
   * Two columns with a sticky preview once the viewport can take it. Done
   * from script because the CSP forbids style attributes and the design
   * system has no two-column profile class.
   * @returns {void}
   */
  function applyLayout() {
    if (typeof window.matchMedia !== 'function') return;
    const wide = window.matchMedia(WIDE_QUERY).matches;
    const layout = refs.layout;
    const pane = refs.previewPane;

    if (wide) {
      layout.style.setProperty('display', 'grid');
      layout.style.setProperty('grid-template-columns', 'minmax(0, 1fr) minmax(0, 360px)');
      layout.style.setProperty('align-items', 'start');
      pane.style.setProperty('position', 'sticky');
      // Clear of the sticky top bar.
      pane.style.setProperty('top', 'calc(64px + var(--space-4))');
      return;
    }

    ['display', 'grid-template-columns', 'align-items'].forEach(function (prop) {
      layout.style.removeProperty(prop);
    });
    ['position', 'top'].forEach(function (prop) { pane.style.removeProperty(prop); });
  }

  /** Let the photo URL box share its row with the Add button. */
  function stretchPhotoRow() {
    refs.photoInput.style.setProperty('flex', '1 1 220px');
    refs.photoInput.style.setProperty('width', 'auto');
  }

  /** Switch the page over to its first-run wording. */
  function applyOnboarding() {
    if (!onboarding) return;
    refs.onboardingPill.classList.remove('hidden');
    refs.onboardingHead.classList.remove('hidden');
    refs.pageTitle.textContent = 'Set up your profile';
    refs.pageSub.textContent =
      'A name and a birthdate are all that is required. The more you add, the more the ' +
      'matching engine has to explain itself with.';
    refs.start.classList.remove('hidden');
    // Two primary buttons would compete; Save steps back during onboarding.
    refs.save.classList.remove('btn-primary');
    refs.save.classList.add('btn-secondary');
  }

  /* ------------------------------------------------------------------------
     13. Loading and boot
     ------------------------------------------------------------------------ */

  /** Show the skeletons while the document is on its way. */
  function showLoading() {
    refs.loading.classList.remove('hidden');
    refs.loading.setAttribute('aria-busy', 'true');
    refs.error.classList.add('hidden');
    refs.main.classList.add('hidden');
  }

  /** Reveal the editor. */
  function showEditor() {
    refs.loading.classList.add('hidden');
    refs.loading.setAttribute('aria-busy', 'false');
    refs.error.classList.add('hidden');
    refs.main.classList.remove('hidden');
  }

  /**
   * Show the load-failure state.
   * @param {string} message what went wrong, in plain words
   * @returns {void}
   */
  function showError(message) {
    refs.loading.classList.add('hidden');
    refs.loading.setAttribute('aria-busy', 'false');
    refs.main.classList.add('hidden');
    refs.errorText.textContent = message;
    refs.error.classList.remove('hidden');
  }

  /**
   * Fetch the freshest copy of the user document and fill the editor with it.
   * @returns {Promise<void>}
   */
  async function load() {
    showLoading();
    try {
      const doc = await ZC.store.getUser(state.uid);
      if (!doc) {
        showError('We could not find your profile document. Signing out and back in usually fixes it.');
        return;
      }
      readDoc(doc);
      paintForm();
      baseline = snapshot();
      savedText = 'Everything here is saved.';
      markDirty();
      renderCompleteness();
      renderHero();
      renderPreview();
      showEditor();
      applyLayout();
    } catch (err) {
      console.warn('[zc.profile] Could not load the profile.', err);
      showError('We could not load your profile. Check your connection and try again.');
    }
  }

  /**
   * Boot: guard the page, build the parts that do not depend on data, then
   * load the document.
   * @returns {Promise<void>}
   */
  async function start() {
    try {
      buildInterestChips();
      buildCitySelect();
      stretchPhotoRow();
      wireControls();
      applyOnboarding();
      applyLayout();

      if (typeof window.matchMedia === 'function') {
        const query = window.matchMedia(WIDE_QUERY);
        if (typeof query.addEventListener === 'function') query.addEventListener('change', applyLayout);
        else if (typeof query.addListener === 'function') query.addListener(applyLayout);
      }

      // Signed-out visitors are sent to auth.html and this never resolves.
      const doc = await ZC.auth.requireAuth();
      state.uid = doc.uid;
      state.doc = doc;
      await load();
    } catch (err) {
      console.error('[zc.profile] The profile editor failed to start.', err);
      showError('The profile editor could not start. Reloading the page usually clears it.');
    }
  }

  ZC.profile = {
    mounted: true,
    /** Re-read the stored profile and repaint the editor. @returns {Promise<void>} */
    reload: load,
    /** Save the form. @returns {Promise<boolean>} */
    save: save,
    /** Current completeness score. @returns {{percent:number, missing:string[]}} */
    completeness: completeness
  };

  // app.js resolves this once the DOM is parsed and auth has settled; without
  // it, fall back to the DOM alone.
  if (ZC.app && typeof ZC.app.onReady === 'function') ZC.app.onReady(function () { start(); });
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { start(); }, { once: true });
  else start();
})();
