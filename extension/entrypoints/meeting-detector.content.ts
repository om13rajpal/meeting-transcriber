// WXT auto-generates the manifest content_scripts entry from this
// file's `matches` config - one file covers both platforms since the
// detection logic (and the message it sends) is identical, only the
// `platform` label differs.
export default defineContentScript({
  matches: ['https://meet.google.com/*', 'https://teams.microsoft.com/*'],
  main() {
    const platform = location.hostname.includes('meet.google.com') ? 'meet' : 'teams';

    // A call page for both platforms always has a real meeting-code-shaped
    // path (Meet: /xxx-xxxx-xxx, Teams web: /v2/?meetingjoin or similar
    // under /l/meetup-join/). Rather than pattern-matching every possible
    // URL shape (which shifts over time - see the design spec's note on
    // DOM-scraping fragility), treat "matched by the manifest at all" as
    // good enough: both host permissions above are scoped to
    // meet.google.com/teams.microsoft.com specifically, and the landing/
    // pre-join pages on both are rare enough visits that a false positive
    // just means the side panel offers "Record" a little early, which is
    // harmless - the user still has to click Start themselves.
    chrome.runtime.sendMessage({ type: 'MEETING_TAB_DETECTED', platform });

    window.addEventListener('beforeunload', () => {
      chrome.runtime.sendMessage({ type: 'MEETING_TAB_LEFT' });
    });
  },
});
