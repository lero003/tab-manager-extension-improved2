// popup.js
// Handles UI interactions for the Tab Manager extension popup.

/**
 * Utility function to send a message to the background script and return
 * a promise that resolves with the response.
 * @param {string} command Command name understood by the background script
 * @param {Object} [data] Additional data to send
 */
function sendCommand(command, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...data, command }, (response) => {
      resolve(response);
    });
  });
}

/** Update the summary information showing the number of open tabs and
 * duplicate URLs.
 */
async function updateSummary() {
  const summary = await sendCommand('getSummary');
  const total = document.getElementById('totalTabs');
  const dup = document.getElementById('duplicateTabs');
  total.textContent = summary && summary.totalTabs != null ? summary.totalTabs : '0';
  dup.textContent = summary && summary.duplicates != null ? summary.duplicates : '0';
}

/** Load the threshold value from the background and populate the input. */
async function loadThreshold() {
  const res = await sendCommand('getThreshold');
  const input = document.getElementById('thresholdInput');
  if (res && res.threshold) {
    input.value = res.threshold;
  } else {
    input.value = 20;
  }
}

/** Fetch saved sessions and render them into the session list. */
async function loadSessions() {
  const res = await sendCommand('getSessions');
  const list = document.getElementById('sessionList');
  list.innerHTML = '';
  if (!res || !Array.isArray(res.sessions) || res.sessions.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'セッションはありません';
    li.style.fontStyle = 'italic';
    list.appendChild(li);
    return;
  }
  res.sessions.forEach((session) => {
    const li = document.createElement('li');
    li.dataset.id = session.id;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'session-name';
    nameSpan.textContent = session.name;
    li.appendChild(nameSpan);
    // Restore button
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'restore';
    restoreBtn.textContent = '復元';
    li.appendChild(restoreBtn);
    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete';
    deleteBtn.textContent = '削除';
    li.appendChild(deleteBtn);
    // Export button
    const exportBtn = document.createElement('button');
    exportBtn.className = 'export';
    exportBtn.textContent = 'エクスポート';
    li.appendChild(exportBtn);
    list.appendChild(li);
  });
}

/**
 * Fetch domain usage statistics from the background and render the top entries.
 */
async function updateDomainStats() {
  const res = await sendCommand('getDomainStats');
  const list = document.getElementById('domainStats');
  list.innerHTML = '';
  if (!res || !Array.isArray(res.stats) || res.stats.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'データなし';
    li.style.fontStyle = 'italic';
    list.appendChild(li);
    return;
  }
  // Show top 5 domains
  const top = res.stats.slice(0, 5);
  top.forEach(({ domain, ms }) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = domain;
    const time = document.createElement('span');
    // Convert ms to minutes (with 1 decimal place)
    const minutes = ms / 60000;
    time.textContent = minutes.toFixed(1) + ' 分';
    li.appendChild(name);
    li.appendChild(time);
    list.appendChild(li);
  });
}

/** Display a status message at the bottom of the popup for a short time. */
function showStatus(msg, isError = false) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#dc3545' : '#555';
  if (msg) {
    setTimeout(() => {
      statusEl.textContent = '';
    }, 2500);
  }
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
  updateSummary();
  loadThreshold();
  loadSessions();
  updateDomainStats();

  document.getElementById('groupBtn').addEventListener('click', async () => {
    const res = await sendCommand('groupByDomain');
    if (res && res.ok) {
      showStatus('ドメイン別にグループ化しました');
    } else {
      showStatus('グループ化に失敗しました', true);
    }
  });

  document.getElementById('removeDupBtn').addEventListener('click', async () => {
    const res = await sendCommand('removeDuplicates');
    showStatus(`${res.closed || 0} 個の重複タブを閉じました`);
    updateSummary();
    updateDomainStats();
  });

  document.getElementById('saveSessionBtn').addEventListener('click', async () => {
    const defaultName = new Date().toLocaleString();
    const name = prompt('セッション名を入力してください', defaultName);
    if (name === null) {
      return; // user cancelled
    }
    const res = await sendCommand('saveSession', { name });
    if (res && res.session) {
      showStatus('セッションを保存しました');
      loadSessions();
      updateDomainStats();
    } else {
      showStatus('セッションの保存に失敗しました', true);
    }
  });

  // Export current tabs to JSON
  document.getElementById('exportCurrentBtn').addEventListener('click', async () => {
    const res = await sendCommand('exportCurrentTabs');
    if (res && res.ok) {
      showStatus('現在のタブをエクスポートしました');
    } else {
      showStatus('エクスポートに失敗しました', true);
    }
  });

  document.getElementById('updateThresholdBtn').addEventListener('click', async () => {
    const input = document.getElementById('thresholdInput');
    const value = parseInt(input.value, 10);
    if (isNaN(value) || value <= 0) {
      showStatus('正しい数値を入力してください', true);
      return;
    }
    const res = await sendCommand('updateThreshold', { value });
    if (res && res.ok) {
      showStatus(`上限を ${value} に更新しました`);
    } else {
      showStatus('上限の更新に失敗しました', true);
    }
  });

  // Event delegation for session actions
  document.getElementById('sessionList').addEventListener('click', async (event) => {
    const li = event.target.closest('li');
    if (!li) return;
    const id = Number(li.dataset.id);
    if (event.target.classList.contains('restore')) {
      const res = await sendCommand('restoreSession', { id });
      if (res && res.ok) {
        showStatus('セッションを復元しました');
        updateDomainStats();
      } else {
        showStatus('復元に失敗しました', true);
      }
    } else if (event.target.classList.contains('delete')) {
      const confirmed = confirm('このセッションを削除しますか？');
      if (!confirmed) return;
      const res = await sendCommand('deleteSession', { id });
      if (res && res.ok) {
        showStatus('セッションを削除しました');
        loadSessions();
        updateDomainStats();
      } else {
        showStatus('削除に失敗しました', true);
      }
    } else if (event.target.classList.contains('export')) {
      const res = await sendCommand('exportSession', { id });
      if (res && res.ok) {
        showStatus('セッションをエクスポートしました');
      } else {
        showStatus('エクスポートに失敗しました', true);
      }
    }
  });

  // Import session button
  document.getElementById('importSessionBtn').addEventListener('click', () => {
    const fileInput = document.getElementById('importFile');
    fileInput.value = '';
    fileInput.click();
  });
  document.getElementById('importFile').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function () {
      try {
        const session = JSON.parse(reader.result);
        const res = await sendCommand('importSession', { session });
        if (res && res.ok) {
          showStatus('インポートしました');
          loadSessions();
        } else {
          showStatus('インポートに失敗しました', true);
        }
      } catch (e) {
        showStatus('JSON の解析に失敗しました', true);
      }
    };
    reader.readAsText(file);
  });

  // Open options page
  document.getElementById('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  });
});