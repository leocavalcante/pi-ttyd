import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const clientSource = await readFile(new URL("../client.js", import.meta.url), "utf8");

test("flashes the ttyd title and notifies for a settled Pi turn in a hidden tab", () => {
  const notifications = [];
  let onMutation;
  const titleElement = {};
  const document = {
    hidden: true,
    title: "ttyd - Terminal",
    querySelector: () => titleElement,
  };
  const window = {
    clearTimeout() {},
    setTimeout() { return 1; },
  };
  class MockMutationObserver {
    constructor(callback) { onMutation = callback; }
    observe() {}
  }
  class MockNotification {
    static permission = "granted";
    constructor(title, options) { notifications.push({ title, options }); }
  }
  window.Notification = MockNotification;

  runInNewContext(clientSource, {
    document,
    window,
    Notification: MockNotification,
    MutationObserver: MockMutationObserver,
  });
  document.title = "__PI_TTYD__:123:456:1 | ttyd - Terminal";
  onMutation();

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "Pi");
  assert.equal(notifications[0].options.body, "Ready for input");
  assert.equal(document.title, "Pi ready | ttyd - Terminal");
});
