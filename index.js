const TITLE_MARKER = "__PI_TTYD__";

export default function register(pi) {
  if (process.env.PI_TTYD_NOTIFY !== "1") return;

  let sequence = 0;
  pi.on("agent_settled", () => {
    const eventId = `${process.pid}:${Date.now()}:${++sequence}`;
    process.stdout.write(`\x1b]2;${TITLE_MARKER}:${eventId}\x07`);
  });
}
