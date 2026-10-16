(() => {
  const titleElement = document.querySelector("title");
  if (!titleElement) return;

  const readyMarker = /^__PI_TTYD__:(\d+):(\d+):(\d+)(?:\s+\|\s+.*)?$/;
  const titleMarker = /^__PI_TTYD_TITLE__:([^\s]*)(?:\s+\|\s+.*)?$/;
  const imageReceiverMarker = /^__PI_TTYD_IMAGE_RX__:(?:([1-9]\d{0,3}):)?(ready|inactive)(?:\s+\|\s+.*)?$/;
  const normalizeTitle = (title) => title.replace(/[ \t\n\f\r]+/g, " ").trim();
  const imageTransferStart = "\u001e__PI_TTYD_IMAGE_V1__";
  const imageTransferEnd = "__PI_TTYD_IMAGE_END_V1__";
  const imageReceiverQueryStart = "\u0005";
  const imageReceiverQueryEnd = "\u0006";
  const imageReceiverQueryPrefixLength = 3;
  const imagePayloadSeparator = "\u001f";
  const maxImageBytes = 4 * 1024 * 1024;
  const chunkSize = 48 * 1024;
  const imageReceiverTimeoutMs = 2000;
  const imageReceiverQueryIdLimit = 4096;
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
  let readyFlashTitle;
  let restoreTimer;
  let titleReconciliationQueued = false;
  let imageReceiverActive = false;
  let imageReceiverQuerySequence = Math.floor(Math.random() * imageReceiverQueryIdLimit);
  let imageReceiverRequest;
  let imageReceiverRequestTimer;
  let imageDropQueue = Promise.resolve();

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

  const nextImageReceiverQueryId = () => {
    imageReceiverQuerySequence = (imageReceiverQuerySequence % imageReceiverQueryIdLimit) + 1;
    return String(imageReceiverQuerySequence);
  };

  const resolveImageReceiverRequest = (queryId, active) => {
    const request = imageReceiverRequest;
    if (!request || request.id !== queryId) return;
    imageReceiverRequest = undefined;
    window.clearTimeout(imageReceiverRequestTimer);
    imageReceiverRequestTimer = undefined;
    request.resolve(active);
  };

  const requestImageReceiver = () => {
    const terminal = window.term;
    if (!terminal || typeof terminal.input !== "function") return Promise.resolve(false);
    if (imageReceiverRequest) return imageReceiverRequest.promise;

    imageReceiverActive = false;
    const queryId = nextImageReceiverQueryId();
    let resolve;
    const request = {
      id: queryId,
      promise: new Promise((done) => { resolve = done; }),
      resolve: (active) => resolve(active),
    };
    imageReceiverRequest = request;
    imageReceiverRequestTimer = window.setTimeout(() => {
      resolveImageReceiverRequest(queryId, false);
    }, imageReceiverTimeoutMs);

    try {
      terminal.focus();
      const queryPrefix = "\u0000".repeat(imageReceiverQueryPrefixLength);
      const queryIdBytes = "\u0000".repeat(Number(queryId));
      const query = `${queryPrefix}${imageReceiverQueryStart}${queryIdBytes}${imageReceiverQueryEnd}`;
      terminal.input(query, true);
    } catch {
      resolveImageReceiverRequest(queryId, false);
    }
    return request.promise;
  };

  const sendImage = async (file) => {
    if (!imageReceiverActive) return false;
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
    if (!imageReceiverActive) return false;
    if (bytes.length === 0 || bytes.length > maxImageBytes) {
      console.warn("pi-ttyd: images must be non-empty and 4 MiB or smaller");
      return;
    }

    const base64 = toBase64(bytes);
    if (!(await requestImageReceiver()) || !imageReceiverActive) return false;

    const terminal = window.term;
    if (!terminal || typeof terminal.input !== "function") {
      console.warn("pi-ttyd: ttyd terminal input is unavailable");
      return false;
    }

    terminal.focus();
    terminal.input(`${imageTransferStart}${mimeType}${imagePayloadSeparator}`, true);
    // Keep chunks synchronous so keyboard and paste events cannot interleave.
    for (let offset = 0; offset < base64.length; offset += chunkSize) {
      if (!imageReceiverActive) return false;
      terminal.input(base64.slice(offset, offset + chunkSize), true);
    }
    if (!imageReceiverActive) return false;
    terminal.input(imageTransferEnd, true);
    return true;
  };

  const processDroppedImages = async (images) => {
    try {
      if (!(await requestImageReceiver())) {
        console.warn("pi-ttyd: no active Pi image receiver; image drop ignored");
        return;
      }

      for (const file of images) {
        if (!imageReceiverActive) return;
        try {
          if (await sendImage(file) === false && !imageReceiverActive) return;
        } catch (error) {
          console.warn("pi-ttyd: could not send dropped image", error);
        }
      }
    } finally {
      imageReceiverActive = false;
    }
  };

  const handleImageDragOver = (event) => {
    if (hasFileDrop(event.dataTransfer)) event.preventDefault();
  };

  const handleImageDrop = (event) => {
    const images = droppedFiles(event.dataTransfer).filter(isImageFile);
    if (images.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    imageDropQueue = imageDropQueue
      .then(() => processDroppedImages(images))
      .catch((error) => console.warn("pi-ttyd: could not send dropped image", error));
    return imageDropQueue;
  };

  document.addEventListener("dragover", handleImageDragOver, true);
  document.addEventListener("drop", handleImageDrop, true);

  const setPageTitle = (title) => {
    if (document.title === title) return;
    document.title = title;
  };

  const scheduleTitleReconciliation = () => {
    if (titleReconciliationQueued) return;
    titleReconciliationQueued = true;
    Promise.resolve().then(() => {
      titleReconciliationQueued = false;
      setPageTitle(readyFlashTitle ?? currentTitle);
    });
  };

  const handleTitleChange = (title) => {
    if (typeof title !== "string") return;

    try {
      const receiverMatch = imageReceiverMarker.exec(title);
      if (receiverMatch) {
        const [, queryId, state] = receiverMatch;
        const active = state === "ready";
        if (queryId && imageReceiverRequest?.id === queryId) {
          imageReceiverActive = active;
          resolveImageReceiverRequest(queryId, active);
        } else if (!queryId && !active) {
          imageReceiverActive = false;
          if (imageReceiverRequest) resolveImageReceiverRequest(imageReceiverRequest.id, false);
        }
        return;
      }

      const titleMatch = titleMarker.exec(title);
      if (titleMatch) {
        let decodedTitle;
        try {
          decodedTitle = decodeURIComponent(titleMatch[1]);
        } catch {
          return;
        }
        currentTitle = normalizeTitle(decodedTitle) || "ttyd";
        readyFlashTitle = undefined;
        window.clearTimeout(restoreTimer);
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
        readyFlashTitle = flashedTitle;
        window.clearTimeout(restoreTimer);
        restoreTimer = window.setTimeout(() => {
          if (readyFlashTitle === flashedTitle) readyFlashTitle = undefined;
          if (document.title === flashedTitle) setPageTitle(currentTitle);
          restoreTimer = undefined;
        }, 5000);
        return;
      }

      if (title !== currentTitle) {
        readyFlashTitle = undefined;
        window.clearTimeout(restoreTimer);
      }
    } finally {
      scheduleTitleReconciliation();
    }
  };

  const subscribeToTerminalTitles = () => {
    const terminal = window.term;
    if (terminal && typeof terminal.onTitleChange === "function") {
      terminal.onTitleChange(handleTitleChange);
      handleTitleChange(document.title);
      return;
    }
    window.setTimeout(subscribeToTerminalTitles, 50);
  };

  subscribeToTerminalTitles();
  setPageTitle(currentTitle);
})();
