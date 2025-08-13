/*
 * Background service worker for the Advanced Tab Manager extension.
 *
 * Added in v1.1:
 * - New preference "tabPolicy": "trim" (close oldest) or "block" (prevent new tabs).
 * - When "block" and the threshold would be exceeded, the newly created tab is closed immediately
 *   and a throttled notification is shown. Also the action badge shows "MAX".
 */

const DEFAULT_THRESHOLD = 20;
const DEFAULT_POLICY = 'block'; // 'trim' | 'block'

// In‑memory maps
const tabActivity = {};
let tabThreshold = DEFAULT_THRESHOLD;
let tabPolicy = DEFAULT_POLICY;
let domainWhitelist = [];
let discardInstead = false;

// Time tracking
let currentActiveTabId = null;
const tabActiveStart = {};
const tabDomains = {};
let domainTimes = {};

// Notification throttle
let lastBlockNoticeAt = 0;
const BLOCK_NOTICE_COOLDOWN_MS = 10000;

// Initialise defaults on installation / upgrade
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get([
    'tabThreshold',
    'savedSessions',
    'tabPolicy',
    'domainWhitelist',
    'discardInstead',
    'domainTimes'
  ]);
  if (typeof data.tabThreshold === 'undefined') {
    await chrome.storage.local.set({ tabThreshold: DEFAULT_THRESHOLD });
  }
  if (typeof data.tabPolicy === 'undefined') {
    await chrome.storage.local.set({ tabPolicy: DEFAULT_POLICY });
  }
  if (!Array.isArray(data.savedSessions)) {
    await chrome.storage.local.set({ savedSessions: [] });
  }
  if (!Array.isArray(data.domainWhitelist)) {
    await chrome.storage.local.set({ domainWhitelist: [] });
  }
  if (typeof data.discardInstead === 'undefined') {
    await chrome.storage.local.set({ discardInstead: false });
  }
  if (typeof data.domainTimes === 'undefined') {
    await chrome.storage.local.set({ domainTimes: {} });
  }
});

// Load cached prefs at startup
(async function loadPrefs() {
  const prefs = await chrome.storage.local.get([
    'tabThreshold',
    'tabPolicy',
    'domainWhitelist',
    'discardInstead',
    'domainTimes'
  ]);
  tabThreshold = prefs.tabThreshold || DEFAULT_THRESHOLD;
  tabPolicy = prefs.tabPolicy || DEFAULT_POLICY;
  domainWhitelist = Array.isArray(prefs.domainWhitelist) ? prefs.domainWhitelist : [];
  discardInstead = prefs.discardInstead || false;
  domainTimes = prefs.domainTimes || {};
  updateBadge();
})();

// Keep cache in sync
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.tabThreshold) tabThreshold = changes.tabThreshold.newValue;
  if (changes.tabPolicy) tabPolicy = changes.tabPolicy.newValue;
  if (changes.domainWhitelist) {
    domainWhitelist = Array.isArray(changes.domainWhitelist.newValue)
      ? changes.domainWhitelist.newValue
      : [];
  }
  if (changes.discardInstead) discardInstead = !!changes.discardInstead.newValue;
  if (changes.domainTimes) domainTimes = changes.domainTimes.newValue || {};
  updateBadge();
});

// Update badge with current policy state
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const total = tabs.length;
    let text = '';
    if (tabPolicy === 'block' && total >= (tabThreshold || DEFAULT_THRESHOLD)) {
      text = 'MAX';
    } else if (total && tabThreshold) {
      text = String(Math.min(99, Math.ceil((total / tabThreshold) * 9)));
      // single-digit "meter" from 1..9 (optional visual)
    }
    await chrome.action.setBadgeText({ text });
  } catch (e) {
    // ignore
  }
}

// Activity & time tracking
chrome.tabs.onActivated.addListener(({ tabId }) => {
  tabActivity[tabId] = Date.now();
  handleTabSwitch(tabId);
  if (tabPolicy === 'trim') checkTabCount();
  updateBadge();
});

// On created: for "block" policy, immediately close if exceeding threshold
chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    // record domain if known
    if (tab.url) {
      try {
        const domain = new URL(tab.url).hostname;
        tabDomains[tab.id] = domain;
      } catch (e) {}
    }
    if (tabPolicy === 'block') {
      const tabs = await chrome.tabs.query({});
      const total = tabs.length;
      if (tabThreshold && total > tabThreshold) {
        // Close the newborn tab unless it is pinned (rare) or whitelisted (if URL known)
        let allow = false;
        if (tab.pinned) allow = true;
        if (tab.url) {
          try {
            const d = new URL(tab.url).hostname;
            if (domainWhitelist.includes(d)) allow = true;
          } catch (e) {}
        }
        if (!allow) {
          try { await chrome.tabs.remove(tab.id); } catch (e) {}
          // Throttled notification
          const now = Date.now();
          if (now - lastBlockNoticeAt > BLOCK_NOTICE_COOLDOWN_MS) {
            lastBlockNoticeAt = now;
            try {
              await chrome.notifications.create('', {
                type: 'basic',
                title: 'タブ上限に達しました',
                message: `上限（${tabThreshold}）を超える新規タブはブロックされています。上限を上げるか、不要なタブを閉じてください。`,
                iconUrl: 'icons/icon128.png'
              });
            } catch (e) {}
          }
          updateBadge();
          return; // do not record activity for the blocked tab
        }
      }
    }
    // For both policies, record activity for tabs that remain
    tabActivity[tab.id] = Date.now();
    if (tabPolicy === 'trim') checkTabCount();
    updateBadge();
  } catch (e) {
    // ignore
  }
});

// Cleanup on removed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  delete tabActivity[tabId];
  if (tabId === currentActiveTabId) {
    const now = Date.now();
    const start = tabActiveStart[tabId] || now;
    const delta = now - start;
    const domain = tabDomains[tabId];
    if (domain) {
      domainTimes[domain] = (domainTimes[domain] || 0) + delta;
      await chrome.storage.local.set({ domainTimes });
    }
    currentActiveTabId = null;
  }
  delete tabActiveStart[tabId];
  delete tabDomains[tabId];
  updateBadge();
});

// Window focus changed -> record time
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    if (currentActiveTabId !== null) {
      const now = Date.now();
      const start = tabActiveStart[currentActiveTabId] || now;
      const delta = now - start;
      const domain = tabDomains[currentActiveTabId];
      if (domain) {
        domainTimes[domain] = (domainTimes[domain] || 0) + delta;
        await chrome.storage.local.set({ domainTimes });
      }
      tabActiveStart[currentActiveTabId] = now;
    }
  }
});

async function handleTabSwitch(newTabId) {
  const now = Date.now();
  if (currentActiveTabId !== null && currentActiveTabId !== newTabId) {
    const prevId = currentActiveTabId;
    const start = tabActiveStart[prevId] || now;
    const delta = now - start;
    const domain = tabDomains[prevId];
    if (domain) {
      domainTimes[domain] = (domainTimes[domain] || 0) + delta;
      await chrome.storage.local.set({ domainTimes });
    }
  }
  currentActiveTabId = newTabId;
  if (newTabId !== null) {
    tabActiveStart[newTabId] = now;
    try {
      const tab = await chrome.tabs.get(newTabId);
      const domain = new URL(tab.url).hostname;
      tabDomains[newTabId] = domain;
    } catch (e) {}
  }
}

/**
 * For "trim" policy: close least‑recently used tabs until within threshold.
 */
async function checkTabCount() {
  if (tabPolicy !== 'trim') return;
  try {
    const tabs = await chrome.tabs.query({});
    if (!tabThreshold || tabs.length <= tabThreshold) return;

    const closable = [];
    for (const t of tabs) {
      if (t.pinned) continue;
      let domain = '';
      try { domain = new URL(t.url).hostname; } catch (e) {}
      if (domain && domainWhitelist.includes(domain)) continue;
      closable.push(t);
    }
    closable.sort((a, b) => {
      const aTime = tabActivity[a.id] || 0;
      const bTime = tabActivity[b.id] || 0;
      return aTime - bTime;
    });
    let excess = tabs.length - tabThreshold;
    for (const tab of closable) {
      if (excess <= 0) break;
      try {
        if (discardInstead) { await chrome.tabs.discard(tab.id); }
        else { await chrome.tabs.remove(tab.id); }
        delete tabActivity[tab.id];
        delete tabActiveStart[tab.id];
        delete tabDomains[tab.id];
        if (currentActiveTabId === tab.id) currentActiveTabId = null;
        excess--;
      } catch (e) {}
    }
  } catch (e) {}
}

// Message handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.command) {
    case 'getSummary':
      (async () => {
        const tabs = await chrome.tabs.query({});
        const urlCounts = {};
        for (const tab of tabs) {
          const url = tab.url || '';
          urlCounts[url] = (urlCounts[url] || 0) + 1;
        }
        const duplicates = Object.values(urlCounts).filter((count) => count > 1).length;
        sendResponse({ totalTabs: tabs.length, duplicates });
      })();
      return true;

    case 'groupByDomain':
      (async () => {
        try {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const groups = {};
          for (const tab of tabs) {
            try {
              const urlObj = new URL(tab.url);
              const domain = urlObj.hostname;
              if (!groups[domain]) groups[domain] = [];
              groups[domain].push(tab.id);
            } catch (e) {}
          }
          for (const domain of Object.keys(groups)) {
            const ids = groups[domain];
            if (ids.length > 1) {
              const group = await chrome.tabGroups.create({ tabIds: ids });
              await chrome.tabGroups.update(group.id, { title: domain, color: 'blue' });
            }
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;

    case 'removeDuplicates':
      (async () => {
        const tabs = await chrome.tabs.query({});
        const seen = {};
        const toRemove = [];
        for (const tab of tabs) {
          const url = tab.url || '';
          if (seen[url]) toRemove.push(tab.id);
          else seen[url] = tab.id;
        }
        if (toRemove.length > 0) {
          if (discardInstead) {
            for (const id of toRemove) { try { await chrome.tabs.discard(id); } catch (e) {} }
          } else {
            await chrome.tabs.remove(toRemove);
          }
        }
        sendResponse({ closed: toRemove.length });
      })();
      return true;

    case 'saveSession':
      (async () => {
        const { name } = message;
        const tabs = await chrome.tabs.query({});
        const session = {
          id: Date.now(),
          name: name && name.trim() ? name.trim() : new Date().toLocaleString(),
          created: Date.now(),
          tabs: tabs.map((t) => ({ url: t.url, title: t.title, pinned: t.pinned }))
        };
        const data = await chrome.storage.local.get('savedSessions');
        const sessions = Array.isArray(data.savedSessions) ? data.savedSessions : [];
        sessions.push(session);
        await chrome.storage.local.set({ savedSessions: sessions });
        sendResponse({ session });
      })();
      return true;

    case 'getSessions':
      (async () => {
        const data = await chrome.storage.local.get('savedSessions');
        const sessions = Array.isArray(data.savedSessions) ? data.savedSessions : [];
        sessions.sort((a, b) => b.created - a.created);
        sendResponse({ sessions });
      })();
      return true;

    case 'deleteSession':
      (async () => {
        const { id } = message;
        const data = await chrome.storage.local.get('savedSessions');
        let sessions = Array.isArray(data.savedSessions) ? data.savedSessions : [];
        sessions = sessions.filter((s) => s.id !== id);
        await chrome.storage.local.set({ savedSessions: sessions });
        sendResponse({ ok: true });
      })();
      return true;

    case 'restoreSession':
      (async () => {
        const { id } = message;
        const data = await chrome.storage.local.get('savedSessions');
        const sessions = Array.isArray(data.savedSessions) ? data.savedSessions : [];
        const session = sessions.find((s) => s.id === id);
        if (session) {
          const urls = session.tabs.map((t) => t.url);
          await chrome.windows.create({ url: urls });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Session not found' });
        }
      })();
      return true;

    case 'exportSession':
      (async () => {
        const { id } = message;
        const data = await chrome.storage.local.get('savedSessions');
        const sessions = Array.isArray(data.savedSessions) ? data.savedSessions : [];
        const session = sessions.find((s) => s.id === id);
        if (!session) {
          sendResponse({ ok: false, error: 'Session not found' });
          return;
        }
        const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        await chrome.downloads.download({ url, filename: `${session.name.replace(/\s+/g, '_')}.json`, saveAs: true });
        sendResponse({ ok: true });
      })();
      return true;

    case 'updateThreshold':
      (async () => {
        const newThreshold = parseInt(message.value, 10);
        if (!isNaN(newThreshold) && newThreshold > 0) {
          await chrome.storage.local.set({ tabThreshold: newThreshold });
          updateBadge();
          sendResponse({ ok: true, threshold: newThreshold });
        } else {
          sendResponse({ ok: false, error: 'Invalid threshold' });
        }
      })();
      return true;

    case 'getThreshold':
      (async () => {
        const { tabThreshold: value } = await chrome.storage.local.get('tabThreshold');
        sendResponse({ threshold: value || DEFAULT_THRESHOLD });
      })();
      return true;

    case 'getPolicy':
      (async () => {
        const { tabPolicy: pol } = await chrome.storage.local.get('tabPolicy');
        sendResponse({ policy: pol || DEFAULT_POLICY });
      })();
      return true;

    case 'updatePolicy':
      (async () => {
        const val = message.value === 'trim' ? 'trim' : 'block';
        await chrome.storage.local.set({ tabPolicy: val });
        updateBadge();
        sendResponse({ ok: true, policy: val });
      })();
      return true;

    case 'getDomainStats':
      (async () => {
        const entries = Object.entries(domainTimes).map(([domain, ms]) => ({ domain, ms }));
        entries.sort((a, b) => b.ms - a.ms);
        sendResponse({ stats: entries });
      })();
      return true;

    case 'importSession':
      (async () => {
        const { session } = message;
        if (!session || !Array.isArray(session.tabs)) {
          sendResponse({ ok: false, error: 'Invalid session format' });
          return;
        }
        const imported = {
          id: Date.now(),
          name: session.name && session.name.trim() ? session.name.trim() : new Date().toLocaleString(),
          created: Date.now(),
          tabs: session.tabs.map((t) => ({ url: t.url, title: t.title || '', pinned: !!t.pinned }))
        };
        const data = await chrome.storage.local.get('savedSessions');
        const sessions = Array.isArray(data.savedSessions) ? data.savedSessions : [];
        sessions.push(imported);
        await chrome.storage.local.set({ savedSessions: sessions });
        sendResponse({ ok: true });
      })();
      return true;

    default:
      sendResponse({ error: 'Unknown command' });
      return false;
  }
});

// Keyboard shortcuts: unaffected except that "remove-duplicates" respects discardInstead.
chrome.commands.onCommand.addListener(async (command) => {
  switch (command) {
    case 'group-by-domain':
      try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const groups = {};
        for (const tab of tabs) {
          try {
            const domain = new URL(tab.url).hostname;
            if (!groups[domain]) groups[domain] = [];
            groups[domain].push(tab.id);
          } catch (e) {}
        }
        for (const domain of Object.keys(groups)) {
          const ids = groups[domain];
          if (ids.length > 1) {
            const group = await chrome.tabGroups.create({ tabIds: ids });
            await chrome.tabGroups.update(group.id, { title: domain, color: 'blue' });
          }
        }
      } catch (e) {}
      break;
    case 'save-session':
      try {
        const tabs = await chrome.tabs.query({});
        const session = {
          id: Date.now(),
          name: new Date().toLocaleString(),
          created: Date.now(),
          tabs: tabs.map((t) => ({ url: t.url, title: t.title, pinned: t.pinned }))
        };
        const data = await chrome.storage.local.get('savedSessions');
        const sessions = Array.isArray(data.savedSessions) ? data.savedSessions : [];
        sessions.push(session);
        await chrome.storage.local.set({ savedSessions: sessions });
      } catch (e) {}
      break;
    case 'remove-duplicates':
      try {
        const tabs = await chrome.tabs.query({});
        const seen = {};
        const toRemove = [];
        for (const tab of tabs) {
          const url = tab.url || '';
          if (seen[url]) toRemove.push(tab.id);
          else seen[url] = tab.id;
        }
        if (toRemove.length > 0) {
          if (discardInstead) {
            for (const id of toRemove) { try { await chrome.tabs.discard(id); } catch (e) {} }
          } else {
            await chrome.tabs.remove(toRemove);
          }
        }
      } catch (e) {}
      break;
    default:
      break;
  }
});
