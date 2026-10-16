import assert from "node:assert/strict";
import test from "node:test";
import register from "../index.js";

const imageReceiverQueryPrefix = "\u0000".repeat(3);
const imageReceiverQueryStart = "\u0005";
const imageReceiverQueryEnd = "\u0006";
const imageReceiverQuery = (id) =>
  `${imageReceiverQueryPrefix}${imageReceiverQueryStart}${"\u0000".repeat(id)}${imageReceiverQueryEnd}`;

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

test("registers image input without enabling title notifications", async () => {
  await withEnvironment({ PI_TTYD_NOTIFY: undefined, TMUX: undefined }, () => {
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

test("answers explicitly framed receiver queries split by delayed terminal reads", async () => {
  const handlers = new Map();
  const output = [];
  let terminalInput;
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, ...args) => {
    const text = String(chunk);
    if (text.startsWith("\x1b]2;__PI_TTYD_IMAGE_RX__:")) {
      output.push(text);
      return true;
    }
    return originalWrite.call(process.stdout, chunk, ...args);
  };

  try {
    await withEnvironment({ PI_TTYD_NOTIFY: undefined, TMUX: undefined }, async () => {
      register({ on: (event, handler) => handlers.set(event, handler) });
      const ctx = {
        mode: "tui",
        ui: {
          onTerminalInput: (handler) => { terminalInput = handler; return () => { terminalInput = undefined; }; },
          setStatus() {},
          notify() {},
        },
      };
      handlers.get("session_start")({}, ctx);
      const query = imageReceiverQuery(12);
      assert.deepEqual(
        terminalInput(`typed ${query.slice(0, imageReceiverQueryPrefix.length)}`),
        { data: `typed ${imageReceiverQueryPrefix}` },
      );
      assert.deepEqual(output, []);
      await new Promise((resolve) => setTimeout(resolve, 35));
      assert.deepEqual(terminalInput(query.slice(3, 4)), { consume: true });
      assert.deepEqual(output, []);
      await new Promise((resolve) => setTimeout(resolve, 35));
      assert.deepEqual(terminalInput(query.slice(4, 8)), { consume: true });
      assert.deepEqual(output, []);
      await new Promise((resolve) => setTimeout(resolve, 35));
      assert.deepEqual(terminalInput(query.slice(8, -1)), { consume: true });
      assert.deepEqual(output, []);
      assert.deepEqual(terminalInput(query.slice(-1)), { consume: true });
      assert.deepEqual(output, ["\x1b]2;__PI_TTYD_IMAGE_RX__:12:ready\x07"]);

      handlers.get("session_shutdown")({}, ctx);
      assert.deepEqual(output, [
        "\x1b]2;__PI_TTYD_IMAGE_RX__:12:ready\x07",
        "\x1b]2;__PI_TTYD_IMAGE_RX__:inactive\x07",
      ]);
      assert.equal(terminalInput, undefined);
    });
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("resynchronizes after a split receiver query interrupts an image transfer", () => {
  const handlers = new Map();
  const output = [];
  let terminalInput;
  const originalWrite = process.stdout.write;
  const originalNotify = process.env.PI_TTYD_NOTIFY;
  const originalTmux = process.env.TMUX;
  delete process.env.PI_TTYD_NOTIFY;
  delete process.env.TMUX;
  process.stdout.write = (chunk) => {
    output.push(String(chunk));
    return true;
  };

  try {
    register({ on: (event, handler) => handlers.set(event, handler) });
    const ctx = {
      mode: "tui",
      ui: {
        onTerminalInput: (handler) => { terminalInput = handler; return () => {}; },
        setStatus() {},
        notify() {},
      },
    };
    handlers.get("session_start")({}, ctx);

    const start = "\u001e__PI_TTYD_IMAGE_V1__";
    const end = "__PI_TTYD_IMAGE_END_V1__";
    const partialData = Buffer.from("interrupted image").toString("base64");
    assert.deepEqual(terminalInput(`${start}image/png\u001f${partialData}${end.slice(0, 6)}`), { consume: true });

    const firstQuery = imageReceiverQuery(2);
    assert.deepEqual(terminalInput(firstQuery.slice(0, 3)), { data: imageReceiverQueryPrefix });
    assert.deepEqual(terminalInput(firstQuery.slice(3, 4)), { consume: true });
    assert.deepEqual(terminalInput(firstQuery.slice(4)), { consume: true });
    assert.deepEqual(output, ["\x1b]2;__PI_TTYD_IMAGE_RX__:2:ready\x07"]);

    const secondQuery = imageReceiverQuery(3);
    assert.deepEqual(terminalInput(secondQuery), { data: imageReceiverQueryPrefix });
    assert.deepEqual(output, [
      "\x1b]2;__PI_TTYD_IMAGE_RX__:2:ready\x07",
      "\x1b]2;__PI_TTYD_IMAGE_RX__:3:ready\x07",
    ]);

    const recoveredData = Buffer.from("recovered image").toString("base64");
    assert.deepEqual(
      terminalInput(`${start}image/jpeg\u001f${recoveredData}${end}`),
      { consume: true },
    );
    assert.deepEqual(handlers.get("input")({ source: "interactive", text: "Describe it" }, ctx), {
      action: "transform",
      text: "Describe it",
      images: [{ type: "image", mimeType: "image/jpeg", data: recoveredData }],
    });
    handlers.get("session_shutdown")({}, ctx);
  } finally {
    process.stdout.write = originalWrite;
    if (originalNotify === undefined) delete process.env.PI_TTYD_NOTIFY;
    else process.env.PI_TTYD_NOTIFY = originalNotify;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
  }
});

test("preserves ordinary controls and emits no receiver markers before a handshake", () => {
  const handlers = new Map();
  const output = [];
  let terminalInput;
  const originalWrite = process.stdout.write;
  const originalNotify = process.env.PI_TTYD_NOTIFY;
  const originalTmux = process.env.TMUX;
  delete process.env.PI_TTYD_NOTIFY;
  delete process.env.TMUX;
  process.stdout.write = (chunk) => {
    output.push(String(chunk));
    return true;
  };

  try {
    register({ on: (event, handler) => handlers.set(event, handler) });
    const ctx = {
      mode: "tui",
      ui: {
        onTerminalInput: (handler) => { terminalInput = handler; return () => {}; },
        setStatus() {},
        notify() {},
      },
    };
    handlers.get("session_start")({}, ctx);
    assert.deepEqual(terminalInput("\u0000"), { data: "\u0000" });
    assert.deepEqual(terminalInput(imageReceiverQueryStart), { data: imageReceiverQueryStart });
    assert.deepEqual(terminalInput(imageReceiverQueryEnd), { data: imageReceiverQueryEnd });
    assert.deepEqual(terminalInput("\u0000"), { data: "\u0000" });
    handlers.get("session_shutdown")({}, ctx);
    assert.deepEqual(output, []);
  } finally {
    process.stdout.write = originalWrite;
    if (originalNotify === undefined) delete process.env.PI_TTYD_NOTIFY;
    else process.env.PI_TTYD_NOTIFY = originalNotify;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
  }
});

test("clears partial image starts after a receiver query", () => {
  const handlers = new Map();
  const output = [];
  let terminalInput;
  const originalWrite = process.stdout.write;
  const originalNotify = process.env.PI_TTYD_NOTIFY;
  const originalTmux = process.env.TMUX;
  delete process.env.PI_TTYD_NOTIFY;
  delete process.env.TMUX;
  process.stdout.write = (chunk) => {
    output.push(String(chunk));
    return true;
  };

  try {
    register({ on: (event, handler) => handlers.set(event, handler) });
    const ctx = {
      mode: "tui",
      ui: {
        onTerminalInput: (handler) => { terminalInput = handler; return () => {}; },
        setStatus() {},
        notify() {},
      },
    };
    handlers.get("session_start")({}, ctx);

    const start = "\u001e__PI_TTYD_IMAGE_V1__";
    const end = "__PI_TTYD_IMAGE_END_V1__";
    const query = imageReceiverQuery(2);
    const data = Buffer.from("recovered from a partial start").toString("base64");
    assert.deepEqual(terminalInput(start.slice(0, 6)), { consume: true });
    assert.deepEqual(terminalInput(query), { data: imageReceiverQueryPrefix });
    assert.deepEqual(terminalInput(`${start}image/png\u001f${data}${end}`), { consume: true });
    assert.deepEqual(handlers.get("input")({ source: "interactive", text: "Describe it" }, ctx), {
      action: "transform",
      text: "Describe it",
      images: [{ type: "image", mimeType: "image/png", data }],
    });
    handlers.get("session_shutdown")({}, ctx);
    assert.deepEqual(output, [
      "\x1b]2;__PI_TTYD_IMAGE_RX__:2:ready\x07",
      "\x1b]2;__PI_TTYD_IMAGE_RX__:inactive\x07",
    ]);
  } finally {
    process.stdout.write = originalWrite;
    if (originalNotify === undefined) delete process.env.PI_TTYD_NOTIFY;
    else process.env.PI_TTYD_NOTIFY = originalNotify;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
  }
});

test("captures a streamed image and attaches it to the next interactive prompt", async () => {
  const handlers = new Map();
  const statuses = [];
  const notifications = [];
  let terminalInput;
  await withEnvironment({ PI_TTYD_NOTIFY: undefined, TMUX: undefined }, () => {
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
  await withEnvironment(
    { PI_TTYD_NOTIFY: undefined, TMUX: undefined },
    () => handlers.get("session_start")({}, ctx),
  );

  const imageBytes = Buffer.from("test image");
  const imageData = imageBytes.toString("base64");
  const start = "\u001e__PI_TTYD_IMAGE_V1__";
  const end = "__PI_TTYD_IMAGE_END_V1__";
  assert.deepEqual(terminalInput(`${start}image/png\u001f${imageData.slice(0, 3)}`), { consume: true });
  assert.deepEqual(terminalInput(`${imageData.slice(3)}${end.slice(0, 7)}`), { consume: true });
  assert.deepEqual(terminalInput(end.slice(7)), { consume: true });
  assert.deepEqual(statuses.at(-1), ["pi-ttyd-images", "1 image ready"]);
  assert.deepEqual(notifications.at(-1), ["Image ready for the next prompt", "info"]);

  const inputHandler = handlers.get("input");
  assert.deepEqual(inputHandler({ source: "rpc", text: "not this prompt" }, ctx), { action: "continue" });
  assert.deepEqual(inputHandler({ source: "interactive", text: "/skill:review Describe it", images: [] }, ctx), {
    action: "transform",
    text: "/skill:review Describe it",
    images: [{ type: "image", mimeType: "image/png", data: imageData }],
  });
  assert.deepEqual(statuses.at(-1), ["pi-ttyd-images", undefined]);
  assert.deepEqual(inputHandler({ source: "interactive", text: "Next" }, ctx), { action: "continue" });
});

test("buffers a split image start marker without leaking it", async () => {
  const handlers = new Map();
  let terminalInput;
  await withEnvironment({ PI_TTYD_NOTIFY: undefined, TMUX: undefined }, () => {
    register({ on: (event, handler) => handlers.set(event, handler) });
  });
  const ctx = {
    mode: "tui",
    ui: {
      onTerminalInput: (handler) => { terminalInput = handler; return () => {}; },
      setStatus() {},
      notify() {},
    },
  };
  await withEnvironment(
    { PI_TTYD_NOTIFY: undefined, TMUX: undefined },
    () => handlers.get("session_start")({}, ctx),
  );

  const start = "\u001e__PI_TTYD_IMAGE_V1__";
  const end = "__PI_TTYD_IMAGE_END_V1__";
  const imageData = Buffer.from("split marker").toString("base64");
  assert.equal(terminalInput("ordinary_"), undefined);
  assert.deepEqual(terminalInput(`typed ${start.slice(0, 8)}`), { data: "typed " });
  for (const character of `${start.slice(8)}image/png\u001f${imageData}${end}`) terminalInput(character);
  assert.deepEqual(handlers.get("input")({ source: "interactive", text: "Describe it" }, ctx), {
    action: "transform",
    text: "Describe it",
    images: [{ type: "image", mimeType: "image/png", data: imageData }],
  });
});

test("attaches multiple image frames coalesced into one terminal read", async () => {
  const handlers = new Map();
  const statuses = [];
  let terminalInput;
  await withEnvironment({ PI_TTYD_NOTIFY: undefined, TMUX: undefined }, () => {
    register({ on: (event, handler) => handlers.set(event, handler) });
  });
  const ctx = {
    mode: "tui",
    ui: {
      onTerminalInput: (handler) => { terminalInput = handler; return () => {}; },
      setStatus: (...args) => statuses.push(args),
      notify() {},
    },
  };
  await withEnvironment(
    { PI_TTYD_NOTIFY: undefined, TMUX: undefined },
    () => handlers.get("session_start")({}, ctx),
  );

  const start = "\u001e__PI_TTYD_IMAGE_V1__";
  const end = "__PI_TTYD_IMAGE_END_V1__";
  const pngData = Buffer.from("first image").toString("base64");
  const jpegData = Buffer.from("second image").toString("base64");
  const frames = `${start}image/png\u001f${pngData}${end}${start}image/jpeg\u001f${jpegData}${end}`;
  assert.deepEqual(terminalInput(`typed ${frames} text`), { data: "typed  text" });
  assert.deepEqual(statuses.at(-1), ["pi-ttyd-images", "2 images ready"]);
  assert.deepEqual(handlers.get("input")({ source: "interactive", text: "Describe them" }, ctx), {
    action: "transform",
    text: "Describe them",
    images: [
      { type: "image", mimeType: "image/png", data: pngData },
      { type: "image", mimeType: "image/jpeg", data: jpegData },
    ],
  });
});

test("uses one inactivity timer and discards stalled transfers before resynchronizing", async () => {
  const handlers = new Map();
  const notifications = [];
  let terminalInput;
  await withEnvironment({ PI_TTYD_NOTIFY: undefined, TMUX: undefined }, () => {
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
  await withEnvironment(
    { PI_TTYD_NOTIFY: undefined, TMUX: undefined },
    () => handlers.get("session_start")({}, ctx),
  );

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalNow = Date.now;
  const timers = new Map();
  let nextTimerId = 0;
  let now = 0;
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const fireTimeout = (id = [...timers.keys()].at(-1)) => {
    const timer = timers.get(id);
    timers.delete(id);
    timer.callback();
  };

  try {
    const start = "\u001e__PI_TTYD_IMAGE_V1__";
    const end = "__PI_TTYD_IMAGE_END_V1__";
    const oldData = Buffer.from("stalled image").toString("base64");
    const firstFramePart = `${start}image/png\u001f${oldData.slice(0, 4)}`;
    for (const character of firstFramePart) terminalInput(character);
    const firstTimer = [...timers.keys()][0];
    assert.equal(timers.size, 1);

    now = 20_000;
    for (const character of oldData.slice(4, 8)) terminalInput(character);
    assert.equal(timers.size, 1);
    assert.equal(timers.has(firstTimer), true);

    now = 30_000;
    fireTimeout(firstTimer);
    assert.equal(notifications.length, 0);
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].delay, 20_000);

    now = 50_000;
    fireTimeout();
    assert.match(notifications.at(-1)[0], /discarded until its end marker or another image drop/);
    assert.deepEqual(terminalInput("\u0003\u0004"), { data: "\u0003\u0004" });
    assert.deepEqual(terminalInput("still discarded"), { consume: true });
    assert.deepEqual(terminalInput(`${oldData.slice(8)}${end}`), { consume: true });
    assert.equal(terminalInput("ordinary_"), undefined);

    terminalInput(`${start}image/png\u001f${oldData.slice(0, 4)}`);
    now = 80_000;
    fireTimeout();
    const recoveredData = Buffer.from("recovered image").toString("base64");
    assert.deepEqual(terminalInput(`${start}image/jpeg\u001f${recoveredData}${end}`), { consume: true });
    assert.deepEqual(handlers.get("input")({ source: "interactive", text: "Describe it" }, ctx), {
      action: "transform",
      text: "Describe it",
      images: [{ type: "image", mimeType: "image/jpeg", data: recoveredData }],
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Date.now = originalNow;
  }
});

test("rejects unsupported image payloads", async () => {
  const handlers = new Map();
  const notifications = [];
  let terminalInput;
  await withEnvironment({ PI_TTYD_NOTIFY: undefined, TMUX: undefined }, () => {
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
  await withEnvironment(
    { PI_TTYD_NOTIFY: undefined, TMUX: undefined },
    () => handlers.get("session_start")({}, ctx),
  );

  const result = terminalInput("\u001e__PI_TTYD_IMAGE_V1__image/svg+xml\u001fPHN2Zz4=__PI_TTYD_IMAGE_END_V1__");
  assert.deepEqual(result, { consume: true });
  assert.deepEqual(notifications, [["Rejected an unsupported or invalid ttyd image", "warning"]]);
  assert.deepEqual(handlers.get("input")({ source: "interactive", text: "Describe it" }, ctx), { action: "continue" });
});

test("wraps terminal markers in tmux passthrough", async () => {
  await withEnvironment({ PI_TTYD_NOTIFY: "1", TMUX: "/tmp/tmux,123,0" }, () => {
    const events = new Map();
    let terminalInput;
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
      const ctx = {
        mode: "tui",
        ui: {
          onTerminalInput: (handler) => { terminalInput = handler; return () => {}; },
          setTitle() {},
          setStatus() {},
          notify() {},
        },
      };
      events.get("session_start")({}, ctx);
      const query = imageReceiverQuery(12);
      assert.deepEqual(terminalInput(query), { data: imageReceiverQueryPrefix });
      events.get("agent_settled")();
      events.get("session_shutdown")({}, ctx);

      assert.match(output[0], /^\x1bPtmux;\x1b\x1b\]2;__PI_TTYD_IMAGE_RX__:12:ready\x07\x1b\\$/);
      assert.match(output[1], /^\x1bPtmux;\x1b\x1b\]2;__PI_TTYD__:\d+:\d+:\d+\x07\x1b\\$/);
      assert.match(output[2], /^\x1bPtmux;\x1b\x1b\]2;__PI_TTYD_IMAGE_RX__:inactive\x07\x1b\\$/);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
