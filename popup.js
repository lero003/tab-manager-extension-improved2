// popup.js
// Handles UI interactions for the Tab Manager extension popup.

function sendCommand(command, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...data, command }, (response) => {
      resolve(response);
    });
  });
}

async function updateSummaryAndProgress() {
  const [summary, thresholdRes, policyRes] = await Promise.all([
    sendCommand('getSummary'),
    sendCommand('getThreshold'),
    sendCommand('getPolicy')
  ]);
  const total = document.getElementById('totalTabs');
  const dup = document.getElementById('duplicateTabs');
  const progressFill = document.getElementById('progressFill');
  const usageHint = document.getElementById('usageHint');
  const policy = (policyRes && policyRes.policy) || 'block';

  const totalTabs = summary && summary.totalTabs != null ? summary.totalTabs : 0;
  const duplicates = summary && summary.duplicates != null ? summary.duplicates : 0;
  const threshold = (thresholdRes && thresholdRes.threshold) || 20;

  total.textContent = totalTabs;
  dup.textContent = duplicates;

  const ratio = Math.min(1, totalTabs / threshold);
  progressFill.style.width = `${Math.round(ratio * 100)}%`;
  usageHint.textContent = `現在 ${totalTabs} / 上限 ${threshold}  (${policy === 'block' ? 'ブロック' : '古いタブを閉じる'})`;

  // reflect policy radios
  const radios = document.querySelectorAll('input[name="policy"]');
  radios.forEach(r => r.checked = (r.value === policy));
}

async function loadThreshold() {
  const res = await sendCommand('getThreshold');
  const input = document.getElementById('thresholdInput');
  input.value = (res && res.threshold) ? res.threshold : 20;
}

async function loadPolicy() {
  const res = await sendCommand('getPolicy');
  const policy = (res && res.policy) || 'block';
  const radios = document.querySelectorAll('input[name="policy"]');
  radios.forEach(r => r.checked = (r.value === policy));
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
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'restore';
    restoreBtn.textContent = '復元';
    li.appendChild(restoreBtn);
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete';
    deleteBtn.textContent = '削除';
    li.appendChild(deleteBtn);
    const exportBtn = document.createElement('button');
    exportBtn.className = 'export';
    exportBtn.textContent = 'エクスポート';
    li.appendChild(exportBtn);
    list.appendChild(li);
  });
}

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
  const top = res.stats.slice(0, 5);
  top.forEach(({ domain, ms }) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = domain;
    const time = document.createElement('span');
    const minutes = ms / 60000;
    time.textContent = minutes.toFixed(1) + ' 分';
    li.appendChild(name);
    li.appendChild(time);
    list.appendChild(li);
  });
}

function showStatus(msg, isError = false) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#dc3545' : '#555';
  if (msg) setTimeout(() => { statusEl.textContent = ''; }, 2500);
}

document.addEventListener('DOMContentLoaded', () => {
  updateSummaryAndProgress();
  loadThreshold();
  loadPolicy();
  loadSessions();
  updateDomainStats();

  document.getElementById('groupBtn').addEventListener('click', async () => {
    const res = await sendCommand('groupByDomain');
    if (res && res.ok) showStatus('ドメイン別にグループ化しました');
    else showStatus('グループ化に失敗しました', true);
  });

  document.getElementById('removeDupBtn').addEventListener('click', async () => {
    const res = await sendCommand('removeDuplicates');
    showStatus(`${res.closed || 0} 個の重複タブを閉じました`);
    updateSummaryAndProgress();
    updateDomainStats();
  });

  document.getElementById('saveSessionBtn').addEventListener('click', async () => {
    const defaultName = new Date().toLocaleString();
    const name = prompt('セッション名を入力してください', defaultName);
    if (name === null) return;
    const res = await sendCommand('saveSession', { name });
    if (res && res.session) {
      showStatus('セッションを保存しました');
      loadSessions();
      updateDomainStats();
    } else {
      showStatus('セッションの保存に失敗しました', true);
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
      updateSummaryAndProgress();
    } else {
      showStatus('上限の更新に失敗しました', true);
    }
  });

  // Policy toggle
  document.getElementById('updatePolicyBtn').addEventListener('click', async () => {
    const selected = document.querySelector('input[name="policy"]:checked');
    const val = selected ? selected.value : 'block';
    const res = await sendCommand('updatePolicy', { value: val });
    if (res && res.ok) {
      showStatus(`挙動を「${val === 'block' ? 'ブロック' : '古いタブを閉じる'}」に変更しました`);
      updateSummaryAndProgress();
    } else {
      showStatus('挙動の変更に失敗しました', true);
    }
  });

  // Import / Export handlers
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

  document.getElementById('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  });
});
