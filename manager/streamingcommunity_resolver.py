"""Rilevamento degli episodi e verifica delle playlist HLS esposte dal player."""

import re
import time
import ssl
import sys
from pathlib import Path
import json
import http.cookiejar
import urllib.error
import html as html_lib
import urllib.request
import urllib.parse
from typing import Dict, Any, List

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

def _new_session():
    context = ssl.create_default_context()
    # The portable app ships public CA roots alongside the Windows trust store.
    runtime_dir = Path(getattr(sys, '_MEIPASS', Path(__file__).parent / '_internal'))
    ca_bundle = runtime_dir / 'certifi' / 'cacert.pem'
    if ca_bundle.is_file():
        context.load_verify_locations(cafile=str(ca_bundle))
    return urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=context),
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )


def _fetch(session, url, timeout, referer=None):
    if urllib.parse.urlsplit(url).scheme not in ('http', 'https'):
        raise PageFormatError("schema URL non supportato")
    headers = {'User-Agent': USER_AGENT}
    if referer:
        headers['Referer'] = referer
    request = urllib.request.Request(url, headers=headers)
    with session.open(request, timeout=timeout) as response:
        return response.read().decode('utf-8', errors='replace'), response.geturl()


def _error(stage, exc):
    if isinstance(exc, urllib.error.HTTPError):
        detail = f"HTTP {exc.code}"
    elif isinstance(exc, urllib.error.URLError):
        reason = exc.reason
        if isinstance(reason, ssl.SSLCertVerificationError):
            detail = f"certificato HTTPS rifiutato ({reason.verify_code}: {reason.verify_message})"
        else:
            detail = f"connessione non riuscita ({type(reason).__name__})"
    elif isinstance(exc, TimeoutError):
        detail = "tempo di attesa superato"
    else:
        detail = str(exc) if isinstance(exc, PageFormatError) else type(exc).__name__
    return f"{stage}: {detail}"


class PageFormatError(ValueError):
    pass


def _props(page_html):
    match = re.search(r"""data-page=(['"])(.*?)\1""", page_html, re.S)
    if not match:
        raise PageFormatError("dati della pagina assenti")
    return json.loads(html_lib.unescape(match.group(2)))['props']


def is_streamingcommunity_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(url or '')
        host = (parsed.hostname or '').lower()
    except ValueError:
        return False
    if parsed.scheme not in ('http', 'https'):
        return False
    return bool(re.fullmatch(r'(?:[a-z0-9-]+\.)*(?:streaming-?community[a-z0-9-]*|vixcloud)\.[a-z0-9.-]+', host))


def is_series_url(url: str) -> bool:
    return is_streamingcommunity_url(url) and '/titles/' in urllib.parse.urlsplit(url).path.lower()


def is_manifest_false_positive(url: str) -> bool:
    if not url:
        return False
    u = url.lower()
    return ('manifest.webm' in u) or ('webmanifest' in u)

def exposed_mp4(page, player_url):
    # Use only a download URL declared by the player.
    links = re.findall(r"""<a\b[^>]*>""", page, re.I)
    candidates = []
    for link in links:
        href = re.search(r"""\bhref\s*=\s*(['"])(.*?)\1""", link, re.I)
        if href and (re.search(r"\sdownload(?:\s|=|>)", link, re.I)
                     or "/download/" in href[2]):
            candidates.append(href[2])
    candidates.extend(re.findall(
        r"""\b(?:downloadUrl|download_url|downloadLink|download_link)\s*[=:]\s*['"]([^'"]+)['"]""",
        page, re.I
    ))
    for candidate in candidates:
        media = urllib.parse.urljoin(player_url, html_lib.unescape(candidate.replace(r"\/", "/")))
        parsed = urllib.parse.urlsplit(media)
        if parsed.scheme == "https" and parsed.hostname and parsed.path.lower().endswith(".mp4"):
            expiry = urllib.parse.parse_qs(parsed.query).get("expires", [""])[0]
            if expiry.isascii() and expiry.isdigit() and int(expiry) <= time.time():
                continue
            return media
    return None


def resolve_streamingcommunity_stream(url: str, timeout: int = 15, referer=None, prefer_mp4=False) -> Dict[str, Any]:
    """
    Risolve un URL di StreamingCommunity (o embed Vixcloud) e genera la playlist HLS reale (.m3u8)
    con gli header corretti (Referer e Origin) necessari per la riproduzione e il download.
    """
    session = _new_session()
    stage = "Pagina episodio"
    year = ""

    try:
        # Se è già un URL embed di vixcloud
        if 'vixcloud.' in url.lower() and '/embed/' in url:
            vix_embed_url = url
            clean_title = "Streaming"
            referer_for_vix = referer
        else:
            if is_series_url(url):
                return {'success': False, 'error': 'Seleziona un episodio dalla pagina della serie.'}

            page_html, page_url = _fetch(session, url, timeout)
            stage = "Dati della pagina episodio"
            props = _props(page_html)

            title_info = props.get('title') or {}
            title_name = title_info.get('name', 'Video').strip()
            ep_info = props.get('episode') or {}
            requested = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get('e')
            if requested and str(ep_info.get('id')) != requested[0]:
                return {'success': False, 'error': "La pagina ricevuta non corrisponde all’episodio richiesto."}

            if ep_info:
                ep_num = int(ep_info.get('number', 1))
                season_num = int((ep_info.get('season') or {}).get('number', 1))
                clean_title = f"{title_name} - S{season_num:02d}E{ep_num:02d}"
            else:
                clean_title = title_name
                year = str(title_info.get("release_year") or title_info.get("year")
                           or title_info.get("release_date") or "")[:4]

            embed_url = props.get('embedUrl')
            if not embed_url:
                title_id = title_info.get('id')
                ep_id = ep_info.get('id')
                if title_id and ep_id:
                    embed_url = urllib.parse.urljoin(page_url, f"../iframe/{title_id}?{urllib.parse.urlencode({'episode_id': ep_id})}")
                elif title_id:
                    embed_url = urllib.parse.urljoin(page_url, f"../iframe/{title_id}")
                else:
                    return {'success': False, 'error': 'Impossibile ricavare embedUrl dal titolo.'}

            stage = "Iframe episodio"
            embed_url = urllib.parse.urljoin(page_url, embed_url)
            if (urllib.parse.urlsplit(embed_url).hostname or '').startswith('vixcloud.'):
                vix_embed_url = embed_url
                referer_for_vix = page_url
            else:
                iframe_html, iframe_url = _fetch(session, embed_url, timeout, referer=page_url)
                frames = re.findall(r"""<iframe[^>]+src=['"]([^'"]+)['"]""", iframe_html, re.I)
                candidates = [urllib.parse.urljoin(iframe_url, html_lib.unescape(src)) for src in frames]
                vix_embed_url = next((src for src in candidates if
                    (urllib.parse.urlsplit(src).hostname or '').startswith('vixcloud.')), None)
                if not vix_embed_url:
                    return {'success': False, 'error': 'Iframe Vixcloud assente nella pagina episodio.'}
                referer_for_vix = iframe_url

        stage = "Player Vixcloud"
        vix_html, vix_embed_url = _fetch(session, vix_embed_url, timeout, referer=referer_for_vix)

        if prefer_mp4:
            direct = exposed_mp4(vix_html, vix_embed_url)
            if direct:
                return {
                    "success": True, "title": clean_title, "year": year, "media_url": direct,
                    "headers": {"User-Agent": USER_AGENT, "Referer": vix_embed_url},
                    "stream_type": "DIRECT_MP4",
                }

        # Estrai token, expires e URL master playlist
        m_token = re.search(r'[\'"]token[\'"]\s*:\s*[\'"]([^\'"]+)[\'"]', vix_html)
        m_expires = re.search(r'[\'"]expires[\'"]\s*:\s*[\'"]([^\'"]+)[\'"]', vix_html)
        m_base_url = re.search(r'url\s*:\s*[\'"]([^\'"]+)[\'"]', vix_html)

        if not (m_token and m_expires and m_base_url):
            return {'success': False, 'error': 'Token o parametri playlist Vixcloud non trovati.'}

        token = m_token.group(1)
        expires = m_expires.group(1)
        base_playlist_url = urllib.parse.urljoin(vix_embed_url, html_lib.unescape(m_base_url.group(1)))

        # Costruisci parametri HLS (il parametro h=1 va aggiunto SOLO se consentito dal player)
        can_fhd = ('canplayfhd=1' in vix_embed_url.lower()) or ('canplayfhd=true' in vix_embed_url.lower())
        query_params = {
            'token': token,
            'expires': expires,
            'scz': '1',
            'lang': 'it'
        }
        if can_fhd:
            query_params['h'] = '1'

        playlist = urllib.parse.urlsplit(base_playlist_url)
        params = dict(urllib.parse.parse_qsl(playlist.query, keep_blank_values=True))
        params.update(query_params)
        master_playlist_url = playlist._replace(query=urllib.parse.urlencode(params)).geturl()
        stage = "Playlist HLS"
        manifest, _ = _fetch(session, master_playlist_url, timeout, referer=vix_embed_url)
        if not manifest.lstrip().startswith('#EXTM3U'):
            return {'success': False, 'error': 'Playlist HLS: risposta non riconosciuta.'}
        if re.search(r'(?mi)^#EXT-X-(?:SESSION-)?KEY:.*(?:KEYFORMAT="(?!identity")|METHOD=SAMPLE-AES)', manifest):
            return {'success': False, 'error': 'Playlist HLS protetta o con cifratura non supportata.'}
        player = urllib.parse.urlsplit(vix_embed_url)

        stream_headers = {
            'User-Agent': USER_AGENT,
            'Referer': vix_embed_url,
            'Origin': f'{player.scheme}://{player.netloc}'
        }

        return {
            'success': True,
            'title': clean_title,
            'year': year,
            'media_url': master_playlist_url,
            'headers': stream_headers,
            'stream_type': 'HLS_MASTER'
        }

    except Exception as exc:
        return {'success': False, 'error': _error(stage, exc)}

def title_entries(url, timeout=15):
    page_html, page_url = _fetch(_new_session(), url, timeout)
    props = _props(page_html)
    title = props.get("title") or {}
    title_id = title.get("id")
    if not str(title_id).isdigit():
        raise PageFormatError("ID titolo assente o non valido")
    name = (title.get("name") or "Video").strip()
    kind = str(title.get("type") or props.get("type") or "").lower()
    watch = urllib.parse.urljoin(page_url, f"../watch/{title_id}")
    if kind in {"movie", "film"}:
        return [{"url": watch, "title": name}]
    season = props.get("loadedSeason") or {}
    number = int(season.get("number", 1))
    entries = []
    for episode in season.get("episodes") or []:
        episode_id = episode.get("id")
        if not str(episode_id).isdigit():
            continue
        ep = int(episode["number"])
        query = urllib.parse.urlencode({"e": episode_id})
        entries.append({"url": f"{watch}?{query}", "title": f"{name} - S{number:02d}E{ep:02d}",
                        "season": number, "number": ep})
    if not entries:
        raise PageFormatError("Nessun episodio o film riconosciuto nella pagina titolo")
    return entries


def extract_series_episodes_from_page(url, timeout=15, on_log=None):
    try:
        return [item for item in title_entries(url, timeout) if "season" in item]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        if on_log:
            on_log(_error("Pagina serie", exc))
        return []
