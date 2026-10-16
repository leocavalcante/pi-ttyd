import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const clientSource = await readFile(new URL("../client.js", import.meta.url), "utf8");
const imageReceiverQueryStart = "\u0005";
const imageReceiverQueryEnd = "\u0006";
const imageReceiverQueryPrefixLength = 3;
const imageReceiverQueryPrefix = "\u0000".repeat(imageReceiverQueryPrefixLength);

const imageReceiverQueryId = (query) => {
  assert.equal(query.slice(0, imageReceiverQueryPrefixLength), imageReceiverQueryPrefix);
  assert.equal(query[imageReceiverQueryPrefixLength], imageReceiverQueryStart);
  assert.equal(query.at(-1), imageReceiverQueryEnd);
  const payload = query.slice(imageReceiverQueryPrefixLength + 1, -1);
  assert.equal(payload, "\u0000".repeat(payload.length));
  const queryId = String(payload.length);
  assert.match(queryId, /^[1-9]\d{0,3}$/);
  assert.ok(Number(queryId) <= 4096);
  return queryId;
};

const answerImageReceiverQuery = (terminalInput, emitTitle, state = "ready") => {
  const queryId = imageReceiverQueryId(terminalInput.at(-1).data);
  emitTitle(`__PI_TTYD_IMAGE_RX__:${queryId}:${state}`);
  return queryId;
};

const flushUntil = async (predicate) => {
  for (let turn = 0; turn < 20 && !predicate(); turn++) await Promise.resolve();
  assert.ok(predicate(), "expected async client work to advance");
};

const createImageDropHarness = () => {
  const listeners = new Map();
  const terminalInput = [];
  const timeouts = new Map();
  const warnings = [];
  let nextTimeoutId = 0;
  let onTitleChange;
  let titleValue = "ttyd - Terminal";
  const titleElement = {};
  const document = {
    hidden: false,
    get title() { return titleValue; },
    set title(title) { titleValue = title; },
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
      onTitleChange(callback) { onTitleChange = callback; },
      focus() {},
      input(data, wasUserInput) { terminalInput.push({ data, wasUserInput }); },
    },
  };

  runInNewContext(clientSource, {
    document,
    window,
    btoa,
    console: { warn: (...args) => warnings.push(args) },
  });

  const emitTitle = (title, ttydUpdatesAfter = false) => {
    if (!ttydUpdatesAfter) document.title = title;
    onTitleChange(title);
    if (ttydUpdatesAfter) document.title = `${title} | ttyd`;
  };

  return {
    document,
    emitTitle,
    terminalInput,
    timeouts,
    warnings,
    drop(file) {
      return listeners.get("drop")({
        dataTransfer: { files: [file] },
        preventDefault() {},
        stopPropagation() {},
      });
    },
  };
};

test("processes terminal title events and restores its custom title after a ready notification", async () => {
  const notifications = [];
  let onTitleChange;
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
  class MockNotification {
    static permission = "granted";
    constructor(title, options) { notifications.push({ title, options }); }
  }
  const emitTitle = (title) => {
    document.title = title;
    onTitleChange(title);
  };
  const window = {
    Notification: MockNotification,
    clearTimeout() {},
    setTimeout(callback) {
      restoreTitle = callback;
      return 1;
    },
    term: { onTitleChange(callback) { onTitleChange = callback; } },
  };

  runInNewContext(clientSource, { document, window, Notification: MockNotification });
  assert.equal(document.title, "ttyd");

  const requestedTitle = "Checkout  staging | agent 2";
  const customTitle = "Checkout staging | agent 2";
  emitTitle(`__PI_TTYD_TITLE__:${encodeURIComponent(requestedTitle)} | ttyd`);
  await Promise.resolve();
  assert.equal(document.title, customTitle);

  emitTitle("shell prompt | ttyd");
  await Promise.resolve();
  assert.equal(document.title, customTitle);

  emitTitle("__PI_TTYD_TITLE__:%");
  await Promise.resolve();
  assert.equal(document.title, customTitle);

  emitTitle("__PI_TTYD__:123:456:1 | ttyd");
  await Promise.resolve();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "Pi");
  assert.equal(notifications[0].options.body, "Ready for input");
  assert.equal(document.title, `Pi ready | ${customTitle}`);

  restoreTitle();
  assert.equal(document.title, customTitle);
});

test("handles back-to-back receiver and ready title events in either order", async () => {
  for (const order of [["receiver", "ready"], ["ready", "receiver"]]) {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    let imageRead = false;
    const harness = createImageDropHarness();
    const dropPromise = harness.drop({
      name: "back-to-back.png",
      type: "image/png",
      size: bytes.length,
      arrayBuffer: async () => {
        imageRead = true;
        return bytes.buffer;
      },
    });
    await Promise.resolve();
    const queryId = imageReceiverQueryId(harness.terminalInput[0].data);

    for (const event of order) {
      if (event === "receiver") {
        harness.emitTitle(`__PI_TTYD_IMAGE_RX__:${queryId}:ready`);
      } else {
        harness.emitTitle("__PI_TTYD__:1:2:3");
      }
    }

    await flushUntil(() => imageRead && harness.terminalInput.length === 2);
    await Promise.resolve();
    const recheckQueryId = imageReceiverQueryId(harness.terminalInput.at(-1).data);
    harness.emitTitle(`__PI_TTYD_IMAGE_RX__:${recheckQueryId}:ready`);
    await dropPromise;
    assert.equal(imageRead, true);
    assert.equal(harness.document.title, "Pi ready | ttyd");
  }
});

test("reconciles the managed title after ttyd title listeners in either order", async () => {
  const harness = createImageDropHarness();

  harness.emitTitle("__PI_TTYD_TITLE__:Managed%20title", true);
  await Promise.resolve();
  assert.equal(harness.document.title, "Managed title");

  harness.emitTitle("Managed title", true);
  await Promise.resolve();
  assert.equal(harness.document.title, "Managed title");

  harness.emitTitle("__PI_TTYD_TITLE__:Managed%20title | ttyd");
  await Promise.resolve();
  assert.equal(harness.document.title, "Managed title");
});

test("subscribes after ttyd initializes the terminal", async () => {
  let retrySubscription;
  let titleListener;
  let titleValue = "ttyd - Terminal";
  const titleElement = {};
  const document = {
    hidden: false,
    get title() { return titleValue; },
    set title(title) { titleValue = title; },
    querySelector: () => titleElement,
    addEventListener() {},
  };
  const window = {
    clearTimeout() {},
    setTimeout(callback, delay) {
      assert.equal(delay, 50);
      retrySubscription = callback;
      return 1;
    },
    term: undefined,
  };

  runInNewContext(clientSource, { document, window, btoa });
  assert.equal(typeof retrySubscription, "function");
  window.term = { onTitleChange(callback) { titleListener = callback; } };
  retrySubscription();
  titleListener("__PI_TTYD_TITLE__:Initialized%20late");
  await Promise.resolve();
  assert.equal(document.title, "Initialized late");
});

test("waits for a Pi receiver and serializes concurrent image drops", async () => {
  const listeners = new Map();
  const terminalInput = [];
  const timeouts = new Map();
  const warnings = [];
  let nextTimeoutId = 0;
  let onTitleChange;
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
      assert.notEqual(delay, 0, "image transfer chunks must not yield to keyboard input");
      const id = ++nextTimeoutId;
      timeouts.set(id, callback);
      return id;
    },
    term: {
      onTitleChange(callback) { onTitleChange = callback; },
      focus() { focused = true; },
      input(data, wasUserInput) { terminalInput.push({ data, wasUserInput }); },
    },
  };
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

  const emitTitle = (title) => {
    document.title = title;
    onTitleChange(title);
  };
  runInNewContext(clientSource, {
    document,
    window,
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

  assert.equal(terminalInput.length, 1);
  const initialQueryId = imageReceiverQueryId(terminalInput[0].data);
  assert.equal(firstReadStarted, false);
  assert.equal(secondReadStarted, false);

  answerImageReceiverQuery(terminalInput, emitTitle);
  await Promise.resolve();
  assert.equal(firstReadStarted, true);
  assert.equal(secondReadStarted, false);
  resolveFirstRead(firstBytes.buffer);
  await flushUntil(() => terminalInput.filter((entry) => entry.data.startsWith(imageReceiverQueryPrefix)).length >= 2);
  const firstSendQueryId = answerImageReceiverQuery(terminalInput, emitTitle);
  await firstDrop;
  assert.equal(secondReadStarted, false);
  await flushUntil(() => terminalInput.filter((entry) => entry.data.startsWith(imageReceiverQueryPrefix)).length >= 3);

  const secondDropQueryId = answerImageReceiverQuery(terminalInput, emitTitle);
  await flushUntil(() => secondReadStarted && terminalInput.filter((entry) => entry.data.startsWith(imageReceiverQueryPrefix)).length >= 4);
  const secondSendQueryId = answerImageReceiverQuery(terminalInput, emitTitle);
  assert.notEqual(firstSendQueryId, secondDropQueryId);
  assert.notEqual(secondDropQueryId, secondSendQueryId);
  await secondDrop;

  const encodedFirst = Buffer.from(firstBytes).toString("base64");
  const encodedSecond = Buffer.from(secondBytes).toString("base64");
  assert.deepEqual(dropEvents, ["prevented", "stopped", "prevented", "stopped"]);
  assert.equal(focused, true);
  assert.equal(secondReadStarted, true);
  assert.ok(terminalInput.every((entry) => entry.wasUserInput));
  assert.equal(
    terminalInput
      .filter((entry) => !entry.data.startsWith(imageReceiverQueryPrefix))
      .map((entry) => entry.data)
      .join(""),
    `\u001e__PI_TTYD_IMAGE_V1__image/png\u001f${encodedFirst}__PI_TTYD_IMAGE_END_V1__` +
      `\u001e__PI_TTYD_IMAGE_V1__image/png\u001f${encodedSecond}__PI_TTYD_IMAGE_END_V1__`,
  );

  const dropAfterUnmarkedExit = drop({
    name: "after-exit.png",
    type: "image/png",
    size: 1,
    arrayBuffer() { throw new Error("must not read image without a receiver"); },
  });
  await Promise.resolve();
  assert.equal(terminalInput.length, 11);
  imageReceiverQueryId(terminalInput.at(-1).data);
  [...timeouts.values()][0]();
  await dropAfterUnmarkedExit;
  assert.equal(terminalInput.length, 11);
  assert.match(warnings.at(-1)[0], /no active Pi image receiver/);
});

test("rechecks readiness after an unmarked Pi exit during an image read", async () => {
  const bytes = Uint8Array.of(1, 2, 3, 4);
  let imageReadStarted = false;
  let resolveRead;
  const file = {
    name: "pending.png",
    type: "image/png",
    size: bytes.length,
    arrayBuffer: () => new Promise((resolve) => {
      imageReadStarted = true;
      resolveRead = resolve;
    }),
  };
  const harness = createImageDropHarness();
  const dropPromise = harness.drop(file);
  await Promise.resolve();
  const initialQueryId = answerImageReceiverQuery(harness.terminalInput, harness.emitTitle);
  await Promise.resolve();
  assert.equal(imageReadStarted, true);

  resolveRead(bytes.buffer);
  await flushUntil(() => harness.terminalInput.length === 2);
  const finalQueryId = imageReceiverQueryId(harness.terminalInput.at(-1).data);
  assert.notEqual(finalQueryId, initialQueryId);
  assert.equal(harness.timeouts.size, 1);

  [...harness.timeouts.values()][0]();
  await dropPromise;
  assert.equal(harness.terminalInput.length, 2);
  assert.ok(harness.terminalInput.every((entry) => entry.data.startsWith(imageReceiverQueryPrefix)));
});

test("ignores late readiness replies for earlier receiver queries", async () => {
  const bytes = Uint8Array.of(1, 2, 3, 4);
  let imageRead = false;
  const file = {
    name: "late.png",
    type: "image/png",
    size: bytes.length,
    arrayBuffer: async () => {
      imageRead = true;
      return bytes.buffer;
    },
  };
  const harness = createImageDropHarness();
  const firstDrop = harness.drop(file);
  await Promise.resolve();
  const firstQueryId = imageReceiverQueryId(harness.terminalInput[0].data);
  [...harness.timeouts.values()][0]();
  await firstDrop;

  const secondDrop = harness.drop(file);
  await flushUntil(() => harness.terminalInput.length === 2);
  const secondQueryId = imageReceiverQueryId(harness.terminalInput.at(-1).data);
  assert.notEqual(secondQueryId, firstQueryId);

  harness.emitTitle(`__PI_TTYD_IMAGE_RX__:${firstQueryId}:ready`);
  await Promise.resolve();
  assert.equal(imageRead, false);
  assert.equal(harness.terminalInput.length, 2);
  assert.equal(harness.timeouts.size, 1);

  [...harness.timeouts.values()][0]();
  await secondDrop;
  assert.equal(imageRead, false);
  assert.equal(harness.terminalInput.length, 2);
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
      onTitleChange() {},
      focus() {},
      input(data, wasUserInput) { terminalInput.push({ data, wasUserInput }); },
    },
  };
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
  imageReceiverQueryId(terminalInput[0].data);
  assert.equal(imageRead, false);

  const timeout = [...timeouts.values()][0];
  timeout();
  await dropPromise;
  assert.equal(terminalInput.length, 1);
  assert.equal(imageRead, false);
  assert.match(warnings[0][0], /no active Pi image receiver/);
});
