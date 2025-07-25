// options.js
// Handles reading and saving preferences from the options page.

document.addEventListener('DOMContentLoaded', async () => {
  // Load existing settings
  const data = await chrome.storage.local.get(['tabThreshold', 'discardInstead', 'domainWhitelist']);
  const thresholdInput = document.getElementById('optThreshold');
  const discardCheckbox = document.getElementById('optDiscard');
  const whitelistArea = document.getElementById('optWhitelist');
  const statusEl = document.getElementById('optStatus');

  thresholdInput.value = data.tabThreshold || 20;
  discardCheckbox.checked = !!data.discardInstead;
  if (Array.isArray(data.domainWhitelist) && data.domainWhitelist.length > 0) {
    whitelistArea.value = data.domainWhitelist.join('\n');
  } else {
    whitelistArea.value = '';
  }

  document.getElementById('optSave').addEventListener('click', async () => {
    const thresholdVal = parseInt(thresholdInput.value, 10);
    if (isNaN(thresholdVal) || thresholdVal <= 0) {
      statusEl.textContent = 'タブ上限には 1 以上の数値を入力してください。';
      statusEl.style.color = '#dc3545';
      return;
    }
    const discardVal = discardCheckbox.checked;
    const whitelistLines = whitelistArea.value
      .split(/\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // Normalize domains to lowercase
    const domains = whitelistLines.map((d) => d.toLowerCase());
    await chrome.storage.local.set({
      tabThreshold: thresholdVal,
      discardInstead: discardVal,
      domainWhitelist: domains
    });
    statusEl.textContent = '保存しました。';
    statusEl.style.color = '#555';
    setTimeout(() => {
      statusEl.textContent = '';
    }, 3000);
  });
});