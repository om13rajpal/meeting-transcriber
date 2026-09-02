export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message) => {
    console.log('[background] received', message);
  });
});
