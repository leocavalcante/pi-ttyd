import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const clientSource = await readFile(new URL("../client.js", import.meta.url), "utf8");

test("sets explicit titles and restores them after a ready notification", () => {
  const notifications = [];
  let onMutation;
  let restoreTitle;
  const titleElement = {};
  let titleValue = "shell prompt | ttyd";
  const document = {
    hidden: true,
    get title() {
      return titleValue.replace(/[ \t\n\f\r]+/g, " ").trim();
    },
    set title(title) {
      titleValue = title;
    },
    querySelector: () => titleElement,
    addEventListener() {},
  };
  class MockMutationObserver {
    constructor(callback) { onMutation = callback; }
    observe() {}
  }
  class MockNotification {
    static permission = "granted";
    constructor(title, options) { notifications.push({ title, options }); }
  }
  const window = {
    Notification: MockNotification,
    clearTimeout() {},
    setTimeout(callback) {
      restoreTitle = callback;
      return 1;
    },
  };

  runInNewContext(clientSource, {
    document,
    window,
    Notification: MockNotification,
    MutationObserver: MockMutationObserver,
  });
  assert.equal(document.title, "ttyd");
  onMutation();

  const requestedTitle = "Checkout  staging | agent 2";
  const customTitle = "Checkout staging | agent 2";
  document.title = `__PI_TTYD_TITLE__:${encodeURIComponent(requestedTitle)} | ttyd`;
  onMutation();
  assert.equal(document.title, customTitle);
  onMutation();

  document.title = "shell prompt | ttyd";
  onMutation();
  assert.equal(document.title, customTitle);
  onMutation();

  document.title = "__PI_TTYD__:123:456:1 | ttyd";
  onMutation();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "Pi");
  assert.equal(notifications[0].options.body, "Ready for input");
  assert.equal(document.title, `Pi ready | ${customTitle}`);
  onMutation();

  restoreTitle();
  assert.equal(document.title, customTitle);
});

test("prevents image drops from navigating and sends them through ttyd input", async () => {
  const listeners = new Map();
  const terminalInput = [];
  let focused = false;
  const titleElement = {};
  const document = {
    hidden: false,
    title: "ttyd - Terminal",
    querySelector: () => titleElement,
    addEventListener(type, handler, capture) {
      listeners.set(type, handler);
      assert.equal(capture, true);
    },
  };
  const window = {
    clearTimeout() {},
    setTimeout() { return 1; },
    term: {
      focus() { focused = true; },
      input(data, wasUserInput) { terminalInput.push({ data, wasUserInput }); },
    },
  };
  class MockMutationObserver {
    constructor() {}
    observe() {}
  }
  const imageBytes = Uint8Array.of(1, 2, 3, 4);
  const file = {
    name: "sample.png",
    type: "image/png",
    size: imageBytes.length,
    arrayBuffer: async () => imageBytes.buffer,
  };

  runInNewContext(clientSource, {
    document,
    window,
    MutationObserver: MockMutationObserver,
    btoa,
  });

  let dragPrevented = false;
  listeners.get("dragover")({
    dataTransfer: { items: [{ kind: "file", type: "" }] },
    preventDefault() { dragPrevented = true; },
  });
  assert.equal(dragPrevented, true);

  let dropPrevented = false;
  let propagationStopped = false;
  await listeners.get("drop")({
    dataTransfer: { files: [file] },
    preventDefault() { dropPrevented = true; },
    stopPropagation() { propagationStopped = true; },
  });

  const encoded = Buffer.from(imageBytes).toString("base64");
  assert.equal(dropPrevented, true);
  assert.equal(propagationStopped, true);
  assert.equal(focused, true);
  assert.deepEqual(terminalInput.map((entry) => entry.wasUserInput), [true, true, true]);
  assert.equal(
    terminalInput.map((entry) => entry.data).join(""),
    `\u001e__PI_TTYD_IMAGE_V1__image/png\n${encoded}__PI_TTYD_IMAGE_END_V1__`,
  );
});
