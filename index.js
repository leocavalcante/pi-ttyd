const READY_MARKER = "__PI_TTYD__";
const TITLE_MARKER = "__PI_TTYD_TITLE__:";
const DEFAULT_TITLE = "ttyd";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

function terminalTitleSequence(title) {
  const sequence = `\x1b]2;${title}\x07`;
  if (!process.env.TMUX) return sequence;
  return `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

function writeTitle(title) {
  process.stdout.write(terminalTitleSequence(title));
}

function sendTitle(ctx, title) {
  ctx.ui.setTitle(`${TITLE_MARKER}${encodeURIComponent(title)}`);
}

export default function register(pi) {
  if (process.env.PI_TTYD_NOTIFY !== "1") return;

  pi.registerCommand("ttyd-title", {
    description: "Set the ttyd tab title; omit the title to reset it",
    handler: async (args, ctx) => {
      const title = args.trim() || DEFAULT_TITLE;
      if (CONTROL_CHARACTERS.test(title)) {
        ctx.ui.notify("ttyd title cannot contain control characters", "warning");
        return;
      }

      sendTitle(ctx, title);
      ctx.ui.notify(
        title === DEFAULT_TITLE ? "ttyd title reset" : `ttyd title set to: ${title}`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    sendTitle(ctx, DEFAULT_TITLE);
  });

  let sequence = 0;
  pi.on("agent_settled", () => {
    const eventId = `${process.pid}:${Date.now()}:${++sequence}`;
    writeTitle(`${READY_MARKER}:${eventId}`);
  });
}
