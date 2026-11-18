import base64
import hmac
import json
import os
import queue
import re
import subprocess
import threading
import time
from collections import deque
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urljoin, urlsplit

import streamingcommunity_resolver as resolver
import public_sources
import maintenance
import media_library
from media_library import clean_title

DATA = Path(os.environ.get("LSM_DATA", "/data"))
JOBS = {}
SOURCES = {}
PENDING_TICKETS = {}
PROCESSES = {}
RESERVATIONS = {}
STOPPING = {"Sospensione", "Annullamento"}
LOCK = threading.Lock()
PENDING = queue.Queue()
PASSWORD = os.environ.get("LSM_PASSWORD", "")
MAX_DOWNLOADS = 3
ARCHIVE = Path("/archive")


class DuplicateConflict(Exception):
    def __init__(self, path, matches, reset_approval=False):
        self.path = path
        self.matches = matches
        self.reset_approval = reset_approval
        self.quality = None


def monitor_archive():
    while True:
        try:
            maintenance.archive_videos(DATA, ARCHIVE)
        except OSError as exc:
            print(f"Archivio Toshiba: {type(exc).__name__}", flush=True)
        time.sleep(60)
DURATION = re.compile(r"^\s*Duration: (\d+):(\d+):(\d+(?:\.\d+)?)")
PACKET_FILTER_ERROR = re.compile(r"Error applying bitstream filters to an output packet for stream #(\d+):")


def update(job, **values):
    with LOCK:
        job.update(values)


def enqueue(url, title, custom_title=None, episode=None, public_player=False, jellyfin=None, category="", toon_links=()):
    job = {"id": uuid.uuid4().hex[:12], "title": title, "status": "In coda", "error": "", "seconds": 0}
    with LOCK:
        JOBS[job["id"]] = job
        SOURCES[job["id"]] = (url, custom_title, episode, public_player, jellyfin, category, toon_links)
        queue_job(job, url)
    return job["id"]


def queue_job(job, url):
    ticket = object()
    PENDING_TICKETS.pop(job["id"], None)
    PENDING_TICKETS[job["id"]] = ticket
    PENDING.put((job, url, ticket))


def control(job_id, action):
    with LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise ValueError("Download non trovato")
        status = job["status"]
        if action == "keep-version" and status == "Già esistente":
            job.update(status="In coda", keep_version=True, duplicates=[], quality=None, error="", file=None)
            queue_job(job, SOURCES[job_id][0])
        elif action == "cancel" and status == "Già esistente":
            job.update(status="Saltato", duplicates=[], quality=None, error="", file=None)
        elif action == "resume" and status in {"In pausa", "Errore", "Annullato"}:
            job.update(status="In coda", error="", seconds=0, percent=None, eta=None,
                       bytes_per_second=None)
            queue_job(job, SOURCES[job_id][0])
        elif action in {"pause", "cancel"} and status in {
            "In coda", "Scansione", "Nuovo tentativo", "Download", "Verifica"
        }:
            if status == "In coda":
                PENDING_TICKETS.pop(job_id, None)
                job["status"] = "In pausa" if action == "pause" else "Annullato"
            else:
                job["status"] = "Sospensione" if action == "pause" else "Annullamento"
                process = PROCESSES.get(job_id)
                if process is not None and process.poll() is None:
                    process.kill()
        elif action == "cancel" and status == "In pausa":
            job["status"] = "Annullato"
        else:
            raise ValueError("Comando non disponibile per questo stato")


def worker():
    while True:
        job, url, ticket = PENDING.get()
        conflict = None
        try:
            with LOCK:
                if PENDING_TICKETS.get(job["id"]) is not ticket:
                    continue
                PENDING_TICKETS.pop(job["id"])
                if job["status"] != "In coda":
                    continue
                job["status"] = "Scansione"
            download(job, url, ticket)
        except DuplicateConflict as exc:
            conflict = exc
        except Exception as exc:
            update_active(job, status="Errore", error=f"Errore locale ({type(exc).__name__})")
        finally:
            with LOCK:
                # Do not release a reservation from a newer worker for the same job.
                if RESERVATIONS.get(job["id"], (None,))[0] is ticket:
                    RESERVATIONS.pop(job["id"])
                if job["status"] in STOPPING:
                    job["status"] = "In pausa" if job["status"] == "Sospensione" else "Annullato"
                    job.update(eta=None, bytes_per_second=None)
                elif conflict:
                    job.update(status="Già esistente", title=conflict.path.stem,
                               file=conflict.path.as_posix(), duplicates=conflict.matches,
                               quality=conflict.quality, eta=None, bytes_per_second=None)
                    if conflict.reset_approval:
                        job.pop("keep_version", None)
            PENDING.task_done()


def update_active(job, **values):
    with LOCK:
        if job["status"] in STOPPING:
            return False
        job.update(values)
        return True


def target_path(job, resolved_title):
    _, custom_title, episode, _, jellyfin, _, _ = SOURCES[job["id"]]
    if episode is None:
        match = re.fullmatch(r"(.+?) - S(\d+)E(\d+)", resolved_title)
        if match:
            episode = (match[1], int(match[2]), int(match[3]))
    if jellyfin:
        series, season, override_number, subtitle = jellyfin
        number = override_number if override_number is not None else episode[2] if episode else None
        if number is None:
            raise ValueError("Numero episodio Jellyfin assente")
        code = f"S{season:02d}E{number:02d}"
        name = f"{series} - {code}" + (f" - {subtitle}" if subtitle else "")
        return DATA / "Serie TV" / series / f"Season {season:02d}" / f"{name}.mp4"
    if episode:
        series, season, number, *end = episode
        series = clean_title(custom_title or series)
        suffix = end[0].upper() if end else ""
        return DATA / "Serie TV" / series / f"Season {season:02d}" / f"{series} S{season:02d}E{number:02d}{suffix}.mp4"
    title = clean_title(custom_title or resolved_title or job["title"])
    return DATA / "Video" / f"{title}.mp4"


def library_plan(job, resolved_title, year):
    _, custom_title, episode, _, jellyfin, category, _ = SOURCES[job["id"]]
    episode = episode or media_library.episode_from_title(resolved_title or job["title"])
    explicit = subtitle = ""
    if jellyfin:
        explicit, season, number, subtitle = jellyfin
        if number is None and episode is None:
            raise ValueError("Indica il numero episodio in Destinazione Jellyfin.")
        episode = (explicit, season, number if number is not None else episode[2],
                   "" if number is not None or episode is None or len(episode) < 4 else episode[3])
    if episode:
        series, season, number, *end = episode
        if category == "auto":
            category = "series"
        return media_library.plan(DATA, ARCHIVE, category, explicit or custom_title or series,
                                  (season, number, end[0] if end else ""), explicit=explicit, subtitle=subtitle)
    title = custom_title or resolved_title or job["title"]
    generic = (title.startswith(("Video da ", "Video importato ", "Video in attesa ", "Episodio in attesa "))
               or media_library.identity(title) in {"", "video", "streaming", "videomp4"}
               or (not resolved_title and bool(re.fullmatch(r"\d+|[\da-f]{20,}", title, re.I))))
    if generic and not custom_title:
        if category == "auto":
            return None
        raise ValueError("Il link non fornisce un titolo riconoscibile. Indica il titolo per la libreria.")
    if category == "auto":
        category = "movie"
    return media_library.plan(DATA, ARCHIVE, category, title, None, year=year)


def reserve_destination(job, ticket, plan):
    other = [reservation for job_id, reservation in RESERVATIONS.items() if job_id != job["id"]]
    candidates = [*plan.duplicates]
    candidates.extend(f"In coda/{path.as_posix()}" for _, path, keys in other if keys & plan.keys)
    path = plan.path
    paths = {str(reserved.with_suffix("")).casefold() for _, reserved, _ in other}

    def unavailable(candidate):
        return (str(candidate.with_suffix("")).casefold() in paths
                or media_library.occupied(DATA, ARCHIVE, candidate))

    if unavailable(path) and not candidates:
        candidates.append(path.as_posix())
    if candidates and not job.get("keep_version"):
        raise DuplicateConflict(path, list(dict.fromkeys(candidates))[:8])
    if candidates or job.get("keep_version"):
        for number in range(2, 1000):
            version = path.with_name(f"{path.stem} - Versione {number}{path.suffix}")
            if not unavailable(version):
                path = version
                break
        else:
            raise ValueError("Troppe versioni dello stesso contenuto.")
    RESERVATIONS[job["id"]] = (ticket, path, plan.keys)
    return DATA / path


def download(job, url, ticket=None):
    partial = DATA / f'.{job["id"]}.part'
    container = "mp4"
    excluded_audio = None
    stall_retried = False
    attempt = 0
    try:
        while True:
            if not update_active(job, status="Scansione" if attempt == 0 else "Nuovo tentativo",
                                 seconds=0, duration=None, percent=None, eta=None, bytes_per_second=None):
                return
            resolved_title = ""
            resolved_year = ""
            toon_links = SOURCES[job["id"]][6]
            if toon_links:
                result = verified_toon_media(toon_links)
                if not result["success"]:
                    update_active(job, status="Errore", error=result["error"])
                    return
                media, headers = result["media_url"], result["headers"]
            elif not is_vix_playlist(url) and (resolver.is_streamingcommunity_url(url) or SOURCES[job["id"]][3]):
                if resolver.is_streamingcommunity_url(url):
                    result = resolver.resolve_streamingcommunity_stream(url, prefer_mp4=True)
                else:
                    result = public_sources.resolve(url)
                if not result["success"]:
                    update_active(job, status="Errore", error=result["error"])
                    return
                media, headers = result["media_url"], result["headers"]
                resolved_title = result.get("title", "")
                resolved_year = result.get("year", "")
            elif urlsplit(url).path.lower().endswith(".m3u8") or is_vix_playlist(url):
                result = imported_playlist(url)
                if not result["success"]:
                    update_active(job, status="Errore", error=result["error"])
                    return
                media, headers = result["media_url"], result["headers"]
            else:
                media, headers = url, {}
            try:
                plan = None
                if SOURCES[job["id"]][5]:
                    with LOCK:
                        if job["status"] in STOPPING:
                            return
                        plan = library_plan(job, resolved_title, resolved_year)
                        if plan:
                            preferred = reserve_destination(job, ticket, plan)
                managed = plan is not None
                if not managed:
                    preferred = target_path(job, resolved_title)
                if not preferred.parent.resolve().is_relative_to(DATA.resolve()):
                    raise ValueError("Destinazione fuori dalla cartella download.")
            except DuplicateConflict as conflict:
                conflict.quality = media_library.compare_quality(DATA, ARCHIVE, media, headers, conflict.matches)
                raise
            except ValueError as exc:
                update_active(job, status="Errore", error=str(exc))
                return
            target = preferred.with_suffix("." + container)
            alternative = preferred.with_suffix(".mkv" if container == "mp4" else ".mp4")
            relative = target.relative_to(DATA).as_posix()
            if target.exists() or alternative.exists():
                update_active(job, status="Errore", error="Esiste già un file con questo nome", file=relative)
                return
            media_path = urlsplit(media).path.lower()
            transfer = "MP4 diretto" if media_path.endswith(".mp4") else "HLS"
            if not update_active(job, status="Download", file=relative, title=target.stem, transfer=transfer):
                return
            code, stalled, detail, bad_audio = run_ffmpeg(
                job, media, headers, partial, container=container, excluded_audio=excluded_audio
            )
            if code == 0 and update_active(job, status="Verifica", eta=None, bytes_per_second=None):
                if verify(partial, job.get("duration")):
                    with LOCK:
                        if job["status"] in STOPPING:
                            return
                        target.parent.mkdir(parents=True, exist_ok=True)
                        if managed and media_library.occupied(DATA, ARCHIVE, target.relative_to(DATA)):
                            raise DuplicateConflict(target.relative_to(DATA), [relative], reset_approval=True)
                        if not managed and (target.exists() or alternative.exists()):
                            job.update(status="Errore", error="Esiste già un file con questo nome")
                            return
                        try:
                            if managed and os.name != "nt":
                                os.link(partial, target)
                            else:
                                partial.rename(target)
                        except FileExistsError:
                            raise DuplicateConflict(target.relative_to(DATA), [relative], reset_approval=True)
                        job.update(status="Completato", file=relative, percent=100)
                        if excluded_audio is not None:
                            job["warning"] = "Una traccia audio secondaria danneggiata è stata esclusa."
                    return
            partial.unlink(missing_ok=True)
            if stalled and not stall_retried:
                stall_retried = True
                attempt += 1
                continue
            if code and container == "mp4" and mp4_mux_error(detail):
                container = "mkv"
                attempt += 1
                continue
            if code and not stalled and container == "mkv" and bad_audio is not None and excluded_audio is None:
                excluded_audio = bad_audio
                attempt += 1
                continue
            if stalled:
                update_active(job, status="Errore", error="FFmpeg fermo per 60 secondi anche dopo il secondo tentativo")
            else:
                error = (
                    f"FFmpeg (uscita {code}): {detail or 'nessun dettaglio disponibile'}"
                    if code else "Il file prodotto non ha superato la verifica"
                )
                update_active(job, status="Errore", error=error)
            return
    finally:
        partial.unlink(missing_ok=True)


def progress_metrics(fields, seconds, duration, bytes_per_second):
    rate = fields.get("speed", "").rstrip("x")
    speed = float(rate) if re.fullmatch(r"\d+(?:\.\d+)?", rate) else 0
    return {
        "seconds": seconds,
        "media_speed": speed or None,
        "percent": min(99.9, seconds / duration * 100) if duration else None,
        "eta": max(0, round((duration - seconds) / speed)) if duration and speed and seconds < duration else None,
        "bytes_per_second": bytes_per_second,
    }


def mp4_mux_error(line):
    return bool(re.search(
        r"Error applying bitstream filters|Could not find tag for codec|codec not currently supported in container",
        line, re.I,
    ))


def run_ffmpeg(job, media, headers, partial, container="mp4", excluded_audio=None):
    header_args = []
    if headers:
        header_args = ["-headers", "".join(f"{key}: {value}\r\n" for key, value in headers.items())]
    output_args = ["-movflags", "+faststart", "-f", "mp4"] if container == "mp4" else ["-f", "matroska"]
    audio_args = ["-map", "0:a?"] if excluded_audio is None else ["-map", "0:a", "-map", f"-0:a:{excluded_audio}"]
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "info", "-y",
        "-progress", "pipe:1", "-nostats", "-rw_timeout", "15000000",
        "-protocol_whitelist", "http,https,tcp,tls,crypto",
        *header_args, "-i", media, "-map", "0:v:0", *audio_args,
        "-c", "copy", *output_args, str(partial),
    ]
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
        with LOCK:
            if job["status"] in STOPPING:
                process.kill()
                return 1, False, "", None
            PROCESSES[job["id"]] = process
        errors = deque(maxlen=6)
        mux_errors = deque(maxlen=1)
        failed_outputs = set()

        def read_errors():
            for line in process.stderr:
                if match := PACKET_FILTER_ERROR.search(line):
                    failed_outputs.add(int(match[1]))
                duration_match = DURATION.match(line)
                if duration_match:
                    hours, minutes, seconds = map(float, duration_match.groups())
                    duration = hours * 3600 + minutes * 60 + seconds
                    if duration > 0:
                        update(job, duration=duration)
                safe = re.sub(r"https?://[^\s'\"]+", "[URL]", line.strip())
                safe = re.sub(r"(?i)(token|signature|cookie|authorization)=[^\s&]+", r"\1=[omesso]", safe)
                if safe:
                    errors.append(safe[:240])
                    if mp4_mux_error(safe):
                        mux_errors.append(safe[:240])

        reader = threading.Thread(target=read_errors, daemon=True)
        reader.start()
        activity = threading.Event()
        done = threading.Event()
        stalled = threading.Event()

        def watchdog():
            while not done.is_set():
                if not activity.wait(60) and not done.is_set() and process.poll() is None:
                    stalled.set()
                    process.kill()
                    return
                activity.clear()

        thread = threading.Thread(target=watchdog, daemon=True)
        thread.start()
        try:
            seconds = 0
            fields = {}
            samples = deque()
            for line in process.stdout:
                key, separator, value = line.strip().partition("=")
                if not separator:
                    continue
                fields[key] = value
                if key != "progress":
                    continue
                position = fields.get("out_time_us", "")
                if position.isdigit() and int(position) / 1_000_000 > seconds:
                    seconds = int(position) / 1_000_000
                    activity.set()
                now = time.monotonic()
                size = fields.get("total_size", "")
                rate = None
                if size.isdigit():
                    samples.append((now, int(size)))
                    while len(samples) > 1 and now - samples[0][0] > 5:
                        samples.popleft()
                    elapsed = now - samples[0][0]
                    if elapsed > 0:
                        rate = max(0, (int(size) - samples[0][1]) / elapsed)
                update(job, **progress_metrics(fields, seconds, job.get("duration"), rate))
                fields.clear()
            code = process.wait(timeout=10)
            reader.join()
            # Output 0 is the video and output 1 is the first audio track.
            failed_output = next(iter(failed_outputs)) if len(failed_outputs) == 1 else 0
            bad_audio = failed_output - 1 if failed_output > 1 else None
            return code, stalled.is_set(), " | ".join(mux_errors or errors)[-700:], bad_audio
        finally:
            done.set()
            activity.set()
            if process.poll() is None:
                process.kill()
            thread.join()
            reader.join(timeout=2)
            with LOCK:
                PROCESSES.pop(job["id"], None)


def verify(path, expected=None):
    if not path.is_file() or not path.stat().st_size:
        return False
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name:format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, timeout=20,
    )
    if probe.returncode:
        return False
    metadata = json.loads(probe.stdout)
    duration = float(metadata.get("format", {}).get("duration", 0))
    return bool(metadata.get("streams")) and duration > 0 and (
        not expected or duration >= expected - max(2, expected * 0.02)
    )


def input_url(value):
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Serve un URL HTTP o HTTPS valido")
    return parsed


class Handler(BaseHTTPRequestHandler):
    def authenticated(self):
        expected = "Basic " + base64.b64encode(f"admin:{PASSWORD}".encode()).decode()
        if hmac.compare_digest(self.headers.get("Authorization", "").encode(), expected.encode()):
            return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Local Stream Manager", charset="UTF-8"')
        self.end_headers()
        return False

    def send(self, body, mime, status=200):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def json(self, value, status=200):
        self.send(json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8", status)

    def do_GET(self):
        if self.path in {"/icon.png", "/favicon.png"}:
            self.send(Path(__file__).with_name(self.path[1:]).read_bytes(), "image/png")
            return
        if not self.authenticated():
            return
        if self.path == "/":
            self.send(Path(__file__).with_name("index.html").read_bytes(), "text/html; charset=utf-8")
        elif self.path == "/maintenance":
            self.json({"archive": (ARCHIVE / ".lsm-toshiba").is_file()})
        elif self.path == "/jobs":
            with LOCK:
                positions = {job_id: pos for pos, job_id in enumerate(PENDING_TICKETS, 1)}
                jobs = [dict(item, queue_position=positions.get(item["id"])) for item in JOBS.values()]
            self.json(jobs)
        elif self.path == "/library":
            self.json(sorted(p.relative_to(DATA).as_posix() for p in DATA.rglob("*")
                             if p.suffix.lower() in {".mp4", ".mkv"} and p.is_file() and not any(part.startswith(".") for part in p.relative_to(DATA).parts)))
        else:
            self.json({"error": "Pagina inesistente"}, 404)

    def do_POST(self):
        if not self.authenticated():
            return
        command = re.fullmatch(r"/jobs/([0-9a-f]{12})/(pause|resume|cancel|keep-version)", self.path)
        if command:
            if self.headers.get_content_type() != "application/json":
                self.json({"error": "Formato non valido"}, 415)
                return
            try:
                control(*command.groups())
            except ValueError as exc:
                self.json({"error": str(exc)}, 409)
            else:
                self.json({"ok": True})
            return
        if self.path not in {"/jobs", "/toonitalia/catalogo"}:
            self.json({"error": "Pagina inesistente"}, 404)
            return
        if self.headers.get_content_type() != "application/json":
            self.json({"error": "Formato non valido"}, 415)
            return
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= 524288:
                raise ValueError("Richiesta vuota o troppo grande")
            payload = json.loads(self.rfile.read(size))
            if self.path == "/toonitalia/catalogo":
                url = payload["url"].strip()
                input_url(url)
                if public_sources.provider(url) != "Toonitalia" or not public_sources.is_listing(url):
                    raise ValueError("Incolla l'indirizzo di una serie Toonitalia.")
                items = public_sources.episodes(url)
                self.json({"episodes": [
                    {"key": f'{ep["season"]}:{ep["number"]}', "title": ep["title"],
                     "opening": ep["number"] == 0} for ep in items
                ]})
                return
            category = payload.get("category", "")
            if category not in ("", "auto", *media_library.CATEGORIES):
                raise ValueError("Categoria per la libreria non valida")
            jellyfin = jellyfin_options(payload.get("jellyfin"))
            if jellyfin and category == "movie":
                raise ValueError("I campi per gli episodi si usano con Serie TV o Cartoni")
            if "links" in payload:
                if jellyfin:
                    raise ValueError("Usa i campi Jellyfin con un link singolo o una pagina serie")
                toon = payload.get("import_source") == "toonlink"
                if toon and category in {"", "auto"}:
                    category = "cartoon"
                items = parse_import(payload["links"], payload.get("title", ""),
                                     managed=bool(category), allow_expired=toon)
                ids = [enqueue(*item, category=category,
                               toon_links=(item[0],) if public_sources.toon_player(item[0])
                               or (toon and public_sources.media_link(item[0])) else ())
                       for item in items]
                self.json({"ids": ids}, 202)
                return
            url = payload["url"].strip()
            parsed = input_url(url)
            custom_title = payload.get("title", "").strip() or None
            site = public_sources.provider(url)
            if site == "CB01" and not re.fullmatch(r"/[^/]+/?", parsed.path):
                raise ValueError("Incolla il link alla scheda di un film CB01")
            if resolver.is_series_url(url) or public_sources.is_listing(url):
                messages = []
                if site:
                    try:
                        episodes = public_sources.episodes(url)
                    except (OSError, ValueError, TypeError, KeyError) as exc:
                        raise ValueError(resolver._error(site, exc)) from exc
                else:
                    try:
                        episodes = resolver.title_entries(url)
                    except (OSError, ValueError, KeyError, TypeError) as exc:
                        raise ValueError(resolver._error("Pagina titolo", exc)) from exc
                if not episodes:
                    raise ValueError(messages[-1] if messages else "Nessun episodio disponibile")
                if "episodes" in payload:
                    selected = payload["episodes"]
                    if site != "Toonitalia" or not isinstance(selected, list) or not selected or any(
                            not isinstance(key, str) or not re.fullmatch(r"\d{1,2}:\d{1,4}", key)
                            for key in selected):
                        raise ValueError("Seleziona gli episodi Toonitalia da accodare.")
                    keys = set(selected)
                    episodes = [ep for ep in episodes if f'{ep["season"]}:{ep["number"]}' in keys]
                    if len(episodes) != len(keys):
                        raise ValueError("L'elenco Toonitalia è cambiato. Ricarica gli episodi.")
                if jellyfin and len(episodes) > 1 and any(jellyfin[2:]):
                    raise ValueError("Per più episodi, imposta solo il nome serie e la stagione Jellyfin")
                if jellyfin and any("season" not in ep for ep in episodes) and jellyfin[2] is None:
                    raise ValueError("Per un video singolo indica il numero episodio Jellyfin")
                ids = [enqueue(ep["url"], ep["title"], custom_title,
                               (ep["title"].rsplit(" - S", 1)[0], ep["season"], ep["number"])
                               if "season" in ep else None, bool(site), jellyfin,
                               "cartoon" if site == "Toonitalia" and category in {"", "auto"} else category,
                               ep.get("alternatives", ()))
                       for ep in episodes]
            elif resolver.is_streamingcommunity_url(url) or site in {"AnimeUnity", "AnimeSaturn", "CB01"} or parsed.path.lower().endswith(".mp4"):
                label = custom_title or queued_title(parsed)
                if not custom_title and resolver.is_streamingcommunity_url(url):
                    label = episode_label(url) or label
                if jellyfin and jellyfin[2] is None and not resolver.is_streamingcommunity_url(url):
                    raise ValueError("Indica il numero episodio Jellyfin per questo link")
                ids = [enqueue(url, clean_title(label), custom_title, public_player=bool(site),
                               jellyfin=jellyfin, category=category)]
            else:
                raise ValueError("Inserisci una pagina episodio supportata o un URL MP4 diretto autorizzato")
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            self.json({"error": str(exc)}, 400)
            return
        self.json({"ids": ids}, 202)


def jellyfin_options(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("Destinazione Jellyfin non valida")
    series = value.get("series", "")
    subtitle = value.get("subtitle", "")
    season = value.get("season")
    number = value.get("episode")
    if (not isinstance(series, str) or not series.strip(" .") or not isinstance(subtitle, str)
            or type(season) is not int or not 0 <= season <= 999
            or (number is not None and (type(number) is not int or not 1 <= number <= 9999))):
        raise ValueError("Controlla il nome della serie, la stagione e il numero episodio Jellyfin")
    series = clean_title(series.encode("utf-8")[:105].decode("utf-8", errors="ignore"))
    subtitle = clean_title(subtitle.encode("utf-8")[:95].decode("utf-8", errors="ignore")) if subtitle.strip() else ""
    return series, season, number, subtitle


def is_vix_playlist(url):
    parsed = urlsplit(url)
    return parsed.hostname in {"vixcloud.cc", "www.vixcloud.cc"} and parsed.path.startswith("/playlist/")


def imported_playlist(url, headers=None):
    headers = headers or {"User-Agent": resolver.USER_AGENT}
    session = resolver._new_session()
    try:
        pending = [url]
        visited = set()
        while pending:
            current = pending.pop()
            if current in visited:
                continue
            if len(visited) >= 64:
                raise ValueError("Playlist con troppe varianti")
            visited.add(current)
            manifest, final = resolver._fetch(session, current, 15, referer=headers.get("Referer"))
            if not manifest.lstrip().startswith("#EXTM3U"):
                raise ValueError("Risposta HLS non valida")
            variants = False
            for line in manifest.splitlines():
                line = line.strip()
                if line.startswith(("#EXT-X-KEY:", "#EXT-X-SESSION-KEY:")):
                    if not re.search(r"(?:^|,)METHOD=NONE(?:,|$)", line.split(":", 1)[1]):
                        raise ValueError("L’importazione richiede una playlist HLS non cifrata")
                if line.startswith(("#EXT-X-STREAM-INF:", "#EXT-X-I-FRAME-STREAM-INF:", "#EXT-X-MEDIA:")):
                    variants = True
                    match = re.search(r'(?:^|,)URI="([^"]+)"', line.split(":", 1)[1])
                    if match:
                        pending.append(urljoin(final, match[1]))
            if variants:
                pending.extend(urljoin(final, line.strip()) for line in manifest.splitlines()
                               if line.strip() and not line.lstrip().startswith("#"))
        return {"success": True, "media_url": url, "headers": headers}
    except (OSError, ValueError) as exc:
        error = str(exc) if type(exc) is ValueError else resolver._error("Playlist importata", exc)
        return {"success": False, "error": error}


def verified_toon_media(links):
    failures = []
    for link in links:
        host = urlsplit(link).hostname
        try:
            if expired_link(link):
                failures.append(f"{host}: indirizzo scaduto")
                continue
            if public_sources.toon_player(link):
                media, headers = public_sources.resolve_toon_player(link)
            else:
                media, headers = link, {"User-Agent": resolver.USER_AGENT}
            if urlsplit(media).path.lower().endswith(".m3u8"):
                playlist = imported_playlist(media, headers)
                if not playlist["success"]:
                    failures.append(f"{host}: {playlist['error']}")
                    continue
            if media_library.probe_video(media, headers) is None:
                failures.append(f"{host}: flusso video non leggibile dal NAS")
                continue
            return {"success": True, "media_url": media, "headers": headers}
        except (OSError, ValueError) as exc:
            failures.append(resolver._error(host, exc))
    return {"success": False, "error": "Nessun flusso leggibile dal NAS. " + " • ".join(failures)}


def expired_link(url):
    expiry = parse_qs(urlsplit(url).query).get("expires", [""])[0]
    return expiry.isascii() and expiry.isdigit() and int(expiry) <= time.time()


def parse_import(raw, common_title, managed=False, allow_expired=False):
    if not isinstance(raw, str) or not isinstance(common_title, str):
        raise ValueError("Formato elenco non valido")
    text = raw.lstrip("\ufeff").strip()
    rows = json.loads(text) if text.startswith("[") else [
        {"text": line.strip()} for line in text.splitlines() if line.strip()
    ]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 500:
        raise ValueError("Incolla da 1 a 500 link")
    result = []
    seen = set()
    for position, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise ValueError(f"Voce {position}: formato non valido")
        url, filename = row.get("text", ""), row.get("filename", "")
        if not isinstance(url, str) or not isinstance(filename, str):
            raise ValueError(f"Voce {position}: formato non valido")
        url, filename = url.strip(), filename.strip()
        if re.search(r"\s", url):
            raise ValueError(f"Voce {position}: URL non valido")
        try:
            parsed = input_url(url)
        except ValueError:
            raise ValueError(f"Voce {position}: URL non valido") from None
        path = parsed.path.lower()
        vix = parsed.hostname in {"vixcloud.cc", "www.vixcloud.cc"} and path.startswith(("/embed/", "/playlist/"))
        if not (path.endswith((".mp4", ".m3u8")) or vix or public_sources.toon_player(url)):
            raise ValueError(f"Voce {position}: serve un MP4, una playlist HLS o un player supportato")
        if not allow_expired and expired_link(url):
            raise ValueError(f"Voce {position}: link scaduto, esportalo di nuovo")
        if url in seen:
            raise ValueError(f"Voce {position}: link duplicato")
        seen.add(url)
        title = re.sub(r"\.mp4$", "", filename, flags=re.I)
        episode = None
        match = re.fullmatch(r"(.+?)\s+[-–]?\s*S(\d+)E(\d+)(-E\d+)?", title, re.I)
        if match:
            episode = (match[1].strip(), int(match[2]), int(match[3]), match[4] or "")
        elif managed:
            episode = media_library.episode_from_title(title or queued_title(parsed))
        if not title:
            title = f"{common_title or 'Video importato'} · {position:02d}" if len(rows) > 1 else common_title or queued_title(parsed)
        destination_title = (common_title or None) if episode or (managed and not filename) else clean_title(title)
        result.append((url, clean_title(title), destination_title, episode))
    return result


def episode_label(url):
    try:
        html, _ = resolver._fetch(resolver._new_session(), url, 5)
        props = resolver._props(html)
        title = (props.get("title") or {}).get("name")
        episode = props.get("episode") or {}
        if title and episode.get("number") is not None:
            season = int((episode.get("season") or {}).get("number", 1))
            return f'{title} S{season:02d}E{int(episode["number"]):02d}'
        return title
    except (OSError, ValueError, KeyError, TypeError):
        return None


def queued_title(parsed):
    name = unquote(parsed.path.rsplit("/", 1)[-1])
    if parsed.path.lower().endswith(".mp4"):
        return name[:-4] or "Video MP4"
    episode = parse_qs(parsed.query).get("e", [""])[0]
    if episode.isascii() and episode.isdigit():
        return "Episodio in attesa di scansione"
    if name.isascii() and name.isdigit():
        return "Video in attesa di scansione"
    return f"Video da {parsed.hostname}"


if __name__ == "__main__":
    if not PASSWORD or ":" in PASSWORD:
        raise SystemExit("Imposta LSM_PASSWORD con una password senza due punti")
    DATA.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=monitor_archive, daemon=True).start()
    for _ in range(MAX_DOWNLOADS):
        threading.Thread(target=worker, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8097), Handler).serve_forever()
