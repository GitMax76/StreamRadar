"""Public episode listings and media explicitly exposed by the player."""
import json
import re
import subprocess
import sys
from html import unescape
from html.parser import HTMLParser
from urllib.request import Request
from urllib.parse import unquote, urlencode, urljoin, urlsplit

import streamingcommunity_resolver as sc


def provider(url):
    host = (urlsplit(url).hostname or "").removeprefix("www.")
    return {"animeunity.co": "AnimeUnity", "animesaturn.ro": "AnimeSaturn",
            "toonitalia.xyz": "Toonitalia", "cb01one.uno": "CB01", "loonex.eu": "LooneX"}.get(host)


def toon_player(url):
    parsed = urlsplit(url)
    host = (parsed.hostname or "").removeprefix("www.")
    return (parsed.scheme in {"http", "https"} and not parsed.username and not parsed.password
            and host in {"voe.sx", "luluvdo.com", "lulustream.com", "uqload.vc", "uqload.com"}
            and bool(re.fullmatch(r"/(?:embed-)?[a-z0-9]{6,}(?:\.html)?/?", parsed.path, re.I)))


def media_link(url):
    parsed = urlsplit(url)
    return (parsed.scheme in {"http", "https"} and parsed.hostname and not parsed.username
            and not parsed.password and parsed.path.lower().endswith((".mp4", ".m3u8")))


class Page(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.title = ""
        self.heading = ""
        self.links = []
        self.media = []
        self.frames = []
        self.cb01_players = []
        self.capture = None
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {"h1", "title"} and not getattr(self, "heading" if tag == "h1" else "title"):
            self.capture = tag
        if tag == "a" and attrs.get("href"):
            self.links.append(attrs["href"])
        if tag in {"video", "source"} and attrs.get("src"):
            self.media.append(attrs["src"])
        if tag == "div" and "tabs-catch-all" in attrs.get("class", "").split() and attrs.get("data-src"):
            self.cb01_players.append(attrs["data-src"])
        if tag == "iframe" and (attrs.get("src") or attrs.get("data-src")):
            self.frames.append(attrs.get("src") or attrs["data-src"])

    def handle_endtag(self, tag):
        if tag == self.capture:
            self.capture = None

    def handle_data(self, data):
        if self.capture == "h1":
            self.heading += data
        elif self.capture == "title":
            self.title += data

    @property
    def name(self):
        return (self.heading or self.title).strip()


def entry(url, name, season, number):
    return {"url": url, "title": f"{name} - S{season:02d}E{number:02d}",
            "season": season, "number": number}


def loonex_episode(url):
    parsed = urlsplit(url)
    if (provider(url) != "LooneX" or parsed.scheme != "https" or parsed.port not in (None, 443)
            or parsed.username is not None or parsed.password is not None):
        return None
    match = re.fullmatch(r"/lolirock/stream/ok/([1-9][0-9]?)x([0-9]{2})\.php", parsed.path)
    if match and int(match[2]) > 0:
        return "LoliRock", int(match[1]), int(match[2])
    return None


def loonex_listing(url):
    parsed = urlsplit(url)
    return (provider(url) == "LooneX" and parsed.scheme == "https" and parsed.port in (None, 443)
            and parsed.username is None and parsed.password is None
            and parsed.path in {"/lolirock", "/lolirock/"})


def loonex_episodes(html):
    found = {}
    for link in Page(html).links:
        url = urljoin("https://loonex.eu/lolirock/", link)
        episode = loonex_episode(url)
        if episode:
            name, season, number = episode
            episode_url = f"https://loonex.eu/lolirock/stream/ok/{season}x{number:02d}.php"
            found[(season, number)] = entry(episode_url, name, season, number)
    return [found[key] for key in sorted(found)]


def resolve_loonex(url, timeout):
    name, season, number = loonex_episode(url)
    episode_url = f"https://loonex.eu/lolirock/stream/ok/{season}x{number:02d}.php"
    session = sc._new_session()
    with session.open(Request(episode_url, headers={"User-Agent": sc.USER_AGENT}), timeout=timeout) as response:
        if loonex_episode(response.geturl()) != (name, season, number):
            raise sc.PageFormatError("LooneX ha reindirizzato a una pagina diversa.")
        data = response.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise sc.PageFormatError("Pagina episodio LooneX troppo grande.")
    html = unescape(data.decode("utf-8", errors="replace")).replace(r"\/", "/")
    match = re.search(r"""https://(?:www\.)?ok\.ru/videoembed/([0-9]{1,20})(?=[\s"'?<>\\]|$)""", html)
    if not match:
        raise sc.PageFormatError("Player OK.ru assente nella pagina LooneX.")
    embed = f"https://ok.ru/videoembed/{match[1]}"
    try:
        result = subprocess.run(
            [sys.executable, "-I", "-m", "yt_dlp", "--ignore-config", "--no-plugin-dirs",
             "--no-cache-dir", "--use-extractors", "^Odnoklassniki$", "--simulate",
             "--no-playlist", "--socket-timeout", "10", "--retries", "0",
             "--referer", episode_url, "-f", "best[protocol^=m3u8][height<=1080]",
             "--dump-single-json", "--", embed],
            capture_output=True, encoding="utf-8", errors="replace", timeout=40, check=True
        )
        info = json.loads(result.stdout)
    except subprocess.TimeoutExpired as exc:
        raise sc.PageFormatError("OK.ru non ha risposto entro il tempo previsto.") from exc
    except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        detail = getattr(exc, "stderr", "") or ""
        status = re.search(r"HTTP Error ([45]\d{2})", detail)
        reason = f"HTTP {status[1]}" if status else "formato HLS non disponibile o estrattore non funzionante"
        raise sc.PageFormatError(f"OK.ru: {reason}.") from exc

    media = info.get("url")
    if not isinstance(media, str) or not str(info.get("protocol", "")).startswith("m3u8") or info.get("has_drm"):
        raise sc.PageFormatError("OK.ru non ha restituito una playlist HLS compatibile.")
    upstream = urlsplit(media)
    host = upstream.hostname or ""
    if (upstream.scheme != "https" or upstream.port not in (None, 443)
            or upstream.username is not None or upstream.password is not None
            or not any(host == domain or host.endswith("." + domain)
                       for domain in ("ok.ru", "okcdn.ru", "mycdn.me"))):
        raise sc.PageFormatError("OK.ru ha restituito un indirizzo video inatteso.")
    return {"success": True, "media_url": media, "hls": True,
            "title": entry(episode_url, name, season, number)["title"],
            "headers": {"Referer": embed, "User-Agent": sc.USER_AGENT}}


def is_listing(url):
    site = provider(url)
    path = urlsplit(url).path.rstrip("/")
    return bool(
        (site == "AnimeUnity" and re.fullmatch(r"/anime/\d+(?:-[^/]+)?", path))
        or (site == "AnimeSaturn" and re.fullmatch(r"/anime/[^/]+", path))
        or (site == "Toonitalia" and re.fullmatch(r"/[^/]+", path))
        or loonex_listing(url)
    )


def episodes(url, timeout=15):
    session = sc._new_session()
    site = provider(url)
    if site == "Toonitalia":
        return toon_catalog(session, url, min(timeout, 7))
    if site == "LooneX" and loonex_listing(url):
        catalog_url = "https://loonex.eu/lolirock/"
        html, final = sc._fetch(session, catalog_url, min(timeout, 10))
        if not loonex_listing(final):
            raise sc.PageFormatError("LooneX ha reindirizzato a una pagina diversa.")
        items = loonex_episodes(html)
        if not items:
            raise sc.PageFormatError("Nessun episodio compatibile nel catalogo LooneX.")
        return items
    if site == "AnimeUnity":
        parsed = urlsplit(url)
        anime_id = re.match(r"/anime/(\d+)", parsed.path)[1]
        endpoint = urljoin(url, f"/info_api/{anime_id}/1")
        first, _ = sc._fetch(session, endpoint, timeout)
        info = json.loads(first)
        name = info.get("title_ita") or info.get("title") or info.get("title_eng")
        total = int(info.get("episodes_count") or 0)
        if not name or not 0 < total <= 3000:
            raise sc.PageFormatError("elenco episodi AnimeUnity non disponibile")
        found = {}
        for start in range(1, total + 1, 30):
            query = urlencode({"start_range": start, "end_range": min(total, start + 29)})
            data, _ = sc._fetch(session, endpoint + "?" + query, timeout)
            for episode in json.loads(data).get("episodes", []):
                episode_id, number = str(episode.get("id")), str(episode.get("number"))
                if episode_id.isascii() and episode_id.isdigit() and number.isascii() and number.isdigit():
                    found[episode_id] = entry(parsed._replace(path=parsed.path.rstrip("/") + "/" + episode_id, query="", fragment="").geturl(), name, 1, int(number))
        return sorted(found.values(), key=lambda item: item["number"])

    html, final = sc._fetch(session, url, timeout)
    page = Page(html)
    if not page.name or provider(final) != site:
        return []
    found = {}
    if site == "AnimeSaturn":
        slug = urlsplit(final).path.rstrip("/").rsplit("/", 1)[-1]
        for link in page.links:
            absolute = urljoin(final, link)
            path = unquote(urlsplit(absolute).path).strip("/")
            match = re.fullmatch(re.escape(unquote(slug)) + r"-(?:episode|episodio)-(\d+)", path, re.I)
            if match and provider(absolute) == site:
                number = int(match[1])
                found[(1, number)] = entry(absolute, page.name, 1, number)
    return [found[key] for key in sorted(found)]


def toon_catalog(session, url, timeout):
    slug = unquote(urlsplit(url).path.strip("/"))
    if not re.fullmatch(r"[\w-]{1,160}", slug):
        raise sc.PageFormatError("Incolla l'indirizzo di una serie Toonitalia.")
    errors = []
    try:
        html, final = sc._fetch(session, url, timeout)
        if provider(final) == "Toonitalia":
            name = Page(html).name
            if name and (items := toon_episodes(html, final, name)):
                return items
        errors.append("pagina senza episodi riconosciuti")
    except (OSError, ValueError) as exc:
        errors.append(sc._error("pagina", exc))

    fields = {"slug": slug, "_fields": "slug,link,title,content", "per_page": 1}
    for number, endpoint in enumerate((
        urljoin(url, "/wp-json/wp/v2/posts?" + urlencode(fields)),
        urljoin(url, "/?" + urlencode({"rest_route": "/wp/v2/posts", **fields})),
    ), 1):
        try:
            data, final = sc._fetch(session, endpoint, timeout)
            posts = json.loads(data)
            if provider(final) == "Toonitalia" and isinstance(posts, list) and len(posts) == 1:
                post = posts[0]
                if post.get("slug", "").casefold() == slug.casefold():
                    name = Page("<h1>" + post["title"]["rendered"] + "</h1>").name
                    if name and (items := toon_episodes(post["content"]["rendered"], url, name)):
                        return items
            errors.append(f"REST {number}: nessun episodio riconosciuto")
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            errors.append(sc._error(f"REST {number}", exc))
    raise sc.PageFormatError("Catalogo Toonitalia non leggibile dal NAS: " + "; ".join(errors))


def toon_episodes(html, page_url, name):
    found = {}
    season = 1
    for row in re.split(r"</(?:p|li|tr|div|h[1-6])>|<br\s*/?>", html, flags=re.I):
        plain = unescape(re.sub(r"<[^>]*>", " ", row)).strip()
        heading = re.fullmatch(r"(?:stagione|season)\s+(\d{1,2})", plain, re.I)
        if heading:
            season = int(heading[1])
            continue
        links = [urljoin(page_url, link) for link in Page(row).links]
        links = [link for link in links if toon_player(link) or media_link(link)]
        if not links:
            continue
        if re.match(r"^(?:sigla iniziale|sigla di apertura|opening|intro)\b", plain, re.I):
            number, row_season = 0, season
        else:
            numbered = re.match(r"^(?:(\d{1,2})\s*[x×]\s*)?(\d{1,4})(?=\s*[-–—.:])", plain, re.I)
            if not numbered:
                continue
            row_season, number = int(numbered[1] or season), int(numbered[2])
        current = found.setdefault((row_season, number), entry(links[0], name, row_season, number))
        current["alternatives"] = list(dict.fromkeys([*current.get("alternatives", []), *links]))[:5]
    return [found[key] for key in sorted(found)]


def resolve_toon_player(url, timeout=8):
    session = sc._new_session()
    with session.open(Request(url, headers={"User-Agent": sc.USER_AGENT}), timeout=timeout) as response:
        final = response.geturl()
        if media_link(final):
            return final, {"Referer": url, "User-Agent": sc.USER_AGENT}
        html = response.read(1024 * 1024 + 1)
        if len(html) > 1024 * 1024:
            raise sc.PageFormatError("risposta del player troppo grande")
        html = html.decode("utf-8", errors="replace")
    if re.search(r">\s*(?:File Not Found|Video Not Found|Video Deleted)\s*<", html, re.I):
        raise sc.PageFormatError("video rimosso o scaduto")
    page = Page(html)
    declared = re.findall(
        r"""(?i)(?:^|[\s,{])["']?(?:file|src|hls|mp4|source|videoUrl)["']?\s*[:=]\s*["']([^"']+)["']""", html
    )
    for value in [*page.media, *declared]:
        candidate = urljoin(final, unescape(value).replace(r"\/", "/"))
        if media_link(candidate):
            return candidate, {"Referer": final, "User-Agent": sc.USER_AGENT}
    raise sc.PageFormatError("il player richiede un link video rilevato dal browser")


class PlayerVerificationRequired(sc.PageFormatError):
    pass


def resolve(url, timeout=15):
    if provider(url) == "LooneX":
        if not loonex_episode(url):
            return {"success": False, "error": "Incolla la pagina di un singolo episodio LoliRock."}
        try:
            return resolve_loonex(url, timeout)
        except (OSError, ValueError) as exc:
            return {"success": False, "error": sc._error("LooneX", exc)}
    session = sc._new_session()
    visited = set()
    cb01 = provider(url) == "CB01"
    film_title = None

    def scan(current, referer=None, depth=0):
        nonlocal film_title
        if current in visited or depth > 2 or len(visited) >= 8:
            return None
        visited.add(current)
        host = (urlsplit(current).hostname or "").removeprefix("www.")
        if host == "vixcloud.cc" and urlsplit(current).path.startswith("/embed/"):
            result = sc.resolve_streamingcommunity_stream(current, timeout, referer=referer)
            if not result["success"]:
                raise sc.PageFormatError(result["error"])
            return result
        html, final = sc._fetch(session, current, timeout, referer=referer)
        if cb01 and depth:
            final_host = (urlsplit(final).hostname or "").removeprefix("www.")
            if ((final_host == "uprot.net" and "upcaptcha-form" in html)
                    or (final_host == "stayonline.pro" and "btnClickToContinueLink" in html
                        and "reCaptchaConfig" in html)):
                raise PlayerVerificationRequired(
                    "Il player CB01 richiede una verifica interattiva. Il server non ha ricevuto un link MP4."
                )
        page = Page(html)
        if cb01 and depth == 0:
            film_title = re.sub(r"\s*\[(?:HD|4K|SD)\]\s*", " ", page.name, flags=re.I).strip()
        declared = re.findall(r"""(?:downloadUrl|download_url|downloadLink)\s*[=:]\s*['"]([^'"]+)['"]""", html)
        for source in page.media + page.links + [unescape(value.replace(r"\/", "/")) for value in declared]:
            media = urljoin(final, source)
            parsed = urlsplit(media)
            if parsed.scheme in {"http", "https"} and parsed.hostname and parsed.path.lower().endswith(".mp4"):
                return {"success": True, "media_url": media, "title": page.name,
                        "headers": {"Referer": final, "User-Agent": sc.USER_AGENT}}
        frames = page.cb01_players if cb01 and depth == 0 and page.cb01_players else list(page.frames)
        if cb01:
            frames = [frame for frame in frames if (urlsplit(urljoin(final, frame)).hostname or "")
                      .removeprefix("www.") not in {"youtube.com", "youtube-nocookie.com", "youtu.be"}]
        if provider(final) == "AnimeUnity":
            episode = re.fullmatch(r"/anime/[^/]+/(\d+)/?", urlsplit(final).path)
            if episode:
                embed, endpoint = sc._fetch(session, urljoin(final, f"/embed-url/{episode[1]}"), timeout, referer=final)
                value = embed.strip()
                try:
                    payload = json.loads(value)
                    value = payload if isinstance(payload, str) else payload.get("url") if isinstance(payload, dict) else ""
                except json.JSONDecodeError:
                    pass
                if isinstance(value, str) and re.fullmatch(r"""https?://[^\s<>"']+""", value):
                    if urlsplit(value).path.lower().endswith(".mp4"):
                        return {"success": True, "media_url": value, "title": page.name,
                                "headers": {"Referer": final, "User-Agent": sc.USER_AGENT}}
                    frames.insert(0, value)
        last_error = None
        for frame in frames:
            player = urljoin(final, frame)
            if urlsplit(player).scheme in {"http", "https"}:
                try:
                    result = scan(player, final, depth + 1)
                except (OSError, ValueError) as exc:
                    if not cb01:
                        raise
                    if not isinstance(last_error, PlayerVerificationRequired):
                        last_error = exc
                    continue
                if result:
                    return result
        if last_error:
            raise last_error
        return None

    try:
        result = scan(url)
        if result and film_title:
            result["title"] = film_title
        return result or {"success": False, "error": "Il player non espone un video diretto compatibile."}
    except (OSError, ValueError) as exc:
        return {"success": False, "error": sc._error("Pagina o player", exc)}
