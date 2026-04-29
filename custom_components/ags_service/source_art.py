"""Default artwork helpers for AGS media sources."""

from __future__ import annotations

from typing import Any

SOURCE_ART_BASE = "/ags-static/assets/source-art"

_SOURCE_ART_ALIASES = {
    "app store": "app-store",
    "arcade": "arcade",
    "apple music": "apple-music",
    "big time sports": "big-time-sports",
    "bravo": "bravo",
    "cbs": "cbs",
    "cbs news": "cbs",
    "computers": "computers",
    "disney": "disney-plus",
    "disney+": "disney-plus",
    "dropout": "dropout",
    "espn": "espn",
    "facetime": "facetime",
    "fitness": "fitness",
    "fox sports": "fox-sports",
    "hbo go": "max",
    "hbo max": "max",
    "hulu": "hulu",
    "jetpack joyride": "jetpack-joyride",
    "marbleitup": "marble-it-up",
    "marble it up": "marble-it-up",
    "max": "max",
    "music": "apple-music",
    "nbc sports": "nbc-sports",
    "netflix": "netflix",
    "nhl": "nhl",
    "pandora": "pandora",
    "paramount": "paramount-plus",
    "paramount+": "paramount-plus",
    "photos": "photos",
    "plex": "plex",
    "podcasts": "podcasts",
    "prime": "prime-video",
    "prime video": "prime-video",
    "search": "search",
    "settings": "settings",
    "sonic racing": "sonic-racing",
    "spotify": "spotify",
    "tv": "tv",
    "twitch": "twitch",
    "ur the rink": "ur-the-rink",
    "usa": "usa",
    "youtube": "youtube",
    "youtube tv": "youtube-tv",
}


def _clean(value: Any) -> str:
    return str(value or "").strip().casefold()


def source_artwork_url(*values: Any) -> str | None:
    """Return a bundled artwork URL for the first recognizable source label."""
    labels = [_clean(value) for value in values if _clean(value)]
    for label in labels:
        if label in _SOURCE_ART_ALIASES:
            return f"{SOURCE_ART_BASE}/{_SOURCE_ART_ALIASES[label]}.svg"
    for label in labels:
        for needle, asset_name in _SOURCE_ART_ALIASES.items():
            if needle in label:
                return f"{SOURCE_ART_BASE}/{asset_name}.svg"
    return None


def apply_default_source_art(source: dict | None) -> dict | None:
    """Return a source copy with default thumbnail artwork when no art exists."""
    if not isinstance(source, dict):
        return source
    if source.get("thumbnail"):
        return source
    artwork = source_artwork_url(
        source.get("Source"),
        source.get("name"),
        source.get("title"),
        source.get("Source_Value"),
        source.get("media_content_type"),
        source.get("media_class"),
    )
    if not artwork:
        return source
    return {**source, "thumbnail": artwork}
