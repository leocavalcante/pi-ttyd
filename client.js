(() => {
  const titleElement = document.querySelector("title");
  if (!titleElement) return;

  const marker = /^__PI_TTYD__:(\d+):(\d+):(\d+)(?:\s+\|\s+(.+))?$/;
  let lastEventId = "";
  let restoreTimer;

  const handleTitleChange = () => {
    const match = marker.exec(document.title);
    if (!match) return;

    const eventId = match.slice(1, 4).join(":");
    if (eventId === lastEventId) return;
    lastEventId = eventId;

    const pageTitle = match[4] || "ttyd";
    const flashedTitle = `Pi ready | ${pageTitle}`;

    if (
      document.hidden &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      new Notification("Pi", { body: "Ready for input" });
    }

    document.title = flashedTitle;
    window.clearTimeout(restoreTimer);
    restoreTimer = window.setTimeout(() => {
      if (document.title === flashedTitle) document.title = pageTitle;
    }, 5000);
  };

  const observer = new MutationObserver(handleTitleChange);
  observer.observe(titleElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  window.__piTtydTitleObserver = observer;
})();
