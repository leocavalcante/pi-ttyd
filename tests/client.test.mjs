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
  const document = {
    hidden: true,
    title: "shell prompt | ttyd",
    querySelector: () => titleElement,
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

  const customTitle = "Checkout — staging | agent 2";
  document.title = `__PI_TTYD_TITLE__:${encodeURIComponent(customTitle)} | ttyd`;
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
