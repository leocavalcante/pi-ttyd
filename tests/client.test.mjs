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

test("waits for a Pi receiver and serializes concurrent image drops", async () => {
  const listeners = new Map();
  const terminalInput = [];
  const timeouts = new Map();
  const warnings = [];
  let nextTimeoutId = 0;
  let onMutation;
  let focused = false;
  let firstReadStarted = false;
  let secondReadStarted = false;
  let resolveFirstRead;
  let titleValue = "ttyd - Terminal";
  const titleElement = {};
  const document = {
    hidden: false,
    get title() { return titleValue; },
    set title(title) { titleValue = title; },
    querySelector: () => titleElement,
    addEventListener(type, handler, capture) {
      listeners.set(type, handler);
      assert.equal(capture, true);
    },
  };
  const window = {
    clearTimeout(id) { timeouts.delete(id); },
    setTimeout(callback, delay) {
      const id = ++nextTimeoutId;
      if (delay === 0) queueMicrotask(callback);
      else timeouts.set(id, callback);
      return id;
    },
    term: {
      focus() { focused = true; },
      input(data, wasUserInput) { terminalInput.push({ data, wasUserInput }); },
    },
  };
  class MockMutationObserver {
    constructor(callback) { onMutation = callback; }
    observe() {}
  }
  const firstBytes = Uint8Array.of(1, 2, 3, 4);
  const secondBytes = Uint8Array.of(5, 6, 7, 8);
  const firstFile = {
    name: "first.png",
    type: "image/png",
    size: firstBytes.length,
    arrayBuffer: () => new Promise((resolve) => {
      firstReadStarted = true;
      resolveFirstRead = resolve;
    }),
  };
  const secondFile = {
    name: "second.png",
    type: "image/png",
    size: secondBytes.length,
    arrayBuffer: async () => {
      secondReadStarted = true;
      return secondBytes.buffer;
    },
  };

  runInNewContext(clientSource, {
    document,
    window,
    MutationObserver: MockMutationObserver,
    btoa,
    console: { warn: (...args) => warnings.push(args) },
  });

  let dragPrevented = false;
  listeners.get("dragover")({
    dataTransfer: { items: [{ kind: "file", type: "" }] },
    preventDefault() { dragPrevented = true; },
  });
  assert.equal(dragPrevented, true);

  const dropEvents = [];
  const drop = (file) => listeners.get("drop")({
    dataTransfer: { files: [file] },
    preventDefault() { dropEvents.push("prevented"); },
    stopPropagation() { dropEvents.push("stopped"); },
  });
  const firstDrop = drop(firstFile);
  const secondDrop = drop(secondFile);
  await Promise.resolve();

  const receiverQuery = "\u0000\u0000\u0000";
  assert.deepEqual(terminalInput, [{ data: receiverQuery, wasUserInput: true }]);
  assert.equal(firstReadStarted, false);
  assert.equal(secondReadStarted, false);

  document.title = "__PI_TTYD_IMAGE_RX__:ready | ttyd";
  onMutation();
  await Promise.resolve();
  assert.equal(firstReadStarted, true);
  assert.equal(secondReadStarted, false);
  resolveFirstRead(firstBytes.buffer);
  await Promise.all([firstDrop, secondDrop]);

  const encodedFirst = Buffer.from(firstBytes).toString("base64");
  const encodedSecond = Buffer.from(secondBytes).toString("base64");
  assert.deepEqual(dropEvents, ["prevented", "stopped", "prevented", "stopped"]);
  assert.equal(focused, true);
  assert.equal(secondReadStarted, true);
  assert.deepEqual(terminalInput.map((entry) => entry.wasUserInput), [true, true, true, true, true, true, true]);
  assert.equal(
    terminalInput.slice(1).map((entry) => entry.data).join(""),
    `\u001e__PI_TTYD_IMAGE_V1__image/png\u001f${encodedFirst}__PI_TTYD_IMAGE_END_V1__` +
      `\u001e__PI_TTYD_IMAGE_V1__image/png\u001f${encodedSecond}__PI_TTYD_IMAGE_END_V1__`,
  );

  document.title = "__PI_TTYD_IMAGE_RX__:inactive | ttyd";
  onMutation();
  const inactiveDrop = drop({
    name: "after-exit.png",
    type: "image/png",
    size: 1,
    arrayBuffer() { throw new Error("must not read image without a receiver"); },
  });
  await Promise.resolve();
  assert.equal(terminalInput.length, 8);
  assert.equal(terminalInput.at(-1).data, receiverQuery);
  [...timeouts.values()][0]();
  await inactiveDrop;
  assert.equal(terminalInput.length, 8);
  assert.match(warnings.at(-1)[0], /no active Pi image receiver/);
});

test("does not send dropped image data without an active Pi receiver", async () => {
  const listeners = new Map();
  const terminalInput = [];
  const timeouts = new Map();
  let nextTimeoutId = 0;
  let imageRead = false;
  const warnings = [];
  const titleElement = {};
  const document = {
    hidden: false,
    title: "ttyd - Terminal",
    querySelector: () => titleElement,
    addEventListener(type, handler) { listeners.set(type, handler); },
  };
  const window = {
    clearTimeout(id) { timeouts.delete(id); },
    setTimeout(callback) {
      const id = ++nextTimeoutId;
      timeouts.set(id, callback);
      return id;
    },
    term: {
      focus() {},
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
    arrayBuffer: async () => {
      imageRead = true;
      return imageBytes.buffer;
    },
  };

  runInNewContext(clientSource, {
    document,
    window,
    MutationObserver: MockMutationObserver,
    btoa,
    console: { warn: (...args) => warnings.push(args) },
  });

  const dropPromise = listeners.get("drop")({
    dataTransfer: { files: [file] },
    preventDefault() {},
    stopPropagation() {},
  });
  await Promise.resolve();
  assert.equal(terminalInput.length, 1);
  assert.equal(terminalInput[0].data, "\u0000\u0000\u0000");
  assert.equal(imageRead, false);

  const timeout = [...timeouts.values()][0];
  timeout();
  await dropPromise;
  assert.equal(terminalInput.length, 1);
  assert.equal(imageRead, false);
  assert.match(warnings[0][0], /no active Pi image receiver/);
});
