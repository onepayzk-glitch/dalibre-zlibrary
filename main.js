// @ts-check
// Z-Library 书源（Dalibre 插件 API 1）
// 由来：tekofx/zlibrary-calibre-store-plugin 的 calibre 版本。
//
// 2026-11 起 Z-Library 的 /eapi/book/search 对普通账号一律回 400 "Access denied"
// （登录态、付费态、浏览器内同源请求都一样），所以搜索改成抓站点的 /s/<关键词> 页面，
// 并用纯 JS 解掉它那道工作量证明墙（找 i 使 sha1(challenge+i) 在指定位置等于 0xB0 0x0B，
// 然后带上 c_token/c_time 再请求）。下载走 /dl/<token>，同样解墙后拿 302 的 CDN 地址。
//
// 备用：Z-Library 失败时回退到 Library Genesis 镜像的 HTML 搜索。

const MAX_PAGES = 5;
const PAGE_FULL = 50; // /s/ 一页 50 条，够了就当还有下一页

/** 扩展名 → Dalibre 的格式名。 */
const FORMATS = {
  epub: "EPUB", kepub: "KEPUB", azw3: "AZW3", azw: "AZW", mobi: "MOBI", pdf: "PDF",
  fb2: "FB2", djvu: "DJVU", cbz: "CBZ", cbr: "CBR", cb7: "CB7", txt: "TXT",
  rtf: "RTF", docx: "DOCX", odt: "ODT", htmlz: "HTMLZ", lit: "LIT", prc: "PRC",
  pdb: "PDB", lrf: "LRF", snb: "SNB", tcr: "TCR",
};

/** 语言名 → ISO 639。 */
const LANGUAGES = {
  english: "en", chinese: "zh", german: "de", french: "fr", spanish: "es",
  russian: "ru", japanese: "ja", italian: "it", portuguese: "pt", dutch: "nl",
  polish: "pl", korean: "ko", turkish: "tr", arabic: "ar", hindi: "hi",
};

/** 解出来的墙 token，模块级缓存；一次调用里复用，过期就再解。 */
const state = { token: "" };

/** @typedef {{ source: string, zsite: string, cookie: string, lsite: string }} Config */

/** @returns {Config} */
function config() {
  const s = dalibre.settings;
  return {
    source: String(s.source ?? "auto"),
    zsite: stripSlash(String(s.zlibrarySite ?? "https://z-lib.gl")),
    cookie: String(s.zlibraryCookie ?? "").trim(),
    lsite: stripSlash(String(s.libgenSite ?? "https://libgen.li")),
  };
}

/**
 * @param {Dalibre.Query} query
 * @returns {Promise<Dalibre.Page>}
 */
export async function search({ text, page }) {
  const q = (text || "").trim();
  if (!q) return { items: [] };

  const cfg = config();
  /** @type {string[]} */
  const problems = [];

  if (cfg.source !== "libgen") {
    try {
      const zpage = await zlibrarySearch(cfg, q, page);
      if (zpage.items.length || cfg.source === "zlib") return zpage;
      problems.push("Z-Library 没有返回结果");
    } catch (err) {
      if (cfg.source === "zlib") throw err;
      problems.push(describe(err));
    }
  }

  try {
    return await libgenSearch(cfg, q, page);
  } catch (err) {
    if (!problems.length) throw err;
    throw dalibre.error(
      "unavailable",
      `${problems[0]}；Library Genesis 也没成功：${describe(err)}`,
    );
  }
}

/**
 * @param {Dalibre.Result} item
 * @param {Dalibre.FormatName} format
 * @returns {Promise<Dalibre.DownloadRequest>}
 */
export async function resolve(item, format) {
  const extra = /** @type {any} */ (item.extra) || {};
  const cfg = config();

  if (extra.kind === "zlibrary" && extra.download) {
    const url = absolute(String(extra.download), cfg.zsite);
    const res = await zlibFetch(url, cfg, true);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) return { url: absolute(loc, url), filename: item.title };
      throw dalibre.error("unavailable", "Z-Library 的下载入口没有给出地址。");
    }
    throw dalibre.error(
      "unavailable",
      `Z-Library 的下载入口回了 ${res.status}，可能配额用完了（免费档每天 10 本）。`,
    );
  }

  if (extra.kind === "libgen") {
    const md5 = String(extra.md5 || "");
    if (!md5) throw dalibre.error("notFound", "这条结果没有 LibGen 的 MD5，找不到文件。");
    const adsUrl = `${extra.site}/ads.php?md5=${md5}`;
    const res = await fetch(adsUrl);
    if (res.status === 404) throw dalibre.error("notFound", "LibGen 上这个文件已经没了。");
    if (!res.ok) {
      throw dalibre.error("unavailable", `LibGen 的下载页回了 ${res.status}，过一会儿再试。`);
    }
    const link = /href="(get\.php\?[^"]+)"/.exec(await res.text());
    if (!link) {
      throw dalibre.error(
        "unavailable",
        "LibGen 的下载服务器暂时不可用（常见的数据库连接数满），过一会儿再试。",
      );
    }
    return { url: absolute(link[1], extra.site), headers: { Referer: adsUrl } };
  }

  throw dalibre.error("notFound", "这条结果没有可用的下载地址。");
}

//////////////////////////////////////////////////////////////////////
// Z-Library：HTML 搜索 + 工作量证明墙
//////////////////////////////////////////////////////////////////////

/** 把登录 cookie 和墙 token 拼成 Cookie 头。 @param {Config} cfg */
function cookieFor(cfg) {
  const parts = [];
  if (cfg.cookie) parts.push(cfg.cookie);
  if (state.token) parts.push(`c_token=${state.token}`, "c_time=3");
  return parts.join("; ");
}

/**
 * 带解墙的 GET：503 时读页面里的 challenge，解出来再请求一次。
 * @param {string} url @param {Config} cfg @param {boolean} manual 不跟随跳转（拿 Location）
 * @returns {Promise<Response>}
 */
async function zlibFetch(url, cfg, manual = false) {
  const request = () =>
    fetch(url, {
      method: "GET",
      headers: {
        ...(cookieFor(cfg) ? { Cookie: cookieFor(cfg) } : {}),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: manual ? "manual" : "follow",
    });

  let res = await request();
  if (res.status !== 503) return res;

  const token = solveChallenge(await res.text());
  if (!token) throw dalibre.error("unavailable", "Z-Library 的验证墙没看懂，页面结构可能变了。");
  state.token = token;
  return request();
}

/**
 * 在 503 页面里找出 40 位十六进制的 challenge，暴力找一个 i 让 sha1(challenge+i)
 * 在指定位置正好是 0xB0 0x0B。位置由 challenge 第一位决定（站点自己的写法）。
 * @param {string} html @returns {string}
 */
function solveChallenge(html) {
  const m = /'([0-9A-Fa-f]{40})'/.exec(html);
  if (!m) return "";
  const challenge = m[1];
  const at = parseInt(challenge[0], 16);
  for (let i = 0; i < 2000000; i++) {
    const digest = sha1Ascii(challenge + i);
    if (digest[at] === 0xb0 && digest[at + 1] === 0x0b) return challenge + i;
  }
  return "";
}

/** 纯 JS 的 SHA-1（输入只当 ASCII 处理，challenge 和数字都是 ASCII）。 @param {string} str */
function sha1Ascii(str) {
  const len = str.length;
  const total = (((len + 8) >> 6) + 1) * 64;
  const buf = new Uint8Array(total);
  for (let i = 0; i < len; i++) buf[i] = str.charCodeAt(i) & 0xff;
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 4, (len * 8) >>> 0, false);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let block = 0; block < total; block += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(block + j * 4, false);
    for (let j = 16; j < 80; j++) {
      const v = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = (v << 1) | (v >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f, k;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = ((((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0);
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, false); odv.setUint32(4, h1, false); odv.setUint32(8, h2, false);
  odv.setUint32(12, h3, false); odv.setUint32(16, h4, false);
  return out;
}

/**
 * @param {Config} cfg @param {string} q @param {number} page
 * @returns {Promise<Dalibre.Page>}
 */
async function zlibrarySearch(cfg, q, page) {
  const p = Math.max(1, Math.min(Number(page) || 1, MAX_PAGES));
  const url = `${cfg.zsite}/s/${encodeURIComponent(q)}${p > 1 ? `?page=${p}` : ""}`;
  const res = await zlibFetch(url, cfg);
  if (res.status === 429) throw dalibre.error("rateLimited", "Z-Library 要求放慢一点。");
  if (!res.ok) {
    throw dalibre.error("unavailable", `Z-Library 的搜索页回了 ${res.status}。`);
  }
  const html = await res.text();
  const items = parseCards(html, cfg);
  return { items, hasMore: items.length >= PAGE_FULL && p < MAX_PAGES };
}

/**
 * 抓 <z-bookcard> 卡片：属性里有 id/href/download/extension/filesize/language/year/publisher，
 * 子元素里有封面和图名、作者。
 * @param {string} html @param {Config} cfg
 * @returns {Dalibre.Result[]}
 */
function parseCards(html, cfg) {
  /** @type {Dalibre.Result[]} */
  const items = [];
  for (const m of html.matchAll(/<z-bookcard\b([\s\S]*?)<\/z-bookcard>/g)) {
    const body = m[1];
    const attr = (name) => {
      const mm = new RegExp(`\\b${name}="([^"]*)"`).exec(body);
      return mm ? decodeEntities(mm[1]).trim() : "";
    };
    const title = decodeEntities((/<div[^>]*slot="title"[^>]*>([\s\S]*?)<\/div>/.exec(body) || [])[1] || "").trim();
    const author = decodeEntities((/<div[^>]*slot="author"[^>]*>([\s\S]*?)<\/div>/.exec(body) || [])[1] || "").trim();
    const coverRaw = (/<img[^>]*data-src="([^"]+)"/.exec(body) || [])[1] || "";
    // 有些书没有封面，给的是 /img/cover-not-exists.png 这种相对路径，别传给 Dalibre
    const cover = /^https?:\/\//i.test(coverRaw) ? coverRaw : "";
    if (!title) continue;

    const ext = attr("extension").toLowerCase();
    const format = FORMATS[/** @type {keyof typeof FORMATS} */ (ext)];
    if (!format) continue;

    const id = attr("id") || attr("termshash");
    const href = attr("href");
    const download = attr("download");
    const size = parseSize(attr("filesize"));

    /** @type {Dalibre.Field[]} */
    const fields = [{ label: "来源", value: "Z-Library" }];
    const publisher = attr("publisher");
    if (publisher) fields.push({ label: "出版社", value: publisher });
    const filesize = attr("filesize");
    if (filesize) fields.push({ label: "文件大小", value: filesize });

    items.push({
      id: `zl:${id}`,
      title,
      authors: splitAuthors(author),
      publisher: publisher || undefined,
      pubdate: attr("year") || undefined,
      language: langCode(attr("language")),
      cover: cover || undefined,
      url: href ? absolute(href, cfg.zsite) : undefined,
      identifiers: { "com.zhukun.zlibrary": id },
      formats: [{ format: /** @type {Dalibre.FormatName} */ (format), size }],
      fields,
      extra: { kind: "zlibrary", id, download, site: cfg.zsite },
    });
  }
  return items;
}

//////////////////////////////////////////////////////////////////////
// Library Genesis 备用（libgen.li 的表格列结构）
//////////////////////////////////////////////////////////////////////
const LIBGEN_PER_PAGE = 25;
const LIBGEN_COLUMNS = 9;

/**
 * @param {Config} cfg @param {string} q @param {number} page
 * @returns {Promise<Dalibre.Page>}
 */
async function libgenSearch(cfg, q, page) {
  const url = `${cfg.lsite}/index.php?${new URLSearchParams({
    req: q,
    curtab: "f",
    filesuns: "all",
    page: String(Math.max(1, page)),
  })}`;

  let html = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) throw dalibre.error("rateLimited", "LibGen 要求放慢一点。");
    if (!res.ok) throw dalibre.error("unavailable", `LibGen 回了 ${res.status}。`);
    html = await res.text();
    if (looksLikeLibgen(html)) break;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!looksLikeLibgen(html)) {
    throw dalibre.error(
      "unavailable",
      `${cfg.lsite} 现在只返回占位页面（站点在维护，或者镜像换了地址）。`,
    );
  }

  const rows = tableRows(html);
  /** @type {Dalibre.Result[]} */
  const items = [];
  const seen = new Set();
  for (const row of rows) {
    const parsed = parseLibgenRow(row, cfg.lsite);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    items.push(parsed);
  }
  const total = libgenTotalPages(html);
  return { items, hasMore: total ? page < total : rows.length >= LIBGEN_PER_PAGE };
}

/** @param {string} html */
function looksLikeLibgen(html) {
  return html.includes('id="tablelibgen"') || html.includes("Library Genesis");
}

/**
 * @param {string} row @param {string} site
 * @returns {Dalibre.Result | null}
 */
function parseLibgenRow(row, site) {
  const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
  if (cells.length < LIBGEN_COLUMNS) return null;

  const links = [];
  for (const m of cells[0].matchAll(/href="([^"]*edition\.php[^"]*)"/gi)) {
    const rest = cells[0].slice(m.index + m[0].length);
    const start = openingTagEnd(rest);
    if (!start) continue;
    const text = textOf(rest.slice(start).split("</a>")[0]);
    if (text) links.push({ href: m[1], text });
  }
  if (!links.length) return null;
  const best = links.sort((a, b) => b.text.length - a.text.length)[0];
  const title = best.text.replace(/\s*DOI:.*$/i, "").trim();
  if (!title) return null;

  const ext = textOf(cells[7]).toLowerCase();
  const format = FORMATS[/** @type {keyof typeof FORMATS} */ (ext)];
  if (!format) return null;

  const hrefs = [...row.matchAll(/href="([^"]*)"/gi)].map((m) => m[1]).join(" ");
  const md5 = /\b([0-9a-f]{32})\b/i.exec(hrefs)?.[1] || "";
  if (!md5) return null;

  const sizeText = textOf(cells[6]);
  const year = /\b(1[5-9]\d{2}|20\d{2})\b/.exec(textOf(cells[3]))?.[1] || "";

  /** @type {Dalibre.Field[]} */
  const fields = [{ label: "来源", value: "Library Genesis" }];
  if (sizeText) fields.push({ label: "文件大小", value: sizeText });

  return {
    id: `lg:${md5}`,
    title,
    authors: splitAuthors(textOf(cells[1])),
    publisher: textOf(cells[2]) || undefined,
    pubdate: year || undefined,
    language: langCode(textOf(cells[4])),
    url: absolute(best.href, site),
    identifiers: { "com.zhukun.zlibrary": md5 },
    formats: [{ format: /** @type {Dalibre.FormatName} */ (format), size: parseSize(sizeText) }],
    fields,
    extra: { kind: "libgen", md5, site, ext },
  };
}

/** @param {string} html */
function tableRows(html) {
  const at = html.indexOf('id="tablelibgen"');
  if (at < 0) return [];
  const table = html.slice(at);
  const end = table.indexOf("</table>");
  const body = end > 0 ? table.slice(0, end) : table;
  return [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
}

/** @param {string} html */
function libgenTotalPages(html) {
  const m = /new Paginator\("paginator_example_top",\s*(\d+),\s*(\d+)/.exec(html);
  return m ? Number(m[1]) : 0;
}

//////////////////////////////////////////////////////////////////////
// 小工具
//////////////////////////////////////////////////////////////////////

/** @param {string} v */
function parseSize(v) {
  const m = /([\d.]+)\s*(B|kB|KB|MB|GB)/i.exec(v || "");
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2].toLowerCase();
  if (unit === "gb") return Math.round(n * 1024 ** 3);
  if (unit === "mb") return Math.round(n * 1024 ** 2);
  if (unit === "kb") return Math.round(n * 1024);
  return Math.round(n);
}

/** @param {string} v */
function langCode(v) {
  const word = (v || "").trim().toLowerCase();
  if (!word) return undefined;
  for (const [name, code] of Object.entries(LANGUAGES)) {
    if (word.includes(name)) return code;
  }
  return undefined;
}

/** "Smith, John; Doe, Jane" → 两个人；逗号留在名字里。 @param {string} s */
function splitAuthors(s) {
  return String(s || "")
    .split(/\s*;\s*|、|\s+and\s+/i)
    .map((a) => a.trim())
    .filter((a) => a && a !== "-");
}

/** @param {string} html */
function textOf(html) {
  return decodeEntities(
    String(html).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} s */
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** 属性值里可能有 ">"（LibGen 的 title 里就带 <br>）。 @param {string} s */
function openingTagEnd(s) {
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = ""; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i + 1;
  }
  return 0;
}

/** @param {string} href @param {string} site */
function absolute(href, site) {
  try { return new URL(href, site + "/").toString(); } catch { return href; }
}

/** @param {string} s */
function stripSlash(s) {
  return s.trim().replace(/\/+$/, "");
}

/** @param {unknown} err */
function describe(err) {
  const e = /** @type {any} */ (err);
  return (e && (e.message || String(e))) || "没有说明";
}
