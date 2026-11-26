# Dalibre · Z-Library book source

[中文](README.md) | English

Search Z-Library from the **Get books** page in [Dalibre](https://dalibre.randynamic.org), open a result, and download the book into your library. When Z-Library is unavailable, the plugin falls back to a Library Genesis mirror.

This plugin ports the calibre store plugin [tekofx/zlibrary-calibre-store-plugin](https://github.com/tekofx/zlibrary-calibre-store-plugin) to Dalibre plugin API 1.

The plugin connects public web pages to Dalibre. Downloads depend on your own account and on the rules of the site. Check that your use is legal where you live.

## Install

**Option 1: install from GitHub.** Open Plugins in Dalibre. Choose **Install from GitHub**. Enter `onepayzk-glitch/dalibre-zlibrary`.

**Option 2: install from a file.** Download `io.github.onepayzk.zlibrary-0.2.0.dalibre-plugin` from the release page. Open Plugins in Dalibre. Choose **Install from file**.

Then select **Z-Library book source** in the source picker on the Get books page.

## Settings

Open Plugins, select Z-Library book source, and open Settings.

| Setting | Default | Notes |
|---|---|---|
| Search source | Auto | Auto tries Z-Library first and moves to LibGen after a failure or an empty result. |
| Z-Library site | `https://z-lib.gl` | Domain only. A different mirror also requires a matching entry in `permissions.hosts`. |
| Z-Library cookie | empty | Type `secret`, stored in the system keychain. Copy `remix_userid=...; remix_userkey=...` from your browser developer tools. |
| LibGen mirror | `https://libgen.li` | Domain only. The parser reads the table layout of libgen.li. |

Search works without a cookie. A download needs a logged-in cookie.

## How it works

Z-Library answers `/eapi/book/search` with `400 Access denied` for ordinary accounts. A logged-in browser receives the same answer. The plugin therefore reads the site's own search page.

1. The plugin requests `/s/<query>`.
2. When the site returns 503 "Checking your browser", the plugin reads the 40-character challenge from the page.
3. The plugin looks for an integer `i`. The value `sha1(challenge + i)` must contain `0xB0 0x0B` at the position that the first hex digit of the challenge selects.
4. The plugin sends `c_token` and `c_time` with the next request. The site returns the result page.
5. The plugin reads each `<z-bookcard>` element. The element holds the title, the author, the publisher, the year, the language, the file size, the cover, and a download token.
6. For a download, the plugin solves the same challenge for `/dl/<token>` and reads the `Location` header. Dalibre downloads the file from that CDN address.

One search takes about 3 to 5 seconds. A download adds 1 to 2 seconds for the challenge.

Required hosts:

```
z-lib.gl, z-library.sk, *.cdn-zlib.sk (covers), *.ncdn.ec (downloads), libgen.li
```

## Limits

- **The challenge algorithm is the fragile part.** When the site changes its script, `solveChallenge()` must change with it. Search then raises "the challenge page changed".
- **The download quota comes from your account.** A free account usually has 10 downloads per day.
- **The plugin accepts ebook formats only**: EPUB, PDF, MOBI, AZW3, AZW, FB2, DJVU, TXT, RTF, and similar. It drops results with other extensions.
- **The fallback reads the libgen.li table layout.** A different mirror layout breaks the parser.
- **An unreachable site raises an error on purpose.** A failure must never look like "no such book".

## Development

```sh
npx dalibre-plugin@0.8.0 check .                   # validate plugin.json and exports
npx dalibre-plugin@0.8.0 search . "deep work"      # run a search on Dalibre's runtime
npx dalibre-plugin@0.8.0 download . "deep work" -o /tmp/zlib   # exercise resolve
npx dalibre-plugin@0.8.0 pack .                    # build a .dalibre-plugin package
```

`main.js` starts with `// @ts-check`. With `dalibre.d.ts` next to it, your editor completes the API and checks the types.

```
plugin.json          manifest: id, version, capabilities, permissions, settings
main.js              search and resolve; HTML parsing and the challenge solver
dalibre.d.ts         type definitions
jsconfig.json        editor configuration
plugin.schema.json   JSON Schema for plugin.json
.github/workflows    runs check on every push
```

## License

GPL-3.0, the same license as the upstream calibre plugin.
