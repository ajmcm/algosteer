// LinkedIn's DOM changes often. This is a best-effort, user-controlled filter.
// v0.1.5: reduce DOM scanning and bound long sessions to avoid infinite-feed
// runaway when hundreds of zero-height posts are hidden.
(() => {
  const SELECTORS = [
    '[data-testid="mainFeed"] [role="listitem"][componentkey^="update-card-focus"]',
    '[data-testid="mainFeed"] [role="listitem"]',
    '.feed-shared-update-v2',
    '.occludable-update',
    '[data-urn^="urn:li:activity:"]',
    '[data-id^="urn:li:activity:"]',
    'main [role="article"]',
    'main article',
  ];
  const cards = new WeakMap();
  const all = new Set();
  let pending = false;
  let scanCount = 0;
  const scanRoots = new Set();
  let fullScanRequired = true;
  const SELECTOR = SELECTORS.join(',');
  const REVIEW_PAGE_SIZE = 40;
  let sessionLimit = 150; // Adjustable within session. Refresh resets this guard.
  let hiddenCount = 0;
  let review = null;
  let filterReady = false;
  let statusKnown = false;
  let activeJobs = 0;
  const MAX_IN_FLIGHT = 2;
  let boundary = null;
  document.documentElement.dataset.pbLoaded = 'v0.1.5';
  console.info('[AlgoSteer] v0.1.5 content script active on', location.pathname);

  // An already-visible post is never removed by passive rescoring. Only
  // posts below the viewport are staged/reclassified after new feedback.
  function safelyAhead(state) {
    if (!state.card.isConnected) return false;
    const rect = state.card.getBoundingClientRect();
    return rect.top > window.innerHeight + 80;
  }

  function orderedStates() {
    return [...all].filter(s => s.card.isConnected).sort((a, b) =>
      a.card === b.card ? 0 :
      (a.card.compareDocumentPosition(b.card) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
  }

  function ensureBoundary() {
    if (boundary) return boundary;
    boundary = document.createElement('div');
    boundary.className = 'pb-loading-boundary';
    boundary.setAttribute('role', 'status');
    boundary.setAttribute('aria-live', 'polite');
    const label = document.createElement('span');
    label.className = 'pb-loading-label';
    boundary.append(label);
    const actions = document.createElement('div');
    actions.className = 'pb-loading-actions';
    const refresh = makeButton('Refresh feed', () => location.reload());
    const continueButton = makeButton('Continue anyway (+100)', () => {
      sessionLimit += 100;
      refreshBoundary();
      pump();
    });
    actions.append(refresh, continueButton);
    boundary.append(actions);
    boundary._label = label;
    boundary._actions = actions;
    return boundary;
  }

  function refreshBoundary() {
    const waiting = orderedStates().filter(s => s.pending);
    const el = ensureBoundary();
    if (!filterReady || waiting.length === 0) {
      el.remove();
      return;
    }
    const first = waiting[0].card;
    const paused = hiddenCount >= sessionLimit;
    const label = paused
      ? `Session safeguard: ${hiddenCount} hidden posts. Refresh to continue with a smaller page, or deliberately extend the session.`
      : `◌ Preparing your feed · ${waiting.length} ${waiting.length === 1 ? 'post' : 'posts'} queued`;
    if (el._label.textContent !== label) el._label.textContent = label;
    el._actions.hidden = !paused;
    if (first.parentElement && (el.parentElement !== first.parentElement || el.nextSibling !== first)) {
      first.parentElement.insertBefore(el, first);
    }
  }

  function stage(state) {
    if (!filterReady || !state.card.isConnected || state.busy || state.manualReveal) return;
    if (state.pending) return;
    state.pending = true;
    state.readyResponse = null;
    state.card.classList.add('pb-pending');
    refreshBoundary();
    pump();
  }

  // Only commit classifications in document order. If a later post finishes
  // first, it remains out of layout until the preceding post has completed.
  function flushResolved() {
    for (const state of orderedStates()) {
      if (!state.pending) continue;
      if (!state.readyResponse) break;
      const result = state.readyResponse;
      state.pending = false;
      state.readyResponse = null;
      state.card.classList.remove('pb-pending');
      if (result.error) {
        state.status.textContent = `Error: ${result.error}`;
        state.status.classList.add('pb-error');
        setDisplayed(state, true); // Fail open.
      } else {
        apply(state, result.response);
      }
    }
    refreshBoundary();
  }

  function pump() {
    if (!filterReady) return;
    flushResolved();
    if (activeJobs >= MAX_IN_FLIGHT || hiddenCount >= sessionLimit) { refreshBoundary(); return; }
    for (const state of orderedStates()) {
      if (activeJobs >= MAX_IN_FLIGHT || hiddenCount >= sessionLimit) break;
      if (!state.pending || state.inFlight || state.readyResponse || state.busy) continue;
      state.inFlight = true;
      const rev = ++state.revision;
      activeJobs++;
      request('SCORE', { text: state.text })
        .then(response => {
          if (state.pending && rev === state.revision) state.readyResponse = { response };
        })
        .catch(error => {
          if (state.pending && rev === state.revision) state.readyResponse = { error: error.message };
        })
        .finally(() => {
          state.inFlight = false;
          activeJobs--;
          flushResolved();
          pump();
        });
    }
  }

  function activateScoring() {
    if (!filterReady) {
      for (const state of all) {
        if (state.pending) {
          state.pending = false;
          state.card.classList.remove('pb-pending');
        }
        // Pause should not leave formerly filtered cards invisible.
        if (state.isHidden) setDisplayed(state, true);
      }
      refreshBoundary();
      return;
    }
    for (const state of orderedStates()) {
      // Stage new items, and already-scored ones only if safely below view.
      if (safelyAhead(state)) stage(state);
    }
    pump();
  }

  function isFeed() {
    return /^\/feed(?:\/|$)/.test(location.pathname) ||
      !!document.querySelector('[data-testid="mainFeed"],.feed-container-theme');
  }

  function request(type, body = {}) {
    return chrome.runtime.sendMessage({ target: 'background', type, ...body }).then(r => {
      if (!r?.ok) throw new Error(r?.error || 'Extension did not reply');
      return r;
    });
  }

  function getText(card) {
    let sections = Array.from(card.querySelectorAll(
      '[data-testid="expandable-text-box"], .update-components-text, .feed-shared-update-v2__description, .feed-shared-text, .feed-shared-article__description'
    ));
    sections = sections.filter(el => !sections.some(other => other !== el && other.contains(el)));
    const texts = sections.map(el => el.innerText || el.textContent || '').filter(Boolean);
    if (texts.length) return texts.join('\n').replace(/\s+/g, ' ').trim().slice(0, 6200);
    // No deep DOM clone: LinkedIn posts can contain expensive image/video trees.
    // On newly discovered cards the toolbar has not yet been inserted.
    return (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 6200);
  }

  function makeButton(label, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      fn();
    });
    return b;
  }

  function createReviewUI() {
    if (review || !document.body) return;
    const root = document.createElement('div');
    root.className = 'pb-review-root';
    const badge = makeButton('0 hidden', openReview);
    badge.className = 'pb-hidden-counter';
    badge.title = 'Review posts hidden by AlgoSteer';
    badge.setAttribute('aria-haspopup', 'dialog');
    badge.setAttribute('aria-expanded', 'false');

    const overlay = document.createElement('div');
    overlay.className = 'pb-review-overlay';
    overlay.hidden = true;
    const dialog = document.createElement('section');
    dialog.className = 'pb-review-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'pb-review-heading');
    dialog.tabIndex = -1;

    const headingRow = document.createElement('div');
    headingRow.className = 'pb-review-heading-row';
    const heading = document.createElement('div');
    const title = document.createElement('h2');
    title.id = 'pb-review-heading';
    title.textContent = 'Hidden posts';
    const summary = document.createElement('p');
    summary.className = 'pb-review-summary';
    summary.textContent = 'Posts hidden in your currently loaded feed';
    heading.append(title, summary);
    const close = makeButton('✕ Close', closeReview);
    close.className = 'pb-review-close';
    close.setAttribute('aria-label', 'Close hidden posts');
    headingRow.append(heading, close);

    const message = document.createElement('div');
    message.className = 'pb-review-message';
    message.setAttribute('role', 'status');
    const list = document.createElement('div');
    list.className = 'pb-review-list';
    list.tabIndex = 0;
    list.setAttribute('aria-label', 'Scrollable list of hidden posts');
    const empty = document.createElement('p');
    empty.className = 'pb-review-empty';
    empty.textContent = 'No hidden posts currently loaded. As more posts are filtered, they will appear here.';
    list.append(empty);
    const pager = document.createElement('div');
    pager.className = 'pb-review-pager';
    const newer = makeButton('← Newer', () => { review.page = Math.max(0, review.page - 1); refreshReview(); });
    const older = makeButton('Older →', () => { review.page++; refreshReview(); });
    pager.append(newer, older);
    const footer = document.createElement('p');
    footer.className = 'pb-review-footnote';
    footer.textContent = 'Previews are read-only. “Show in feed” reveals the original LinkedIn post. Only More / Less changes your preference model.';
    dialog.append(headingRow, message, list, pager, footer);
    overlay.append(dialog);
    root.append(badge, overlay);
    document.body.append(root);
    review = { root, badge, overlay, dialog, close, summary, message, list, empty, pager, newer, older, page: 0,
      entries: new Map(), open: false, priorOverflow: null, focusBefore: null };
    overlay.addEventListener('click', ev => { if (ev.target === overlay) closeReview(); });
    document.addEventListener('keydown', ev => {
      if (!review?.open) return;
      if (ev.key === 'Escape') { ev.preventDefault(); closeReview(); return; }
      if (ev.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button:not([disabled]),a[href], [tabindex="0"]')]
        .filter(el => el.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (ev.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        ev.preventDefault(); last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault(); first.focus();
      }
    });
    refreshReview();
  }

  function hiddenStates() {
    return [...all].filter(state => state.card.isConnected && state.isHidden);
  }

  function openReview() {
    createReviewUI();
    if (!review || review.open) return;
    review.open = true;
    review.page = 0;
    review.focusBefore = document.activeElement;
    review.priorOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    review.overlay.hidden = false;
    review.badge.setAttribute('aria-expanded', 'true');
    refreshReview();
    review.close.focus();
  }

  function closeReview() {
    if (!review?.open) return;
    review.open = false;
    review.overlay.hidden = true;
    review.badge.setAttribute('aria-expanded', 'false');
    document.documentElement.style.overflow = review.priorOverflow ?? '';
    review.message.textContent = '';
    for (const item of review.entries.values()) item.element.remove();
    review.entries.clear();
    (review.focusBefore?.isConnected ? review.focusBefore : review.badge).focus();
  }

  function candidateMedia(card) {
    const urls = new Set();
    for (const img of card.querySelectorAll('img')) {
      if (img.closest('a[href*="/in/"],a[href*="/company/"]')) continue;
      const src = img.currentSrc || img.src;
      if (!src || !/^https:\/\//i.test(src)) continue;
      // Skip avatars, icons, and 1px trackers. Only show large content images.
      const large = img.naturalWidth >= 220 || Number(img.getAttribute('width')) >= 220 ||
        /image-shrink_(480|800|1280)|feedshare|article-image/i.test(src);
      if (large && !/profile-displayphoto|company-logo/i.test(src)) urls.add(src);
      if (urls.size >= 3) break;
    }
    return [...urls];
  }

  function makeReviewEntry(state) {
    const element = document.createElement('article');
    element.className = 'pb-review-entry';
    const top = document.createElement('div');
    top.className = 'pb-review-entry-top';
    const authorLink = state.card.querySelector('a[href*="/in/"],a[href*="/company/"]');
    const author = document.createElement('strong');
    author.textContent = (authorLink?.innerText || authorLink?.textContent || 'LinkedIn post').trim().slice(0, 100) || 'LinkedIn post';
    const score = document.createElement('span');
    score.className = 'pb-review-score';
    top.append(author, score);
    const body = document.createElement('p');
    body.className = 'pb-review-text';
    body.textContent = state.text;
    element.append(top, body);

    const media = candidateMedia(state.card);
    if (media.length) {
      const gallery = document.createElement('div');
      gallery.className = 'pb-review-gallery';
      for (const src of media) {
        const img = document.createElement('img');
        img.loading = 'lazy'; img.alt = 'Image included in the LinkedIn post'; img.src = src;
        gallery.append(img);
      }
      element.append(gallery);
    }

    const actions = document.createElement('div');
    actions.className = 'pb-review-actions';
    const more = makeButton('👍 More', () => void state.feedback(1));
    const less = makeButton('👎 Less', () => void state.feedback(0));
    const reveal = makeButton('Show in feed', () => revealInFeed(state));
    reveal.className = 'pb-review-reveal';
    actions.append(more, less, reveal);
    element.append(actions);
    return { element, score, more, less };
  }

  function refreshReview() {
    if (!review) return;
    const count = hiddenCount;
    const badgeLabel = `${count} hidden ${count === 1 ? 'post' : 'posts'}`;
    if (review.badge.textContent !== badgeLabel) review.badge.textContent = badgeLabel;
    review.badge.setAttribute('aria-label', `Review ${badgeLabel}`);
    document.documentElement.dataset.pbHidden = String(count);
    document.documentElement.dataset.pbSessionLimit = String(sessionLimit);
    if (!review.open) return;
    const hidden = hiddenStates().reverse(); // Most recent hidden posts first.
    const pages = Math.max(1, Math.ceil(hidden.length / REVIEW_PAGE_SIZE));
    review.page = Math.min(review.page, pages - 1);
    const start = review.page * REVIEW_PAGE_SIZE;
    const selected = hidden.slice(start, start + REVIEW_PAGE_SIZE);
    review.summary.textContent = `${count} hidden · showing ${count ? start + 1 : 0}–${Math.min(count, start + REVIEW_PAGE_SIZE)}`;
    review.pager.hidden = pages <= 1;
    review.newer.disabled = review.page === 0;
    review.older.disabled = review.page >= pages - 1;
    const active = new Set(selected);
    for (const [state, item] of review.entries) {
      if (!active.has(state)) { item.element.remove(); review.entries.delete(state); }
    }
    review.empty.hidden = count !== 0;
    for (const state of selected) {
      let item = review.entries.get(state);
      if (!item) {
        item = makeReviewEntry(state);
        review.entries.set(state, item);
        review.list.append(item.element);
      }
      const r = state.lastResponse;
      item.score.textContent = r?.probability == null
        ? (r?.reason === 'rated-less' ? 'Rated Less' : 'Hidden')
        : `Predicted Like ${Math.round(r.probability * 100)}%`;
      item.more.disabled = item.less.disabled = state.busy;
      item.more.classList.toggle('pb-review-active', r?.label === 1);
      item.less.classList.toggle('pb-review-active', r?.label === 0);
    }
  }

  function setDisplayed(state, shouldShow) {
    const nextHidden = !shouldShow && !state.manualReveal;
    if (state.isHidden !== nextHidden) hiddenCount += nextHidden ? 1 : -1;
    state.isHidden = nextHidden;
    state.card.classList.toggle('pb-hidden', state.isHidden);
    if (state.rehide) state.rehide.hidden = !state.manualReveal;
    refreshReview();
  }

  function revealInFeed(state) {
    if (!state.card.isConnected) return;
    state.manualReveal = true;
    setDisplayed(state, true);
    state.status.textContent = 'Manually revealed • use Rehide to return to filtering';
    closeReview();
    requestAnimationFrame(() => state.card.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }

  function create(card) {
    if (cards.has(card)) {
      const state = cards.get(card);
      if (!state.toolbar.isConnected && card.isConnected) card.insertBefore(state.toolbar, card.firstChild);
      return;
    }
    if (SELECTORS.some(s => card.parentElement?.closest(s))) return;
    if (card.matches('[data-testid="mainFeed"] [role="listitem"]') &&
      !card.hasAttribute('componentkey') &&
      !card.querySelector('[data-testid="expandable-text-box"],button[aria-label*="Reaction button"],button[aria-label^="React"]')) return;
    const text = getText(card);
    if (text.length < 30) return;

    const toolbar = document.createElement('div'); toolbar.className = 'pb-toolbar';
    const title = document.createElement('span'); title.className = 'pb-title'; title.textContent = 'AlgoSteer';
    const more = makeButton('👍 More', () => void feedback(1));
    const less = makeButton('👎 Less', () => void feedback(0));
    const rehide = makeButton('Rehide', () => {
      state.manualReveal = false;
      if (state.lastResponse) apply(state, state.lastResponse);
    });
    rehide.hidden = true;
    const status = document.createElement('span'); status.className = 'pb-status';
    status.textContent = 'Scoring locally…';
    toolbar.append(title, more, less, rehide, status);
    card.insertBefore(toolbar, card.firstChild);

    const state = { card, toolbar, more, less, rehide, status, text,
      revision: 0, scored: false, pending: false, inFlight: false, readyResponse: null,
      isHidden: false, manualReveal: false, lastResponse: null, busy: false, feedback };
    cards.set(card, state); all.add(state);
    if (filterReady) stage(state);
    // In cold start, don't embed or conceal every post: feedback works immediately.
    else status.textContent = 'Ready for feedback';

    async function feedback(label) {
      if (state.busy) return;
      state.busy = true;
      ++state.revision; // Invalidates any SCORE that started before the rating.
      more.disabled = less.disabled = true;
      status.textContent = 'Saving label…';
      refreshReview();
      try {
        const response = await request('LABEL', { text: state.text, label });
        state.manualReveal = false;
        state.pending = false;
        state.readyResponse = null;
        state.card.classList.remove('pb-pending');
        apply(state, response);
        filterReady = !!response.ready;
        // Preserve the viewport; reconsider only posts waiting ahead.
        for (const item of all) {
          if (item !== state && item.card.isConnected && safelyAhead(item)) stage(item);
        }
        activateScoring();
      } catch (e) {
        status.textContent = `Error: ${e.message}`;
        status.classList.add('pb-error');
        if (review?.open) review.message.textContent = `Could not save rating: ${e.message}`;
      } finally {
        state.busy = false;
        more.disabled = less.disabled = false;
        refreshReview();
        flushResolved();
        pump();
      }
    }
  }

  function apply(state, response) {
    state.lastResponse = response;
    state.scored = true;
    state.more.classList.toggle('pb-active', response.label === 1);
    state.less.classList.toggle('pb-active', response.label === 0);
    state.status.classList.remove('pb-error');
    const pct = p => `${Math.round(p * 100)}%`;
    if (response.reason === 'rated-more' && response.probability == null) state.status.textContent = 'Rated More';
    else if (response.reason === 'rated-less' && response.probability == null) state.status.textContent = 'Rated Less';
    else if (response.reason === 'training') state.status.textContent = `Learning • ${response.total || 0} labels (needs ≥12, ≥3 each)`;
    else if (response.reason === 'paused') state.status.textContent = 'Paused';
    else if (response.probability != null) {
      state.status.textContent = `Like ${pct(response.probability)} • model range ${pct(response.lower)}–${pct(response.upper)}${response.reason === 'thompson' ? ' • exploring' : ''}`;
    } else state.status.textContent = 'Ready';
    if (state.manualReveal && !response.show) {
      state.status.textContent += ' • manually revealed';
    }
    setDisplayed(state, response.show);
  }

  function scan() {
    pending = false;
    if (!isFeed()) return;
    createReviewUI();
    scanCount++;
    const nodes = new Set();
    if (fullScanRequired) {
      // Full query only once at startup. Later scans look at newly added subtrees.
      for (const node of [...document.querySelectorAll(SELECTOR)].slice(-160)) nodes.add(node);
      fullScanRequired = false;
    }
    for (const root of scanRoots) {
      if (!root.isConnected) continue;
      if (root.matches?.(SELECTOR)) nodes.add(root);
      const ancestor = root.closest?.(SELECTOR);
      if (ancestor) nodes.add(ancestor);
      for (const child of root.querySelectorAll?.(SELECTOR) || []) nodes.add(child);
    }
    scanRoots.clear();
    for (const node of nodes) {
      if (node.closest('.pb-review-root,.pb-toolbar,.pb-loading-boundary')) continue;
      create(node);
    }
    let removed = false;
    for (const state of all) {
      if (!state.card.isConnected) {
        if (state.isHidden) hiddenCount--;
        all.delete(state);
        removed = true;
      }
    }
    if (removed) { refreshReview(); refreshBoundary(); }
    pump();
    document.documentElement.dataset.pbCards = String(all.size);
    document.documentElement.dataset.pbCandidates = String(nodes.size);
    document.documentElement.dataset.pbScans = String(scanCount);
    if (scanCount === 1) console.info('[AlgoSteer] first scan:',
      { candidates: nodes.size, enhanced: all.size, feedFound: !!document.querySelector('[data-testid="mainFeed"]') });
  }

  // Never trigger a full-document scan in response to our own toolbar,
  // counter, modal, boundary, or label updates. Only LinkedIn feed mutations
  // containing potential new post nodes are interesting.
  function schedule() {
    if (!statusKnown || pending) return;
    pending = true;
    setTimeout(scan, 40); // Coalesce bursts; avoids a microtask feedback loop.
  }
  const mutation = new MutationObserver(records => {
    if (!statusKnown) return;
    let needsCleanup = false;
    for (const record of records) {
      if (record.type !== 'childList') continue;
      const target = record.target;
      const inFeed = target.nodeType === 1 && (
        target.matches?.('[data-testid="mainFeed"],.feed-container-theme') ||
        target.closest?.('[data-testid="mainFeed"],.feed-container-theme'));
      if (inFeed && record.removedNodes.length) needsCleanup = true;
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.('.pb-review-root,.pb-toolbar,.pb-loading-boundary') ||
          node.closest?.('.pb-review-root,.pb-toolbar,.pb-loading-boundary')) continue;
        // A mutation to an already-processed post is not a new post.
        const parentPost = node.closest?.(SELECTOR);
        if (parentPost && cards.has(parentPost)) continue;
        const related = inFeed || node.matches?.('[data-testid="mainFeed"],.feed-container-theme') ||
          node.querySelector?.('[data-testid="mainFeed"],.feed-container-theme');
        if (!related) continue;
        if (parentPost && cards.has(parentPost)) continue;
        scanRoots.add(parentPost || node);
      }
    }
    if (scanRoots.size || needsCleanup) schedule();
  });
  mutation.observe(document.documentElement, { childList: true, subtree: true });
  void request('STATUS').then(data => {
    statusKnown = true;
    filterReady = !!data.settings?.enabled && !!data.counts?.ready;
    schedule();
    queueMicrotask(activateScoring);
  }).catch(err => { statusKnown = true; console.warn('[AlgoSteer] Status failed:', err); schedule(); });
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area !== 'local') return;
    void request('STATUS').then(data => {
      filterReady = !!data.settings?.enabled && !!data.counts?.ready;
      activateScoring();
    }).catch(console.warn);
  });
  setTimeout(() => {
    const enhanced = Number(document.documentElement.dataset.pbCards || 0);
    if (!enhanced && isFeed()) console.warn('[AlgoSteer] No posts enhanced after 6 seconds. Check page HTML and run:',
      '({loaded:document.documentElement.dataset.pbLoaded,feed:document.querySelectorAll(\'[data-testid="mainFeed"]\').length,posts:document.querySelectorAll(\'[data-testid="mainFeed"] [role="listitem"]\').length,buttons:document.querySelectorAll(\'.pb-toolbar\').length})');
  }, 6000);
})();
