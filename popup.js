const button = document.getElementById("run");
const status = document.getElementById("status");

button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "Запускаю расчёт…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url || !/^https?:/.test(tab.url)) {
      throw new Error("Открой страницу электронного дневника в обычной вкладке.");
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    status.textContent = "Скрипт запущен. Отчёт откроется в новой вкладке.";
    window.close();
  } catch (error) {
    status.textContent = error.message || "Не удалось запустить расширение.";
    button.disabled = false;
  }
});
