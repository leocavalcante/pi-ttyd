const READY_MARKER = "__PI_TTYD__";
const TITLE_MARKER = "__PI_TTYD_TITLE__:";
const DEFAULT_TITLE = "ttyd";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const IMAGE_TRANSFER_START = "\u001e__PI_TTYD_IMAGE_V1__";
const IMAGE_TRANSFER_END = "__PI_TTYD_IMAGE_END_V1__";
// A NUL-run encodes query IDs without leaving printable probe text in a shell.
const IMAGE_RECEIVER_QUERY_PREFIX_LENGTH = 3;
const MAX_IMAGE_RECEIVER_QUERY_ID = 4096;
const IMAGE_RECEIVER_QUERY_IDLE_MS = 25;
const IMAGE_RECEIVER_MARKER = "__PI_TTYD_IMAGE_RX__:";
const IMAGE_PAYLOAD_SEPARATOR = "\u001f";
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_IMAGE_PAYLOAD_CHARS = MAX_IMAGE_BASE64_CHARS + 32;
const MAX_PENDING_IMAGES = 4;
const IMAGE_TRANSFER_TIMEOUT_MS = 30_000;

function terminalTitleSequence(title) {
  const sequence = `\x1b]2;${title}\x07`;
  if (!process.env.TMUX) return sequence;
  return `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

function writeTitle(title) {
  process.stdout.write(terminalTitleSequence(title));
}

function sendTitle(ctx, title) {
  ctx.ui.setTitle(`${TITLE_MARKER}${encodeURIComponent(title)}`);
}

function sendImageReceiverState(active, queryId) {
  const state = active ? "ready" : "inactive";
  const request = queryId ? `${queryId}:` : "";
  writeTitle(`${IMAGE_RECEIVER_MARKER}${request}${state}`);
}

function decodeImage(payload) {
  const separator = payload.indexOf(IMAGE_PAYLOAD_SEPARATOR);
  if (separator < 0) return undefined;

  const mimeType = payload.slice(0, separator);
  const data = payload.slice(separator + 1);
  if (
    !SUPPORTED_IMAGE_TYPES.has(mimeType) ||
    data.length === 0 ||
    data.length % 4 !== 0 ||
    data.length > MAX_IMAGE_BASE64_CHARS ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  ) {
    return undefined;
  }

  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== data) {
    return undefined;
  }

  return { type: "image", mimeType, data };
}

export default function register(pi) {
  const notificationsEnabled = process.env.PI_TTYD_NOTIFY === "1";
  let sequence = 0;
  let pendingImages = [];
  let incomingTransfer;
  let transferTimeout;
  let unmatchedStart = "";
  let unsubscribeTerminalInput;
  let receiverEnabled = false;
  let pendingReceiverQueryLength = 0;
  let receiverQueryTimeout;

  const clearTransferTimeout = () => {
    if (transferTimeout !== undefined) clearTimeout(transferTimeout);
    transferTimeout = undefined;
  };

  const clearIncomingTransfer = () => {
    clearTransferTimeout();
    incomingTransfer = undefined;
  };

  const clearReceiverQuery = () => {
    if (receiverQueryTimeout !== undefined) clearTimeout(receiverQueryTimeout);
    receiverQueryTimeout = undefined;
    pendingReceiverQueryLength = 0;
  };

  const completeReceiverQuery = () => {
    const queryId = pendingReceiverQueryLength - IMAGE_RECEIVER_QUERY_PREFIX_LENGTH;
    clearReceiverQuery();
    if (queryId < 1 || queryId > MAX_IMAGE_RECEIVER_QUERY_ID) return;

    if (incomingTransfer) {
      clearTransferTimeout();
      incomingTransfer.discarding = true;
      incomingTransfer.payloadBuffer = undefined;
      incomingTransfer.payloadLength = 0;
      incomingTransfer.tail = "";
    }
    sendImageReceiverState(true, String(queryId));
  };

  const armReceiverQueryTimeout = () => {
    if (receiverQueryTimeout !== undefined) clearTimeout(receiverQueryTimeout);
    receiverQueryTimeout = setTimeout(() => {
      receiverQueryTimeout = undefined;
      completeReceiverQuery();
    }, IMAGE_RECEIVER_QUERY_IDLE_MS);
    receiverQueryTimeout.unref?.();
  };

  const scheduleTransferTimeout = (ctx, transfer, delay) => {
    transferTimeout = setTimeout(() => {
      if (incomingTransfer !== transfer) return;
      transferTimeout = undefined;
      const idleTime = Date.now() - transfer.lastActivityAt;
      if (idleTime < IMAGE_TRANSFER_TIMEOUT_MS) {
        scheduleTransferTimeout(ctx, transfer, IMAGE_TRANSFER_TIMEOUT_MS - idleTime);
        return;
      }

      transfer.discarding = true;
      transfer.payloadBuffer = undefined;
      transfer.payloadLength = 0;
      ctx.ui.notify(
        "ttyd image transfer timed out; input is discarded until its end marker or another image drop. Restart Pi to reset.",
        "warning",
      );
    }, delay);
    transferTimeout.unref?.();
  };

  const armTransferTimeout = (ctx) => {
    const transfer = incomingTransfer;
    if (!transfer || transfer.discarding) return;

    transfer.lastActivityAt = Date.now();
    if (transferTimeout === undefined) {
      scheduleTransferTimeout(ctx, transfer, IMAGE_TRANSFER_TIMEOUT_MS);
    }
  };

  const updatePendingStatus = (ctx) => {
    const count = pendingImages.length;
    ctx.ui.setStatus(
      "pi-ttyd-images",
      count === 0 ? undefined : `${count} image${count === 1 ? "" : "s"} ready`,
    );
  };

  const acceptImage = (payload, ctx) => {
    const image = decodeImage(payload);
    if (!image) {
      ctx.ui.notify("Rejected an unsupported or invalid ttyd image", "warning");
      return;
    }
    if (pendingImages.length >= MAX_PENDING_IMAGES) {
      ctx.ui.notify(`At most ${MAX_PENDING_IMAGES} images can be attached to one prompt`, "warning");
      return;
    }

    pendingImages.push(image);
    updatePendingStatus(ctx);
    ctx.ui.notify("Image ready for the next prompt", "info");
  };

  const trailingMarkerPrefixLength = (text, marker) => {
    const maxLength = Math.min(text.length, marker.length - 1);
    for (let length = maxLength; length > 0; length--) {
      if (text.endsWith(marker.slice(0, length))) return length;
    }
    return 0;
  };

  const trailingStartPrefixLength = (text) =>
    trailingMarkerPrefixLength(text, IMAGE_TRANSFER_START);

  const trailingTransferMarkerLength = (text) => Math.max(
    trailingMarkerPrefixLength(text, IMAGE_TRANSFER_START),
    trailingMarkerPrefixLength(text, IMAGE_TRANSFER_END),
  );

  const appendTransferPayload = (transfer, body) => {
    if (transfer.discarding || transfer.tooLarge || transfer.invalid || body.length === 0) return;
    if (transfer.payloadLength + body.length > MAX_IMAGE_PAYLOAD_CHARS) {
      transfer.tooLarge = true;
      transfer.payloadBuffer = undefined;
      transfer.payloadLength = 0;
      return;
    }

    for (let index = 0; index < body.length; index++) {
      const character = body.charCodeAt(index);
      if (character > 0x7f) {
        transfer.invalid = true;
        transfer.payloadBuffer = undefined;
        transfer.payloadLength = 0;
        return;
      }
      transfer.payloadBuffer[transfer.payloadLength++] = character;
    }
  };

  const handleTerminalText = (data, ctx) => {
    if (!data) return;

    let modified = Boolean(incomingTransfer || unmatchedStart);
    const passthrough = [];
    while (data.length > 0) {
      if (!incomingTransfer) {
        const combined = unmatchedStart + data;
        unmatchedStart = "";
        const startIndex = combined.indexOf(IMAGE_TRANSFER_START);
        if (startIndex < 0) {
          const partialLength = trailingStartPrefixLength(combined);
          if (partialLength === 0 && !modified) return;
          passthrough.push(combined.slice(0, combined.length - partialLength));
          unmatchedStart = combined.slice(combined.length - partialLength);
          break;
        }

        modified = true;
        passthrough.push(combined.slice(0, startIndex));
        data = combined.slice(startIndex + IMAGE_TRANSFER_START.length);
        incomingTransfer = {
          payloadBuffer: Buffer.alloc(MAX_IMAGE_PAYLOAD_CHARS),
          payloadLength: 0,
          tail: "",
          tooLarge: false,
          invalid: false,
          discarding: false,
          lastActivityAt: Date.now(),
        };
      }

      armTransferTimeout(ctx);
      const transfer = incomingTransfer;
      const combined = transfer.tail + data;
      const endIndex = combined.indexOf(IMAGE_TRANSFER_END);
      const startIndex = transfer.discarding ? combined.indexOf(IMAGE_TRANSFER_START) : -1;
      if (startIndex >= 0 && (endIndex < 0 || startIndex < endIndex)) {
        clearIncomingTransfer();
        data = combined.slice(startIndex);
        modified = true;
        continue;
      }

      const tailLength = trailingTransferMarkerLength(combined);
      const body = endIndex < 0
        ? combined.slice(0, combined.length - tailLength)
        : combined.slice(0, endIndex);
      appendTransferPayload(transfer, body);

      if (endIndex < 0) {
        transfer.tail = tailLength === 0 ? "" : combined.slice(-tailLength);
        break;
      }

      data = combined.slice(endIndex + IMAGE_TRANSFER_END.length);
      const { payloadBuffer, payloadLength, tooLarge, invalid, discarding } = transfer;
      clearIncomingTransfer();
      if (!discarding) {
        if (tooLarge) {
          ctx.ui.notify("ttyd images must be 4 MiB or smaller", "warning");
        } else if (invalid) {
          ctx.ui.notify("Rejected an unsupported or invalid ttyd image", "warning");
        } else {
          acceptImage(payloadBuffer.toString("ascii", 0, payloadLength), ctx);
        }
      }
      modified = true;
    }

    const text = passthrough.join("");
    return text ? { data: text } : { consume: true };
  };

  const handleTerminalInput = (data, ctx) => {
    if (!data) return;

    let modified = false;
    const passthrough = [];
    const processText = (text) => {
      if (!text) return;
      const result = handleTerminalText(text, ctx);
      if (result?.data) {
        modified = true;
        passthrough.push(result.data);
      } else if (result?.consume) {
        modified = true;
      } else {
        passthrough.push(text);
      }
    };

    let index = 0;
    if (pendingReceiverQueryLength > 0) {
      modified = true;
      while (index < data.length && data.charCodeAt(index) === 0) {
        pendingReceiverQueryLength = Math.min(
          pendingReceiverQueryLength + 1,
          IMAGE_RECEIVER_QUERY_PREFIX_LENGTH + MAX_IMAGE_RECEIVER_QUERY_ID + 1,
        );
        index++;
      }
      if (index === data.length) {
        armReceiverQueryTimeout();
        return { consume: true };
      }
      completeReceiverQuery();
    }

    while (index < data.length) {
      const queryStart = data.indexOf("\u0000", index);
      if (queryStart < 0) {
        processText(data.slice(index));
        break;
      }

      modified = true;
      processText(data.slice(index, queryStart));
      let queryEnd = queryStart;
      while (queryEnd < data.length && data.charCodeAt(queryEnd) === 0) queryEnd++;
      pendingReceiverQueryLength = Math.min(
        queryEnd - queryStart,
        IMAGE_RECEIVER_QUERY_PREFIX_LENGTH + MAX_IMAGE_RECEIVER_QUERY_ID + 1,
      );
      if (queryEnd === data.length) {
        armReceiverQueryTimeout();
        break;
      }

      completeReceiverQuery();
      index = queryEnd;
    }

    if (!modified) return;
    const text = passthrough.join("");
    return text ? { data: text } : { consume: true };
  };

  if (notificationsEnabled) {
    pi.registerCommand("ttyd-title", {
      description: "Set the ttyd tab title; omit the title to reset it",
      handler: async (args, ctx) => {
        const title = args.trim() || DEFAULT_TITLE;
        if (CONTROL_CHARACTERS.test(title)) {
          ctx.ui.notify("ttyd title cannot contain control characters", "warning");
          return;
        }

        sendTitle(ctx, title);
        ctx.ui.notify(
          title === DEFAULT_TITLE ? "ttyd title reset" : `ttyd title set to: ${title}`,
          "info",
        );
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    clearReceiverQuery();
    if (receiverEnabled) sendImageReceiverState(false);
    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
    receiverEnabled = false;
    clearIncomingTransfer();
    unmatchedStart = "";
    pendingImages = [];
    updatePendingStatus(ctx);

    if (ctx.mode === "tui") {
      unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => handleTerminalInput(data, ctx));
      receiverEnabled = true;
    }
    if (notificationsEnabled) sendTitle(ctx, DEFAULT_TITLE);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearReceiverQuery();
    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
    if (receiverEnabled) sendImageReceiverState(false);
    receiverEnabled = false;
    clearIncomingTransfer();
    unmatchedStart = "";
    pendingImages = [];
    updatePendingStatus(ctx);
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" || pendingImages.length === 0) {
      return { action: "continue" };
    }

    const images = pendingImages;
    pendingImages = [];
    updatePendingStatus(ctx);
    return { action: "transform", text: event.text, images: [...(event.images ?? []), ...images] };
  });

  if (notificationsEnabled) {
    pi.on("agent_settled", () => {
      const eventId = `${process.pid}:${Date.now()}:${++sequence}`;
      writeTitle(`${READY_MARKER}:${eventId}`);
    });
  }
}
