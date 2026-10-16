# pi-ttyd

A small Pi extension and ttyd client script for browser tab titles, ready
notifications, and image input.

With `PI_TTYD_NOTIFY=1`, the extension resets the tab title to `ttyd` when a Pi
session starts and registers `/ttyd-title <title>` to set a custom title. Run
`/ttyd-title` with no argument to restore `ttyd`. When Pi settles, it sends a
separate private terminal-title marker; the ttyd browser client briefly marks
the tab as `Pi ready` and shows a browser notification if the tab is hidden and
notification permission is granted. Markers contain no prompt, response, or
session text. Settlement means Pi is waiting for input; it does not mean the
task succeeded.

With the client script and extension installed, drop a PNG, JPEG, GIF, or WebP
image onto the ttyd page to attach it to your next prompt. The client confirms
that Pi's TUI receiver is active before sending image data; drops are ignored
when only a shell is running or Pi has exited. The image stays out of the editor
text, and dropping it does not submit the prompt. Each image is limited to 4 MiB,
with up to four images pending per prompt. ttyd must be started writable
(`--writable` or `-W`).

## Install

Install the extension in Pi:

```sh
pi install git:github.com/leocavalcante/pi-ttyd
```

Enable title changes and browser notifications in the environment that starts
ttyd, so Pi inherits the setting:

```sh
PI_TTYD_NOTIFY=1 ttyd ...
```

For a shell function that runs `command ttyd`, prefix that command with
`PI_TTYD_NOTIFY=1`.

When ttyd attaches to a pre-existing tmux session, its environment may not reach
Pi processes in that session. Start Pi from the pane with
`PI_TTYD_NOTIFY=1 pi --continue`, or export the variable before starting Pi.
The tmux window must have `allow-passthrough on`; the extension wraps readiness
and image receiver markers for tmux passthrough.

## Configure ttyd's browser page

The client uses the terminal-title and input APIs exposed by ttyd's xterm
client. Add the contents of [`client.js`](client.js) in a separate `<script>`
tag after ttyd's bundled application script and before `</body>` in the custom
HTML passed with `ttyd --index`. Do not replace or edit ttyd's application
bundle. The page must allow terminal title updates; avoid ttyd's fixed-title
option if you use one. The client keeps the default title `ttyd`, applies
`/ttyd-title` changes, and preserves the chosen title after the temporary
`Pi ready` flash. Start ttyd with `--writable` (`-W`) to enable image input.

Grant notification permission for the ttyd site in your browser's site settings.
The page needs a secure context for the Notification API, such as `localhost`
or HTTPS. Without permission, the title still flashes `Pi ready` for five
seconds when a turn settles.

## Development

```sh
npm test
node --check index.js
node --check client.js
```

Requires Pi 1.3.0 or newer. The extension has no runtime dependencies.

## License

MIT. See [LICENSE](LICENSE).
