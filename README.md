# pi-ttyd

A small Pi extension and ttyd client script that set the browser tab title and
notify you when Pi has settled and is waiting for input.

With `PI_TTYD_NOTIFY=1`, the extension resets the tab title to `ttyd` when a Pi
session starts and registers `/ttyd-title <title>` to set a custom title. Run
`/ttyd-title` with no argument to restore `ttyd`. When Pi settles, it sends a
separate private terminal-title marker; the ttyd browser client briefly marks
the tab as `Pi ready` and shows a browser notification if the tab is hidden and
notification permission is granted. Markers contain no prompt, response, or
session text. Settlement means Pi is waiting for input; it does not mean the
task succeeded.

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

The extension uses terminal-title updates handled by ttyd's xterm client. Add
the contents of [`client.js`](client.js) in a separate `<script>` tag after
ttyd's bundled application script and before `</body>` in the custom HTML passed
with `ttyd --index`. Do not replace or edit ttyd's application bundle. The page
must allow terminal title updates; avoid ttyd's fixed-title option if you use
one. The client keeps the default title `ttyd`, applies `/ttyd-title` changes,
and preserves the chosen title after the temporary `Pi ready` flash.

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
