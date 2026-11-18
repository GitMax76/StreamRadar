"""Name new downloads and compare them with the mounted media libraries."""

import json
import re
import subprocess
import unicodedata
from dataclasses import dataclass
from pathlib import Path


CATEGORIES = {"movie": "Movies", "series": "Serie TV", "cartoon": "Cartoni"}
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".ts", ".wmv", ".mpg", ".mpeg"}
EPISODE = re.compile(
    r"(?<![^\W_])(?:s(?P<season>\d{1,3})[\s._-]*e|(?P<cross>\d{1,3})x)"
    r"(?P<first>\d{1,4})(?:[\s._-]*e(?P<last>\d{1,4}))?(?!\d)", re.I
)
RELEASE = re.compile(
    r"[\s._\[(\-]+(?:2160p|1080[pi]|720p|480p|4k|uhd|blu[ ._-]?ray|web[ ._-]?(?:dl|rip)|"
    r"hdrip|bdrip|dvdrip|x26[45]|hevc|versione\s+\d+|director.s\s+cut|extended\s+cut)\b.*$", re.I
)
YEAR = re.compile(r"(?:[\s._-]+[\[(]?|[\[(])((?:18|19|20|21)\d{2})[\])]?\s*$")
SEASON = re.compile(r"(?:season|stagione|s)[\s._-]*0*(\d{1,3})", re.I)


@dataclass(frozen=True)
class Plan:
    path: Path
    keys: frozenset
    duplicates: tuple[str, ...]


def clean_title(title, limit=160):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", title).encode("utf-8")[:limit].decode(
        "utf-8", errors="ignore"
    ).strip(" .") or "Video"


def identity(value):
    folded = unicodedata.normalize("NFKD", value.casefold())
    return "".join(char for char in folded if char.isalnum())


def work_title(value, year=""):
    value = re.sub(r"(?:\s*[\[{](?:tmdb|imdb|tvdb)(?:id)?[-=][^\]}]+[\]}])+\s*$", "", value, flags=re.I)
    release = RELEASE.search(value)
    if release:
        value = value[:release.start()].replace(".", " ").replace("_", " ").rstrip()
    # Require a title before a year so a movie titled “1917” keeps its name.
    match = YEAR.search(value)
    if match and identity(value[:match.start()]) and (
            release or any(char in match[0] for char in "([._") or str(year) == match[1]):
        year = match[1]
        value = value[:match.start()].strip(" ._-")
    return value, str(year) if re.fullmatch(r"(?:18|19|20|21)\d{2}", str(year)) else ""


def episode_from_title(title):
    match = EPISODE.search(title)
    if not match:
        return None
    series = title[:match.start()].strip(" ._-")
    if not series:
        return None
    season, first = int(match["season"] or match["cross"]), int(match["first"])
    return series, season, first, f'-E{int(match["last"]):02d}' if match["last"] else ""


def children(path):
    if path.is_symlink() or not path.is_dir():
        return []
    return sorted((child for child in path.iterdir()
                   if not child.name.startswith(".") and not child.is_symlink()), key=lambda child: child.name)


def library_roots(downloads, archive):
    return (("Toshiba", archive), ("Download", downloads))


def similar(name, year, other):
    other_name, other_year = work_title(other, year)
    return identity(name) == identity(other_name) and (not year or not other_year or year == other_year)


def matching_folder(roots, category, name, year, explicit):
    folders = [(label, folder) for label, root in roots for folder in children(root / category)
               if folder.is_dir() and similar(name, year, folder.name)]
    if explicit:
        exact = [(label, folder) for label, folder in folders if folder.name == explicit]
        return exact
    years = {work_title(folder.name)[1] for _, folder in folders} - {""}
    if not year and len(years) > 1:
        raise ValueError("Ci sono cartelle omonime di anni diversi. Indica il titolo con l’anno o il nome esatto della cartella.")
    canonical = {identity(folder.name) for _, folder in folders}
    if len(canonical) > 1 and len({folder.name for label, folder in folders if label == "Toshiba"}) > 1:
        raise ValueError("Più cartelle della libreria corrispondono. Indica il nome esatto della cartella.")
    return folders


def matching_season(name, season):
    match = SEASON.fullmatch(name)
    return (bool(match) and int(match[1]) == season) or (season == 0 and name.casefold() == "specials")


def episode_numbers(path, season_hint=None):
    match = EPISODE.search(path.stem)
    if match:
        first = int(match["first"])
        last = min(int(match["last"] or first), first + 100)
        return int(match["season"] or match["cross"]), range(first, max(first, last) + 1)
    if season_hint is not None:
        match = re.match(r"(?:e|ep(?:isodio)?[ ._-]*)0*(\d{1,4})(?!\d)|^0*(\d{1,4})$", path.stem, re.I)
        if match:
            number = int(match[1] or match[2])
            return season_hint, range(number, number + 1)
    return None, ()


def movie_duplicate(path, name, year, folder_name=None):
    if path.suffix.lower() not in VIDEO_EXTENSIONS or not path.is_file():
        return False
    stem = path.stem[:len(folder_name)] if folder_name and (
        path.stem.casefold().startswith(folder_name.casefold() + " - ")) else path.stem
    if re.search(r"(?:^|[- ._])(?:trailer|sample|featurette|teaser|behind the scenes)$", path.stem, re.I):
        return False
    file_year = work_title(stem)[1]
    if year and file_year and file_year != year:
        return False
    return similar(name, year, stem) or (folder_name is not None and not EPISODE.search(path.stem))


def plan(downloads, archive, category, title, episode, year="", explicit="", subtitle=""):
    roots = library_roots(downloads, archive)
    section = CATEGORIES[category]
    if category == "movie" and episode:
        raise ValueError("Il link identifica un episodio. Scegli Serie TV o Cartoni.")
    if category == "series" and not episode:
        raise ValueError("Indica serie, stagione ed episodio in Destinazione Jellyfin.")
    name, year = work_title(title, year)
    if not identity(name) or identity(name) in {"video", "streaming", "videomp4"}:
        raise ValueError("Indica un titolo per la libreria e riprova.")
    folders = matching_folder(roots, section, name, year, explicit)
    if not episode and year:
        # A yearless folder can already belong to a different remake.
        folders = [(label, folder) for label, folder in folders
                   if not any(file.suffix.lower() in VIDEO_EXTENSIONS and
                              work_title(file.stem)[1] not in ("", year) for file in children(folder))
                   or any(movie_duplicate(file, name, year, folder.name) for file in children(folder))]
    folder_name = folders[0][1].name if folders else explicit or clean_title(f"{name} ({year})" if year else name)
    duplicates = []

    if episode:
        season, first, suffix = episode
        last = max(first, int(suffix[2:])) if suffix else first
        numbers = set(range(first, min(last, first + 100) + 1))
        season_name = f"Season {season:02d}"
        found_season = False
        for label, folder in folders:
            season_folders = [child for child in children(folder)
                              if child.is_dir() and matching_season(child.name, season)]
            if season_folders and not found_season:
                season_name = season_folders[0].name
                found_season = True
            candidates = [(file, None) for file in children(folder)]
            candidates.extend((file, season) for season_folder in season_folders for file in children(season_folder))
            for file, season_hint in candidates:
                if file.suffix.lower() not in VIDEO_EXTENSIONS or not file.is_file():
                    continue
                their_season, their_numbers = episode_numbers(file, season_hint)
                if their_season == season and numbers.intersection(their_numbers):
                    base = archive if label == "Toshiba" else downloads
                    duplicates.append(f"{label}/{file.relative_to(base).as_posix()}")
        prefix = clean_title(folder_name, limit=105)
        code = f"S{season:02d}E{first:02d}{suffix}"
        filename = f"{prefix} - {code}" + (f" - {subtitle}" if subtitle else "")
        path = Path(section, folder_name, season_name, filename + ".mp4")
        keys = frozenset((section, identity(folder_name), season, number) for number in numbers)
    else:
        for label, root in roots:
            candidates = [(file, None) for file in children(root / section)]
            if category == "movie" and label == "Download":
                candidates.extend((file, None) for file in children(root / "Video"))
            candidates.extend((file, folder.name) for origin, folder in folders
                              if origin == label for file in children(folder))
            for file, movie_folder in candidates:
                if movie_duplicate(file, name, year, movie_folder):
                    duplicates.append(f"{label}/{file.relative_to(root).as_posix()}")
        path = Path(section, folder_name, clean_title(folder_name) + ".mp4")
        keys = frozenset({(section, identity(name), year)})
    return Plan(path, keys, tuple(duplicates))


def occupied(downloads, archive, path):
    for _, root in library_roots(downloads, archive):
        target = root / path
        if any(child.is_file() and child.suffix.lower() in VIDEO_EXTENSIONS and
               child.stem.casefold() == target.stem.casefold() for child in children(target.parent)):
            return True
        if target.is_symlink() or target.exists():
            return True
    return False


def probe_video(source, headers=None):
    remote = headers is not None
    args = ["ffprobe", "-v", "error", "-probesize", "1000000", "-analyzeduration", "1500000"]
    if remote:
        args += ["-rw_timeout", "4000000", "-protocol_whitelist", "http,https,tcp,tls,crypto"]
        if headers:
            args += ["-headers", "".join(f"{key}: {value}\r\n" for key, value in headers.items())]
    else:
        args += ["-protocol_whitelist", "file"]
    args += ["-select_streams", "v:0", "-show_entries",
             "stream=width,height,codec_name,color_transfer:stream_disposition=attached_pic",
             "-of", "json", "-i", str(source)]
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=6 if remote else 2)
        if result.returncode:
            return None
        streams = json.loads(result.stdout).get("streams", [])
        if not streams or streams[0].get("disposition", {}).get("attached_pic"):
            return None
        stream = streams[0]
        width, height = int(stream["width"]), int(stream["height"])
        if not width or not height:
            return None
        codec = stream.get("codec_name", "").upper()
        codec = {"HEVC": "H.265", "H264": "H.264"}.get(codec, codec)
        dynamic_range = {"smpte2084": "HDR (PQ)", "arib-std-b67": "HDR (HLG)"}.get(stream.get("color_transfer"))
        label = " · ".join(filter(None, (f"{width}×{height}", codec, dynamic_range)))
        long_side = max(width, height)
        tier = sum(long_side >= edge for edge in (720, 1280, 1920, 2560, 3840))
        return {"label": label, "tier": tier, "width": width, "height": height}
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        return None


def compare_quality(downloads, archive, media, headers, matches):
    roots = dict(library_roots(downloads, archive))
    existing = {}
    for match in matches:
        origin, _, relative = match.partition("/")
        root = roots.get(origin)
        if root is None:
            continue
        try:
            path = (root / relative).resolve(strict=True)
        except OSError:
            continue
        if path.is_relative_to(root.resolve()) and path.is_file():
            existing[match] = probe_video(path)
        if len(existing) >= 3:
            break
    if not existing:
        return None
    source = probe_video(media, headers)
    comparisons = {}
    for match, video in existing.items():
        relation = None
        if source and video:
            if source["tier"] > video["tier"]:
                relation = "La fonte ha una risoluzione maggiore"
            elif source["tier"] < video["tier"]:
                relation = "Il file presente ha una risoluzione maggiore"
            else:
                relation = "Risoluzione della stessa fascia"
        comparisons[match] = {"label": video["label"] if video else None, "relation": relation}
    return {"source": source["label"] if source else None, "existing": comparisons}
