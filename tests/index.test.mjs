import assert from "node:assert/strict";
import test from "node:test";
import register from "../index.js";

function withEnvironment(value, callback) {
  const previous = process.env.PI_TTYD_NOTIFY;
  if (value === undefined) delete process.env.PI_TTYD_NOTIFY;
  else process.env.PI_TTYD_NOTIFY = value;

  try {
    callback();
  } finally {
    if (previous === undefined) delete process.env.PI_TTYD_NOTIFY;
    else process.env.PI_TTYD_NOTIFY = previous;
  }
}

test("registers image input handling without enabling title notifications", () => {
  withEnvironment(undefined, () => {
    const registrations = [];
    register({ on: (...args) => registrations.push(args) });
    assert.deepEqual(registrations.map(([event]) => event), ["session_start", "session_shutdown", "input"]);
  });
});

test("captures a streamed image and attaches it to the next interactive prompt", () => {
  const handlers = new Map();
  const statuses = [];
  const notifications = [];
  let terminalInput;
  withEnvironment(undefined, () => {
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

test("rejects unsupported image payloads", () => {
  const handlers = new Map();
  const notifications = [];
  let terminalInput;
  withEnvironment(undefined, () => {
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

test("emits a title marker after the agent settles", () => {
  withEnvironment("1", () => {
    const registrations = [];
    const output = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      output.push(String(chunk));
      return true;
    };

    try {
      register({ on: (...args) => registrations.push(args) });
      const settledHandler = registrations.find(([event]) => event === "agent_settled")?.[1];
      assert.equal(typeof settledHandler, "function");

      settledHandler();
      assert.match(output[0], /^\x1b\]2;__PI_TTYD__:\d+:\d+:\d+\x07$/);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
