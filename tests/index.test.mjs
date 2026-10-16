import assert from "node:assert/strict";
import test from "node:test";
import register from "../index.js";

async function withEnvironment(value, callback) {
  const previous = process.env.PI_TTYD_NOTIFY;
  if (value === undefined) delete process.env.PI_TTYD_NOTIFY;
  else process.env.PI_TTYD_NOTIFY = value;

  try {
    await callback();
  } finally {
    if (previous === undefined) delete process.env.PI_TTYD_NOTIFY;
    else process.env.PI_TTYD_NOTIFY = previous;
  }
}

test("registers image input without enabling title notifications", async () => {
  await withEnvironment(undefined, () => {
    const registrations = [];
    const commands = [];
    register({
      on: (...args) => registrations.push(args),
      registerCommand: (...args) => commands.push(args),
    });
    assert.deepEqual(registrations.map(([event]) => event), ["session_start", "session_shutdown", "input"]);
    assert.deepEqual(commands, []);
  });
});

test("sets and resets the ttyd tab title", async () => {
  await withEnvironment("1", async () => {
    const events = new Map();
    const commands = new Map();
    register({
      on: (name, handler) => events.set(name, handler),
      registerCommand: (name, options) => commands.set(name, options),
    });

    const titles = [];
    const notices = [];
    const ctx = {
      mode: "print",
      ui: {
        setTitle: (title) => titles.push(title),
        setStatus() {},
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
  await withEnvironment("1", () => {
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

test("captures a streamed image and attaches it to the next interactive prompt", async () => {
  const handlers = new Map();
  const statuses = [];
  const notifications = [];
  let terminalInput;
  await withEnvironment(undefined, () => {
    register({ on: (event, handler) => handlers.set(event, handler) });
  });

  const ctx = {
    mode: "tui",
    ui: {
      onTerminalInput: (handler) => {
        terminalInput = handler;
        return () => { terminalInput = undefined; };
      },
      setStatus: (...args) => statuses.push(args),
      notify: (...args) => notifications.push(args),
    },
  };
  handlers.get("session_start")({}, ctx);

  const imageBytes = Buffer.from("test image");
  const imageData = imageBytes.toString("base64");
  const start = "__PI_TTYD_IMAGE_V1__";
  const end = "__PI_TTYD_IMAGE_END_V1__";
  assert.deepEqual(terminalInput(`${start}image/png\n${imageData.slice(0, 3)}`), { consume: true });
  assert.deepEqual(terminalInput(`${imageData.slice(3)}${end.slice(0, 7)}`), { consume: true });
  assert.deepEqual(terminalInput(end.slice(7)), { consume: true });
  assert.deepEqual(statuses.at(-1), ["pi-ttyd-images", "1 image ready"]);
  assert.deepEqual(notifications.at(-1), ["Image ready for the next prompt", "info"]);

  const inputHandler = handlers.get("input");
  assert.deepEqual(inputHandler({ source: "rpc", text: "not this prompt" }, ctx), { action: "continue" });
  assert.deepEqual(inputHandler({ source: "interactive", text: "/model" }, ctx), { action: "continue" });
  assert.deepEqual(inputHandler({ source: "interactive", text: "Describe it", images: [] }, ctx), {
    action: "transform",
    text: "Describe it",
    images: [{ type: "image", mimeType: "image/png", data: imageData }],
  });
  assert.deepEqual(statuses.at(-1), ["pi-ttyd-images", undefined]);
  assert.deepEqual(inputHandler({ source: "interactive", text: "Next" }, ctx), { action: "continue" });
});

test("rejects unsupported image payloads", async () => {
  const handlers = new Map();
  const notifications = [];
  let terminalInput;
  await withEnvironment(undefined, () => {
    register({ on: (event, handler) => handlers.set(event, handler) });
  });
  const ctx = {
    mode: "tui",
    ui: {
      onTerminalInput: (handler) => { terminalInput = handler; return () => {}; },
      setStatus() {},
      notify: (...args) => notifications.push(args),
    },
  };
  handlers.get("session_start")({}, ctx);

  const result = terminalInput("__PI_TTYD_IMAGE_V1__image/svg+xml\nPHN2Zz4=__PI_TTYD_IMAGE_END_V1__");
  assert.deepEqual(result, { consume: true });
  assert.deepEqual(notifications, [["Rejected an unsupported or invalid ttyd image", "warning"]]);
  assert.deepEqual(handlers.get("input")({ source: "interactive", text: "Describe it" }, ctx), { action: "continue" });
});
