(() => {
  const titleElement = document.querySelector("title");
  if (!titleElement) return;

  const readyMarker = /^__PI_TTYD__:(\d+):(\d+):(\d+)(?:\s+\|\s+.*)?$/;
  const titleMarker = /^__PI_TTYD_TITLE__:([^\s]*)(?:\s+\|\s+.*)?$/;
  let currentTitle = "ttyd";
  let lastEventId = "";
  let lastAppliedTitle;
  let restoreTimer;

  const setPageTitle = (title) => {
    if (document.title === title) return;
    lastAppliedTitle = title;
    document.title = title;
  };

  const handleTitleChange = () => {
    const title = document.title;
    if (title === lastAppliedTitle) {
      lastAppliedTitle = undefined;
      return;
    }
    lastAppliedTitle = undefined;

    const titleMatch = titleMarker.exec(title);
    if (titleMatch) {
      try {
        currentTitle = decodeURIComponent(titleMatch[1]) || "ttyd";
      } catch {
        return;
      }
      window.clearTimeout(restoreTimer);
      setPageTitle(currentTitle);
      return;
    }

    const readyMatch = readyMarker.exec(title);
    if (readyMatch) {
      const eventId = readyMatch.slice(1, 4).join(":");
      if (eventId === lastEventId) return;
      lastEventId = eventId;

      if (
        document.hidden &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        new Notification("Pi", { body: "Ready for input" });
      }

      const flashedTitle = `Pi ready | ${currentTitle}`;
      setPageTitle(flashedTitle);
      window.clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(() => {
        if (document.title === flashedTitle) setPageTitle(currentTitle);
      }, 5000);
      return;
    }

    if (title !== currentTitle) setPageTitle(currentTitle);
  };

  const observer = new MutationObserver(handleTitleChange);
  observer.observe(titleElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  setPageTitle(currentTitle);
  window.__piTtydTitleObserver = observer;
})();
