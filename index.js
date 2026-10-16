const TITLE_MARKER = "__PI_TTYD__";
const IMAGE_TRANSFER_START = "__PI_TTYD_IMAGE_V1__";
const IMAGE_TRANSFER_END = "__PI_TTYD_IMAGE_END_V1__";
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_PAYLOAD_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32;
const MAX_PENDING_IMAGES = 4;
const IMAGE_TRANSFER_TIMEOUT_MS = 30_000;

function decodeImage(payload) {
  const separator = payload.indexOf("\n");
  if (separator < 0) return undefined;

  const mimeType = payload.slice(0, separator);
  const data = payload.slice(separator + 1);
  if (
    !SUPPORTED_IMAGE_TYPES.has(mimeType) ||
    data.length === 0 ||
    data.length % 4 !== 0 ||
    data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
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
  let sequence = 0;
  let pendingImages = [];
  let incomingTransfer;
  let transferTimeout;
  let unsubscribeTerminalInput;

  const clearIncomingTransfer = () => {
    if (transferTimeout !== undefined) clearTimeout(transferTimeout);
    transferTimeout = undefined;
    incomingTransfer = undefined;
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

  const handleTerminalInput = (data, ctx) => {
    let prefix = "";
    if (!incomingTransfer) {
      const startIndex = data.indexOf(IMAGE_TRANSFER_START);
      if (startIndex < 0) return;

      prefix = data.slice(0, startIndex);
      incomingTransfer = { payload: "", tail: "", tooLarge: false };
      transferTimeout = setTimeout(() => {
        incomingTransfer = undefined;
        transferTimeout = undefined;
        ctx.ui.notify("ttyd image transfer timed out", "warning");
      }, IMAGE_TRANSFER_TIMEOUT_MS);
      transferTimeout.unref?.();
      data = data.slice(startIndex + IMAGE_TRANSFER_START.length);
    }

    const transfer = incomingTransfer;
    const combined = transfer.tail + data;
    const endIndex = combined.indexOf(IMAGE_TRANSFER_END);
    const body = endIndex < 0
      ? combined.slice(0, Math.max(0, combined.length - IMAGE_TRANSFER_END.length + 1))
      : combined.slice(0, endIndex);

    if (!transfer.tooLarge) {
      if (transfer.payload.length + body.length > MAX_IMAGE_PAYLOAD_CHARS) {
        transfer.tooLarge = true;
        transfer.payload = "";
      } else {
        transfer.payload += body;
      }
    }

    if (endIndex < 0) {
      transfer.tail = combined.slice(-Math.min(combined.length, IMAGE_TRANSFER_END.length - 1));
      return prefix ? { data: prefix } : { consume: true };
    }

    const remainder = combined.slice(endIndex + IMAGE_TRANSFER_END.length);
    const { payload, tooLarge } = transfer;
    clearIncomingTransfer();
    if (tooLarge) {
      ctx.ui.notify("ttyd images must be 4 MiB or smaller", "warning");
    } else {
      acceptImage(payload, ctx);
    }

    const passthrough = prefix + remainder;
    return passthrough ? { data: passthrough } : { consume: true };
  };

  pi.on("session_start", (_event, ctx) => {
    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
    clearIncomingTransfer();
    pendingImages = [];
    updatePendingStatus(ctx);

    if (ctx.mode === "tui") {
      unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => handleTerminalInput(data, ctx));
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
    clearIncomingTransfer();
    pendingImages = [];
    updatePendingStatus(ctx);
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" || event.text.startsWith("/") || pendingImages.length === 0) {
      return { action: "continue" };
    }

    const images = pendingImages;
    pendingImages = [];
    updatePendingStatus(ctx);
    return { action: "transform", text: event.text, images: [...(event.images ?? []), ...images] };
  });

  if (process.env.PI_TTYD_NOTIFY === "1") {
    pi.on("agent_settled", () => {
      const eventId = `${process.pid}:${Date.now()}:${++sequence}`;
      process.stdout.write(`\x1b]2;${TITLE_MARKER}:${eventId}\x07`);
    });
  }
}
