// options.js
// Handles reading and saving preferences from the options page.

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get(['tabThreshold', 'discardInstead', 'domainWhitelist', 'tabPolicy']);
  const thresholdInput = document.getElementById('optThreshold');
  const discardCheckbox = document.getElementById('optDiscard');
  const whitelistArea = document.getElementById('optWhitelist');
  const statusEl = document.getElementById('optStatus');

  // Policy radios
  const policyRadios = Array.from(document.querySelectorAll('input[name="policy"]'));

  thresholdInput.value = data.tabThreshold || 20;
  discardCheckbox.checked = !!data.discardInstead;
  const policy = data.tabPolicy || 'block';
  policyRadios.forEach(r => { r.checked = (r.value === policy); });

  if (Array.isArray(data.domainWhitelist) && data.domainWhitelist.length > 0) {
    whitelistArea.value = data.domainWhitelist.join('\\n');
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
      .split(/\\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const domains = whitelistLines.map((d) => d.toLowerCase());

    const selectedPolicy = (policyRadios.find(r => r.checked) || {value:'block'}).value;

    await chrome.storage.local.set({
      tabThreshold: thresholdVal,
      discardInstead: discardVal,
      domainWhitelist: domains,
      tabPolicy: selectedPolicy
    });
    statusEl.textContent = '保存しました。';
    statusEl.style.color = '#555';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  });
});