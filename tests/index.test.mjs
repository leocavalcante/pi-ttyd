import assert from "node:assert/strict";
import test from "node:test";
import register from "../index.js";

async function withEnvironment(values, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("does not register ttyd behavior unless enabled", async () => {
  await withEnvironment({ PI_TTYD_NOTIFY: undefined, TMUX: undefined }, () => {
    const registrations = [];
    const commands = [];
    register({
      on: (...args) => registrations.push(args),
      registerCommand: (...args) => commands.push(args),
    });
    assert.deepEqual(registrations, []);
    assert.deepEqual(commands, []);
  });
});

test("sets and resets the ttyd tab title", async () => {
  await withEnvironment({ PI_TTYD_NOTIFY: "1", TMUX: undefined }, async () => {
    const events = new Map();
    const commands = new Map();
    register({
      on: (name, handler) => events.set(name, handler),
      registerCommand: (name, options) => commands.set(name, options),
    });

    const titles = [];
    const notices = [];
    const ctx = {
      ui: {
        setTitle: (title) => titles.push(title),
        notify: (...args) => notices.push(args),
      },
    };

    events.get("session_start")({}, ctx);
    assert.equal(titles[0], "__PI_TTYD_TITLE__:ttyd");

    const command = commands.get("ttyd-title");
    assert.ok(command);
    await command.handler("  Checkout — staging  ", ctx);
    assert.equal(titles[1], "__PI_TTYD_TITLE__:Checkout%20%E2%80%94%20staging");
    assert.deepEqual(notices[0], ["ttyd title set to: Checkout — staging", "info"]);

    await command.handler("   ", ctx);
    assert.equal(titles[2], "__PI_TTYD_TITLE__:ttyd");
    assert.deepEqual(notices[1], ["ttyd title reset", "info"]);

    await command.handler("bad\u001btitle", ctx);
    assert.equal(titles.length, 3);
    assert.deepEqual(notices[2], ["ttyd title cannot contain control characters", "warning"]);
  });
});

test("emits a title marker after the agent settles", async () => {
  await withEnvironment({ PI_TTYD_NOTIFY: "1", TMUX: undefined }, () => {
    const events = new Map();
    const originalWrite = process.stdout.write;
    const output = [];
    process.stdout.write = (chunk) => {
      output.push(String(chunk));
      return true;
    };

    try {
      register({
        on: (name, handler) => events.set(name, handler),
        registerCommand() {},
      });
      events.get("agent_settled")();
      assert.match(output[0], /^\x1b\]2;__PI_TTYD__:\d+:\d+:\d+\x07$/);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});

test("wraps the settled marker in tmux passthrough", async () => {
  await withEnvironment({ PI_TTYD_NOTIFY: "1", TMUX: "/tmp/tmux,123,0" }, () => {
    const events = new Map();
    const originalWrite = process.stdout.write;
    const output = [];
    process.stdout.write = (chunk) => {
      output.push(String(chunk));
      return true;
    };

    try {
      register({
        on: (name, handler) => events.set(name, handler),
        registerCommand() {},
      });
      events.get("agent_settled")();
      assert.match(
        output[0],
        /^\x1bPtmux;\x1b\x1b\]2;__PI_TTYD__:\d+:\d+:\d+\x07\x1b\\$/,
      );
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
