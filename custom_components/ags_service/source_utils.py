"""Helpers for AGS-managed media sources."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

CONF_SOURCE_FAVORITES = "source_favorites"
CONF_HIDDEN_SOURCE_IDS = "hidden_source_ids"
CONF_SOURCE_DISPLAY_NAMES = "source_display_names"
CONF_DEFAULT_SOURCE_ID = "default_source_id"
CONF_LAST_DISCOVERED_SOURCES = "last_discovered_sources"

LEGACY_FAVORITE_SOURCES = "favorite_sources"
LEGACY_SOURCES = "Sources"
LEGACY_EXCLUDED_SOURCES = "ExcludedSources"

SOURCE_ORIGIN_LEGACY_CONFIG = "legacy_config"
SOURCE_ORIGIN_MEDIA_BROWSER = "media_browser"


def _source_folder_parts(source: dict | None) -> list[str]:
    folder_path = source.get("folder_path") if isinstance(source, dict) else None
    if isinstance(folder_path, (list, tuple)):
        return [
            str(part).strip()
            for part in folder_path
            if str(part or "").strip()
        ]
    if str(folder_path or "").strip():
        return [str(folder_path).strip()]
    return []


def is_media_browser_favorite_source(source: dict | None) -> bool:
    """Return true for items discovered from the native Favorites subtree."""
    if not isinstance(source, dict):
        return False
    parts = _source_folder_parts(source)
    values = [
        *parts,
        source.get("Source"),
        source.get("Source_Value"),
        source.get("media_content_type"),
        source.get("media_class"),
        source.get("id"),
    ]
    return any("favorite" in str(value or "").casefold() for value in values)


def looks_like_global_media_source(source: dict | None) -> bool:
    """Return true for broad HA library rows that should not become AGS sources."""
    if not isinstance(source, dict):
        return False
    value = str(source.get("Source_Value") or "").strip()
    media_type = str(source.get("media_content_type") or "").strip()
    folder_parts = _source_folder_parts(source)
    if value.startswith("media-source://radio_browser"):
        return True
    if media_type == "app" and value.startswith("media-source://"):
        return True
    return bool(folder_parts and folder_parts[0].casefold() == "radio browser")


def filter_discovered_sources(sources: Any) -> list[dict]:
    """Keep only stable AGS source-discovery data, dropping broad library crawls."""
    discovered = normalize_source_list(sources)
    favorites = [source for source in discovered if is_media_browser_favorite_source(source)]
    if favorites:
        return favorites
    if len(discovered) > 40 and any(looks_like_global_media_source(source) for source in discovered):
        return []
    return discovered


def make_source_id(media_content_type: Any, source_value: Any) -> str:
    """Return the stable AGS id for a playable source."""
    source_type = str(media_content_type or "music").strip() or "music"
    value = str(source_value or "").strip()
    return f"{source_type}::{value}"


def make_browser_source_id(
    media_content_type: Any,
    source_value: Any,
    title: Any = "",
    folder_path: Any = None,
) -> str:
    """Return a stable id for Media Browser items, even with generic content ids."""
    source_type = str(media_content_type or "music").strip() or "music"
    value = str(source_value or "").strip()
    path_parts = []
    if isinstance(folder_path, (list, tuple)):
        path_parts = [
            str(part).strip().casefold()
            for part in folder_path
            if str(part or "").strip()
        ]
    elif str(folder_path or "").strip():
        path_parts = [str(folder_path).strip().casefold()]
    title_part = str(title or "").strip().casefold()
    key = "::".join([source_type.casefold(), value.casefold(), *path_parts, title_part])
    return f"browser::{key}"


def normalize_source_entry(source: dict | None) -> dict | None:
    """Normalize legacy and current AGS source shapes."""
    if not isinstance(source, dict):
        return None

    value = str(
        source.get("Source_Value")
        or source.get("value")
        or source.get("media_content_id")
        or ""
    ).strip()
    if not value:
        return None

    media_type = str(source.get("media_content_type") or "music").strip() or "music"
    source_id = str(source.get("id") or make_source_id(media_type, value)).strip()
    if not source_id:
        return None

    name = str(
        source.get("Source")
        or source.get("name")
        or source.get("title")
        or source.get("display_name")
        or value
    ).strip()
    if not name:
        return None

    normalized = {
        "id": source_id,
        "Source": name,
        "Source_Value": value,
        "media_content_type": media_type,
        "source_default": bool(source.get("source_default", False)),
    }
    origin = str(source.get("origin") or "").strip()
    if origin:
        normalized["origin"] = origin
    folder_path = source.get("folder_path")
    if isinstance(folder_path, (list, tuple)):
        normalized["folder_path"] = [
            str(part).strip()
            for part in folder_path
            if str(part or "").strip()
        ]
    elif str(folder_path or "").strip():
        normalized["folder_path"] = str(folder_path).strip()
    if source.get("priority") is not None:
        try:
            normalized["priority"] = int(source.get("priority"))
        except (TypeError, ValueError):
            pass
    if source.get("can_play") is not None:
        normalized["can_play"] = bool(source.get("can_play"))
    if source.get("can_expand") is not None:
        normalized["can_expand"] = bool(source.get("can_expand"))
    media_class = str(source.get("media_class") or "").strip()
    if media_class:
        normalized["media_class"] = media_class
    available_on = source.get("available_on")
    if isinstance(available_on, (list, tuple, set)):
        normalized["available_on"] = [
            str(entity_id).strip()
            for entity_id in available_on
            if str(entity_id or "").strip()
        ]
    elif str(available_on or "").strip():
        normalized["available_on"] = [str(available_on).strip()]
    return normalized


def merge_source_metadata(existing: dict, incoming: dict) -> dict:
    """Merge source metadata collected from multiple browser targets."""
    merged = deepcopy(existing)
    available = []
    for source in (existing, incoming):
        for entity_id in source.get("available_on") or []:
            if entity_id and entity_id not in available:
                available.append(entity_id)
    if available:
        merged["available_on"] = available
    for key in ("can_play", "can_expand", "media_class", "origin", "folder_path"):
        if key not in merged and incoming.get(key) is not None:
            merged[key] = deepcopy(incoming[key])
    return merged


def normalize_source_list(sources: Any) -> list[dict]:
    """Normalize and dedupe source entries while preserving order."""
    normalized_sources = []
    seen_ids = set()
    seen_names = {}
    id_indexes = {}
    for source in sources or []:
        normalized = normalize_source_entry(source)
        if not normalized:
            continue
        source_id = normalized["id"]
        name_key = normalized["Source"].casefold()
        existing_index = id_indexes.get(source_id)
        if existing_index is None:
            existing_index = seen_names.get(name_key)
        if existing_index is not None:
            normalized_sources[existing_index] = merge_source_metadata(
                normalized_sources[existing_index],
                normalized,
            )
            continue
        id_indexes[source_id] = len(normalized_sources)
        seen_ids.add(source_id)
        seen_names[name_key] = len(normalized_sources)
        normalized_sources.append(normalized)
    return normalized_sources


def source_matches_hidden(source: dict, hidden_ids: set[str]) -> bool:
    """Return true when a source is hidden by canonical id or legacy value."""
    source_id = str(source.get("id") or "").strip()
    value = str(source.get("Source_Value") or "").strip()
    return bool(source_id and source_id in hidden_ids) or bool(value and value in hidden_ids)


def is_legacy_config_source(source: dict | None) -> bool:
    """Return true for pre-browser source-list entries kept only as migration hints."""
    if not isinstance(source, dict):
        return False
    if source.get("origin") == SOURCE_ORIGIN_LEGACY_CONFIG:
        return True

    media_type = str(source.get("media_content_type") or "").strip().casefold()
    name = str(source.get("Source") or source.get("name") or "").strip()
    value = str(source.get("Source_Value") or source.get("value") or "").strip()
    source_id = str(source.get("id") or "").strip()
    return (
        media_type == "source"
        and bool(name)
        and name.casefold() == value.casefold()
        and source_id.startswith("source::")
    )


def apply_source_presentation(
    source: dict,
    display_names: dict[str, str] | None,
    default_source_id: str | None,
) -> dict:
    """Apply the user-facing name and default marker to a source."""
    presented = deepcopy(source)
    source_id = presented.get("id")
    display_name = (display_names or {}).get(source_id)
    if display_name:
        presented["Source"] = display_name
    presented["source_default"] = (
        bool(source_id == default_source_id or presented.get("source_default", False))
        if default_source_id
        else bool(presented.get("source_default", False))
    )
    return presented


def combine_source_inventory(
    ags_data: dict,
    *,
    include_hidden: bool = False,
) -> list[dict]:
    """Return visible generated music sources from AGS-managed favorites only."""
    display_names = ags_data.get(CONF_SOURCE_DISPLAY_NAMES, {}) or {}
    default_source_id = ags_data.get(CONF_DEFAULT_SOURCE_ID)
    hidden_ids = {str(item).strip() for item in ags_data.get(CONF_HIDDEN_SOURCE_IDS, []) or []}

    catalog = filter_discovered_sources(ags_data.get(CONF_LAST_DISCOVERED_SOURCES, []) or [])
    catalog_by_name = {source["Source"].casefold(): source for source in catalog}
    catalog_by_value = {
        str(source.get("Source_Value") or "").strip().casefold(): source
        for source in catalog
    }

    normalized_sources = []
    for source in normalize_source_list(ags_data.get(CONF_SOURCE_FAVORITES, []) or []):
        if is_legacy_config_source(source):
            matched = (
                catalog_by_name.get(source["Source"].casefold())
                or catalog_by_value.get(str(source.get("Source_Value") or "").strip().casefold())
            )
            if not matched:
                continue
            source = {**matched, "source_default": source.get("source_default", False)}
        normalized_sources.append(source)

    presented = []
    seen_ids = set()
    for source in normalized_sources:
        if not include_hidden and source_matches_hidden(source, hidden_ids):
            continue
        source_id = source.get("id")
        if source_id in seen_ids:
            continue
        seen_ids.add(source_id)
        presented.append(
            apply_source_presentation(source, display_names, default_source_id)
        )
    return presented


def split_source_inventory(ags_data: dict) -> tuple[list[dict], list[dict]]:
    """Return visible favorites and hidden catalog sources."""
    hidden_ids = {str(item).strip() for item in ags_data.get(CONF_HIDDEN_SOURCE_IDS, []) or []}
    display_names = ags_data.get(CONF_SOURCE_DISPLAY_NAMES, {}) or {}
    default_source_id = ags_data.get(CONF_DEFAULT_SOURCE_ID)

    visible = combine_source_inventory(ags_data, include_hidden=False)
    visible_all = combine_source_inventory(ags_data, include_hidden=True)
    visible_ids = {source.get("id") for source in visible_all}
    visible_values = {
        str(source.get("Source_Value") or "").strip()
        for source in visible_all
        if str(source.get("Source_Value") or "").strip()
    }

    hidden = []
    seen_ids = set()
    for source in filter_discovered_sources(ags_data.get(CONF_LAST_DISCOVERED_SOURCES, []) or []):
        source_id = source.get("id")
        value = str(source.get("Source_Value") or "").strip()
        if not source_id or source_id in seen_ids:
            continue
        if source_id in visible_ids or value in visible_values:
            continue
        seen_ids.add(source_id)
        hidden.append(apply_source_presentation(source, display_names, default_source_id))

    for source in visible_all:
        if source.get("id") in seen_ids:
            continue
        if source_matches_hidden(source, hidden_ids):
            seen_ids.add(source.get("id"))
            hidden.append(source)
    return visible, hidden


def find_source_by_name_or_id(ags_data: dict, value: str | None) -> dict | None:
    """Find a visible source by displayed name, canonical id, or media id."""
    target = str(value or "").strip()
    if not target:
        return None
    target_folded = target.casefold()
    for source in combine_source_inventory(ags_data):
        candidates = (
            source.get("Source"),
            source.get("id"),
            source.get("Source_Value"),
        )
        if any(str(candidate or "").strip().casefold() == target_folded for candidate in candidates):
            return source
    return None


def normalize_source_storage(cfg: dict) -> dict:
    """Migrate legacy source storage into the AGS-managed source model."""
    normalized = deepcopy(cfg or {})

    using_legacy_sources = normalized.get(CONF_SOURCE_FAVORITES) is None
    legacy_sources = normalized.get(CONF_SOURCE_FAVORITES)
    if legacy_sources is None:
        legacy_sources = normalized.get(LEGACY_FAVORITE_SOURCES)
    if legacy_sources is None:
        legacy_sources = normalized.get(LEGACY_SOURCES)

    source_favorites = normalize_source_list(
        normalized.get(CONF_SOURCE_FAVORITES)
        if normalized.get(CONF_SOURCE_FAVORITES) is not None
        else legacy_sources
    )
    last_discovered = filter_discovered_sources(normalized.get(CONF_LAST_DISCOVERED_SOURCES))

    source_favorites = [
        (
            {**source, "origin": SOURCE_ORIGIN_LEGACY_CONFIG}
            if using_legacy_sources or is_legacy_config_source(source)
            else source
        )
        for source in source_favorites
    ]

    hidden_ids = {
        str(item).strip()
        for item in normalized.get(CONF_HIDDEN_SOURCE_IDS, []) or []
        if str(item).strip()
    }
    legacy_excluded = [
        str(item).strip()
        for item in normalized.get(LEGACY_EXCLUDED_SOURCES, []) or []
        if str(item).strip()
    ]
    for item in legacy_excluded:
        hidden_ids.add(item)
        for source in source_favorites + last_discovered:
            if str(source.get("Source_Value") or "").strip() == item:
                hidden_ids.add(source["id"])

    display_names = {
        str(key).strip(): str(value).strip()
        for key, value in (normalized.get(CONF_SOURCE_DISPLAY_NAMES, {}) or {}).items()
        if str(key).strip() and str(value).strip()
    }

    default_source_id = str(normalized.get(CONF_DEFAULT_SOURCE_ID) or "").strip()
    if not default_source_id:
        for source in source_favorites + last_discovered:
            if source.get("source_default"):
                default_source_id = source["id"]
                break

    all_known_ids = {source["id"] for source in source_favorites + last_discovered}
    if default_source_id and default_source_id not in all_known_ids:
        default_source_id = ""

    normalized[CONF_SOURCE_FAVORITES] = source_favorites
    normalized[CONF_HIDDEN_SOURCE_IDS] = sorted(hidden_ids)
    normalized[CONF_SOURCE_DISPLAY_NAMES] = display_names
    normalized[CONF_DEFAULT_SOURCE_ID] = default_source_id or None
    normalized[CONF_LAST_DISCOVERED_SOURCES] = last_discovered

    # Legacy/public source keys are intentionally not part of the live model.
    normalized.pop(LEGACY_FAVORITE_SOURCES, None)
    normalized.pop(LEGACY_SOURCES, None)
    normalized.pop(LEGACY_EXCLUDED_SOURCES, None)
    normalized.pop("homekit_player", None)
    return normalized
