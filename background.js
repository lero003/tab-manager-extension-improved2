/*
 * Background service worker for the Advanced Tab Manager extension.
 *
 * Responsibilities:
 * - Maintain a record of when each tab was last activated.  This allows
 *   the extension to automatically close the least recently used tabs
 *   when the total number of tabs exceeds a configurable threshold.
 * - Respond to messages from the popup UI to provide information about
 *   open tabs, save or restore sessions, group tabs by domain, remove
 *   duplicates, and adjust preferences.
 */

const DEFAULT_THRESHOLD = 20;

// A simple in‑memory map of tabId -> timestamp (milliseconds) recording
// the last time a tab was activated.  This map is not persisted across
// browser restarts; however, persisting it is not critical for the
// trimming feature because new tabs start with no activity and will
// naturally be the first to be closed if the threshold is exceeded.
const tabActivity = {};

// Cached preferences; values will be loaded from storage at startup and
// kept in sync through the storage.onChanged listener.
let tabThreshold = DEFAULT_THRESHOLD;
let domainWhitelist = [];
let discardInstead = false;

// Variables used for time tracking.  When a tab becomes active we
// record the timestamp; when it loses focus or is closed we update
// domainTimes to reflect the elapsed time spent on that tab.
let currentActiveTabId = null;
const tabActiveStart = {}; // tabId -> timestamp when activated
const tabDomains = {}; // tabId -> last known domain
let domainTimes = {}; // domain -> cumulative active time in milliseconds

// Initialise default preferences on installation and upgrades
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(['tabThreshold', 'savedSessions']);
  if (typeof data.tabThreshold === 'undefined') {
    await chrome.storage.local.set({ tabThreshold: DEFAULT_THRESHOLD });
  }
  if (!Array.isArray(data.savedSessions)) {
    await chrome.storage.local.set({ savedSessions: [] });
  }

  // Set up other default values if not present
  const other = await chrome.storage.local.get(['domainWhitelist', 'discardInstead', 'domainTimes']);
  if (!Array.isArray(other.domainWhitelist)) {
    await chrome.storage.local.set({ domainWhitelist: [] });
  }
  if (typeof other.discardInstead === 'undefined') {
    await chrome.storage.local.set({ discardInstead: false });
  }
  if (typeof other.domainTimes === 'undefined') {
    await chrome.storage.local.set({ domainTimes: {} });
  }
});

// Load threshold from storage when the service worker starts up
(async function loadThreshold() {
  const { tabThreshold: stored } = await chrome.storage.local.get('tabThreshold');
  tabThreshold = stored || DEFAULT_THRESHOLD;
  const prefs = await chrome.storage.local.get(['domainWhitelist', 'discardInstead', 'domainTimes']);
  domainWhitelist = Array.isArray(prefs.domainWhitelist) ? prefs.domainWhitelist : [];
  discardInstead = prefs.discardInstead || false;
  domainTimes = prefs.domainTimes || {};
})();

// Update cached threshold when storage changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.tabThreshold) {
    tabThreshold = changes.tabThreshold.newValue;
  }
  if (areaName === 'local' && changes.domainWhitelist) {
    domainWhitelist = Array.isArray(changes.domainWhitelist.newValue)
      ? changes.domainWhitelist.newValue
      : [];
  }
  if (areaName === 'local' && changes.discardInstead) {
    discardInstead = changes.discardInstead.newValue || false;
  }
  if (areaName === 'local' && changes.domainTimes) {
    domainTimes = changes.domainTimes.newValue || {};
  }
});

// Update activity when a tab becomes active
chrome.tabs.onActivated.addListener(({ tabId }) => {
  tabActivity[tabId] = Date.now();
  // Handle time tracking when switching tabs
  handleTabSwitch(tabId);
  checkTabCount();
});

// Record activity when new tabs are created
chrome.tabs.onCreated.addListener((tab) => {
  tabActivity[tab.id] = Date.now();
  // Mark the domain for the new tab if possible
  try {
    if (tab.url) {
      const domain = new URL(tab.url).hostname;
      tabDomains[tab.id] = domain;
    }
  } catch (e) {}
  checkTabCount();
});

// Remove activity record when a tab is closed
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  delete tabActivity[tabId];
  // When a tab is closed, if it was the active one, record the time spent
  if (tabId === currentActiveTabId) {
    const now = Date.now();
    const start = tabActiveStart[tabId] || now;
    const delta = now - start;
    const domain = tabDomains[tabId];
    if (domain) {
      domainTimes[domain] = (domainTimes[domain] || 0) + delta;
      chrome.storage.local.set({ domainTimes });
    }
    currentActiveTabId = null;
  }
  delete tabActiveStart[tabId];
  delete tabDomains[tabId];
});

// When the focused window changes we treat it as leaving the previous tab.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // The browser lost focus (user switched to another app); record time for current tab
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

/**
 * Handles switching from the currently active tab to a new tab.  Records
 * time spent on the previous tab and updates the start time for the new
 * tab.
 * @param {number|null} newTabId The ID of the newly activated tab, or
 *     null if no tab is currently active (e.g. when a window loses focus).
 */
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
 * Checks the total number of open tabs across all windows. If the count
 * exceeds the configured threshold, the least recently activated tabs
 * (excluding pinned tabs) will be closed until the count is at or below
 * the threshold.
 */
async function checkTabCount() {
  try {
    const tabs = await chrome.tabs.query({});
    if (!tabThreshold || tabs.length <= tabThreshold) {
      return;
    }
    // Exclude pinned tabs and whitelisted domains from automatic trimming
    const closable = [];
    for (const t of tabs) {
      if (t.pinned) continue;
      let domain = '';
      try {
        domain = new URL(t.url).hostname;
      } catch (e) {}
      if (domain && domainWhitelist.includes(domain)) {
        continue;
      }
      closable.push(t);
    }
    // Sort by last activity ascending (oldest first)
    closable.sort((a, b) => {
      const aTime = tabActivity[a.id] || 0;
      const bTime = tabActivity[b.id] || 0;
      return aTime - bTime;
    });
    let excess = tabs.length - tabThreshold;
    for (const tab of closable) {
      if (excess <= 0) break;
      try {
        if (discardInstead) {
          await chrome.tabs.discard(tab.id);
        } else {
          await chrome.tabs.remove(tab.id);
        }
        delete tabActivity[tab.id];
        delete tabActiveStart[tab.id];
        delete tabDomains[tab.id];
        if (currentActiveTabId === tab.id) currentActiveTabId = null;
        excess--;
      } catch (err) {
        // ignore failures
      }
    }
  } catch (err) {
    // ignore errors silently
  }
}

/**
 * Handles messages from the popup. Because Chrome's messaging API is
 * callback‑based, we use async functions and return true to indicate
 * that the response will be sent asynchronously.
 */
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
          // Only group tabs in the current window to avoid moving tabs between windows unexpectedly
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const groups = {};
          for (const tab of tabs) {
            try {
              const urlObj = new URL(tab.url);
              const domain = urlObj.hostname;
              if (!groups[domain]) groups[domain] = [];
              groups[domain].push(tab.id);
            } catch (e) {
              // skip tabs with invalid URLs (e.g., about:blank)
            }
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
          if (seen[url]) {
            toRemove.push(tab.id);
          } else {
            seen[url] = tab.id;
          }
        }
        if (toRemove.length > 0) {
          await chrome.tabs.remove(toRemove);
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
        // sort by creation time descending
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
          // Create a new window with the session's tabs
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
          sendResponse({ ok: true, threshold: newThreshold });
        } else {
          sendResponse({ ok: false, error: 'Invalid threshold' });
        }
      })();
      return true;

    case 'exportCurrentTabs':
      (async () => {
        try {
          const tabs = await chrome.tabs.query({});
          const session = {
            name: `Current_${new Date().toISOString().replace(/[:T]/g, '-').split('.')[0]}`,
            created: Date.now(),
            tabs: tabs.map((t) => ({ url: t.url, title: t.title || '', pinned: !!t.pinned }))
          };
          const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          await chrome.downloads.download({ url, filename: `${session.name}.json`, saveAs: true });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;

    case 'getThreshold':
      (async () => {
        const { tabThreshold: value } = await chrome.storage.local.get('tabThreshold');
        sendResponse({ threshold: value || DEFAULT_THRESHOLD });
      })();
      return true;

    case 'getDomainStats':
      (async () => {
        // Return the accumulated active times per domain.  Sort by time descending.
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
        // Assign a new ID and timestamp to the imported session
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
      // Unknown command
      sendResponse({ error: 'Unknown command' });
      return false;
  }
});

// Respond to keyboard shortcut commands defined in manifest.  These commands
// perform actions without any UI feedback.  They reuse the same logic as
// the message handlers above but do not send responses.
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
      } catch (e) {
        // silently ignore errors
      }
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
      } catch (e) {
        // ignore
      }
      break;
    case 'remove-duplicates':
      try {
        const tabs = await chrome.tabs.query({});
        const seen = {};
        const toRemove = [];
        for (const tab of tabs) {
          const url = tab.url || '';
          if (seen[url]) {
            toRemove.push(tab.id);
          } else {
            seen[url] = tab.id;
          }
        }
        if (toRemove.length > 0) {
          if (discardInstead) {
            for (const id of toRemove) {
              await chrome.tabs.discard(id);
            }
          } else {
            await chrome.tabs.remove(toRemove);
          }
        }
      } catch (e) {
        // ignore
      }
      break;
    default:
      break;
  }
});