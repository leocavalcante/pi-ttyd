(() => {
  const titleElement = document.querySelector("title");
  if (!titleElement) return;

  const readyMarker = /^__PI_TTYD__:(\d+):(\d+):(\d+)(?:\s+\|\s+.*)?$/;
  const titleMarker = /^__PI_TTYD_TITLE__:([^\s]*)(?:\s+\|\s+.*)?$/;
  const normalizeTitle = (title) => title.replace(/[ \t\n\f\r]+/g, " ").trim();
  const imageTransferStart = "\u001e__PI_TTYD_IMAGE_V1__";
  const imageTransferEnd = "__PI_TTYD_IMAGE_END_V1__";
  const maxImageBytes = 4 * 1024 * 1024;
  const chunkSize = 48 * 1024;
  const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const extensionTypes = new Map([
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
  ]);
  let currentTitle = "ttyd";
  let lastEventId = "";
  let lastAppliedTitle;
  let restoreTimer;

  const imageMimeType = (file) => {
    const type = (file.type || "").toLowerCase();
    if (imageTypes.has(type)) return type;
    const extension = (file.name || "").split(".").pop().toLowerCase();
    return extensionTypes.get(extension);
  };

  const isImageFile = (file) =>
    (file.type || "").toLowerCase().startsWith("image/") || imageMimeType(file) !== undefined;

  const droppedFiles = (dataTransfer) => {
    const files = Array.from(dataTransfer?.files || []);
    if (files.length > 0) return files;
    return Array.from(dataTransfer?.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
  };

  const hasFileDrop = (dataTransfer) => {
    const items = Array.from(dataTransfer?.items || []);
    return items.some((item) => item.kind === "file") || droppedFiles(dataTransfer).some(isImageFile);
  };

  const toBase64 = (bytes) => {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  };

  const sendImage = async (file) => {
    const mimeType = imageMimeType(file);
    if (!mimeType) {
      console.warn("pi-ttyd: only PNG, JPEG, GIF, and WebP images are supported");
      return;
    }
    if (file.size > maxImageBytes) {
      console.warn("pi-ttyd: images must be 4 MiB or smaller");
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxImageBytes) {
      console.warn("pi-ttyd: images must be non-empty and 4 MiB or smaller");
      return;
    }

    const terminal = window.term;
    if (!terminal || typeof terminal.input !== "function") {
      console.warn("pi-ttyd: ttyd terminal input is unavailable");
      return;
    }

    const base64 = toBase64(bytes);
    terminal.focus();
    terminal.input(`${imageTransferStart}${mimeType}\n`, true);
    for (let offset = 0; offset < base64.length; offset += chunkSize) {
      terminal.input(base64.slice(offset, offset + chunkSize), true);
    }
    terminal.input(imageTransferEnd, true);
  };

  const handleImageDragOver = (event) => {
    if (hasFileDrop(event.dataTransfer)) event.preventDefault();
  };

  const handleImageDrop = async (event) => {
    const images = droppedFiles(event.dataTransfer).filter(isImageFile);
    if (images.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    for (const file of images) {
      try {
        await sendImage(file);
      } catch (error) {
        console.warn("pi-ttyd: could not send dropped image", error);
      }
    }
  };

  document.addEventListener("dragover", handleImageDragOver, true);
  document.addEventListener("drop", handleImageDrop, true);

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
        currentTitle = normalizeTitle(decodeURIComponent(titleMatch[1])) || "ttyd";
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
