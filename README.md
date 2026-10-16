# pi-ttyd

A small Pi extension and ttyd client script for browser notifications and image
input.

The extension sends a private terminal-title marker only when
`PI_TTYD_NOTIFY=1`. The ttyd browser client observes that title change, briefly
marks the tab as `Pi ready`, and shows a browser notification if the tab is
hidden and notification permission is granted. The marker contains no prompt,
response, or session text. Settlement means Pi is waiting for input; it does not
mean the task succeeded.

With the client script and extension installed, drop a PNG, JPEG, GIF, or WebP
image onto the ttyd page to attach it to your next prompt. The image stays out
of the editor text, and dropping it does not submit the prompt. Each image is
limited to 4 MiB, with up to four images pending per prompt. ttyd must be
started writable (`--writable` or `-W`).

## Install

Install the extension in Pi:

```sh
pi install git:github.com/leocavalcante/pi-ttyd
```

Enable it in the environment that starts ttyd, so Pi inherits the setting:

```sh
PI_TTYD_NOTIFY=1 ttyd ...
```

For a shell function that runs `command ttyd`, prefix that command with
`PI_TTYD_NOTIFY=1`.

## Configure ttyd's browser page

The client uses the terminal-title and input APIs exposed by ttyd's xterm
client. Add the contents of [`client.js`](client.js) in a separate `<script>`
tag after ttyd's bundled application script and before `</body>` in the custom
HTML passed with `ttyd --index`. Do not replace or edit ttyd's application
bundle. The page must allow terminal title updates; avoid ttyd's fixed-title
option if you use one. Start ttyd with `--writable` (`-W`) to enable image input.

Grant notification permission for the ttyd site in your browser's site settings.
The page needs a secure context for the Notification API, such as `localhost`
or HTTPS. Without permission, the title still flashes `Pi ready` for five
seconds when a turn settles.

## Development

```sh
npm test
node --check client.js
```

Requires Pi 1.3.0 or newer. The extension has no runtime dependencies.

## License

MIT. See [LICENSE](LICENSE).
