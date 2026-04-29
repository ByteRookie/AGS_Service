from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.components.media_player import (
    BrowseMedia,
    DATA_COMPONENT as MEDIA_PLAYER_DATA_COMPONENT,
    MediaPlayerEntity,
    MediaPlayerDeviceClass,
    MediaPlayerEntityFeature,
)
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED, STATE_IDLE
from homeassistant.helpers.event import async_call_later, async_track_state_change_event
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers import entity_registry as er

from . import DOMAIN, SIGNAL_AGS_RELOAD, _async_save_config_with_backup
from .ags_service import (
    update_ags_sensors,
    ags_select_source,
    enqueue_media_action,
    handle_ags_status_change,
    wait_for_actions,
    resolve_music_source_name,
    has_active_music_playback,
    TV_MODE_TV_AUDIO,
    TV_MODE_NO_MUSIC,
    TV_IGNORE_STATES,
    is_tv_mode_state,
)
from .source_utils import (
    CONF_DEFAULT_SOURCE_ID,
    CONF_HIDDEN_SOURCE_IDS,
    CONF_LAST_DISCOVERED_SOURCES,
    CONF_SOURCE_DISPLAY_NAMES,
    CONF_SOURCE_FAVORITES,
    SOURCE_ORIGIN_MEDIA_BROWSER,
    combine_source_inventory,
    find_source_by_name_or_id,
    is_legacy_config_source,
    make_browser_source_id,
    normalize_source_entry,
    normalize_source_list,
    split_source_inventory,
)
from .source_art import apply_default_source_art, source_artwork_url
import asyncio
import copy
import logging
_LOGGER = logging.getLogger(__name__)

STATE_REFRESH_DEBOUNCE = 0.15
BROWSE_CALL_TIMEOUT = 6
FAVORITES_CRAWL_DEPTH = 4
FAVORITES_CRAWL_LIMIT = 250

async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    """Set up the media player platform."""
    _LOGGER.info("AGS: Setting up media_player platform")
    # Create and add the AGS media player
    ags_media_player = AGSPrimarySpeakerMediaPlayer(hass, {})
    hass.data.setdefault(DOMAIN, {})["media_player_entity"] = ags_media_player
    async_add_entities([ags_media_player])

    # Ensure the media player is properly registered
    async def reload_handler(_):
        await ags_media_player.async_update()
        ags_media_player.async_write_ha_state()

    ags_media_player.async_on_remove(
        async_dispatcher_connect(hass, SIGNAL_AGS_RELOAD, reload_handler)
    )

    tracked_entities = set()
    unsubs = []

    def update_tracked_entities():
        nonlocal unsubs, tracked_entities

        # Unsubscribe old trackers
        for unsub in unsubs:
            unsub()
        unsubs = []
        tracked_entities = set(['zone.home'])

        cfg = hass.data[DOMAIN]
        rooms = cfg.get('rooms', [])

        schedule_cfg = cfg.get('schedule_entity')
        if schedule_cfg and schedule_cfg.get('entity_id'):
            tracked_entities.add(schedule_cfg['entity_id'])

        if cfg.get("create_sensors"):
            tracked_entities.add("switch.ags_actions")

        for room in rooms:
            safe_room_id = "".join(c for c in room.get('room', '').lower().replace(' ', '_') if c.isalnum() or c == '_')
            if safe_room_id:
                tracked_entities.add(f"switch.{safe_room_id}_media")
            for device in room.get("devices", []):
                tracked_entities.add(device["device_id"])

        # Create new trackers
        if tracked_entities:
            unsubs.append(async_track_state_change_event(
                hass, list(tracked_entities), ags_media_player.async_primary_speaker_changed
            ))

    # Initial tracking
    update_tracked_entities()

    # Listen for hot reload to update tracking
    ags_media_player.async_on_remove(
        async_dispatcher_connect(hass, SIGNAL_AGS_RELOAD, update_tracked_entities)
    )

    def remove_tracked_entities():
        for unsub in unsubs:
            unsub()

    ags_media_player.async_on_remove(remove_tracked_entities)


async def async_setup_entry(hass, entry, async_add_entities):
    """Set up the media player platform from a config entry."""
    await async_setup_platform(hass, {}, async_add_entities)

class AGSPrimarySpeakerMediaPlayer(MediaPlayerEntity, RestoreEntity):
    _attr_device_class = MediaPlayerDeviceClass.TV

    async def async_added_to_hass(self):
        """When entity is added to hass."""
        await super().async_added_to_hass()
        _LOGGER.info("AGS: Media player added to Home Assistant")
        restored_source = None
        last_state = await self.async_get_last_state()
        if last_state:
            restored_source = last_state.attributes.get("selected_source_name")
            if restored_source in (None, "", "TV", "Unknown"):
                restored_source = last_state.attributes.get("source")
            if restored_source not in (None, "", "TV", "Unknown"):
                self.hass.data["ags_media_player_source"] = restored_source
        self._refresh_from_data()
        if self.entity_id:
            self.async_write_ha_state()

        async def _after_ha_started(_event=None):
            await self._async_after_homeassistant_started()

        if getattr(self.hass, "is_running", False):
            self.hass.async_create_task(_after_ha_started())
        else:
            self.async_on_remove(
                self.hass.bus.async_listen_once(
                    EVENT_HOMEASSISTANT_STARTED,
                    _after_ha_started,
                )
            )

    @property
    def ags_config(self):
        """Always return the latest config from hass.data."""
        return self.hass.data.get(DOMAIN, {})

    def __init__(self, hass, _unused_config):
        """Initialize the media player."""
        self.hass = hass
        self._hass = hass
        self._attr_name = "Whole Home Audio"
        self.entity_id = "media_player.ags_media_player"
        self._state = STATE_IDLE
        self.primary_speaker_entity_id = None
        self.primary_speaker_state = None   # Initialize the attribute
        self.configured_rooms = None
        self.active_rooms = None
        self.active_speakers = None
        self.inactive_speakers = None
        self.ags_status = None
        self.primary_speaker = None
        self.preferred_primary_speaker = None
        self.browsing_fallback_speaker = None
        self.ags_source = None
        self.ags_inactive_tv_speakers = None
        self.primary_speaker_room = None
        self._pending_refresh_unsub = None
        self._favorite_refresh_retry_unsub = None
        self._source_inventory_refresh_unsub = None
        self._source_inventory_enabled = False
        self._last_source_mode = None
        self._last_browse_target = None

    async def _async_after_homeassistant_started(self):
        """Start non-critical AGS refresh work after HA has completed startup."""
        self._source_inventory_enabled = True
        try:
            await update_ags_sensors(self.ags_config, self.hass)
            self._refresh_from_data()
            if self.entity_id:
                self.async_schedule_update_ha_state(True)
        except Exception as err:
            _LOGGER.debug("AGS post-start sensor refresh failed: %s", err)
        self._schedule_source_inventory_refresh(delay=5, force=True)

    async def async_will_remove_from_hass(self):
        """Cancel scheduled refresh callbacks."""
        if self._pending_refresh_unsub:
            self._pending_refresh_unsub()
            self._pending_refresh_unsub = None
        if self._favorite_refresh_retry_unsub:
            self._favorite_refresh_retry_unsub()
            self._favorite_refresh_retry_unsub = None
        if self._source_inventory_refresh_unsub:
            self._source_inventory_refresh_unsub()
            self._source_inventory_refresh_unsub = None
        await super().async_will_remove_from_hass()

    def _schedule_media_call(self, service: str, data: dict) -> None:
        """Safely fire a media_player service from any thread."""
        self.hass.loop.call_soon_threadsafe(
            lambda: self.hass.async_create_task(
                self.hass.services.async_call("media_player", service, data)
            )
        )

    def _schedule_ags_update(self) -> None:
        """Refresh AGS sensor data without waiting for polling."""
        async def _update() -> None:
            await update_ags_sensors(self.ags_config, self.hass)
            self._refresh_from_data()
            if self.entity_id:
                self.async_schedule_update_ha_state(True)

        self.hass.loop.call_soon_threadsafe(
            lambda: self.hass.async_create_task(_update())
        )





    async def async_update(self):
        """Fetch latest state."""
        # Use existing data from hass.data instead of triggering a full sensor update
        # which can lead to circular dependencies.
        self._refresh_from_data()

    def _refresh_from_data(self) -> None:
        """Update cached attributes from ``hass.data`` after sensors refresh."""
        self.configured_rooms = self.hass.data.get('configured_rooms', None)
        self.active_rooms = self.hass.data.get('active_rooms', None)
        self.active_speakers = self.hass.data.get('active_speakers', None)
        self.inactive_speakers = self.hass.data.get('inactive_speakers', None)
        self.primary_speaker = self.hass.data.get('primary_speaker', "")
        self.primary_speaker_entity_id = self.primary_speaker if self.primary_speaker and self.primary_speaker != "none" else None
        self.preferred_primary_speaker = self.hass.data.get('preferred_primary_speaker', None)
        self.browsing_fallback_speaker = self.hass.data.get('browsing_fallback_speaker', None)
        self.primary_speaker_room = None
        self.primary_speaker_state = None

        selected_source = resolve_music_source_name(self.ags_config, self.hass)
        if selected_source is not None:
            self.hass.data['ags_media_player_source'] = selected_source
        self.ags_source = self.get_source_value_by_name(selected_source)
        self.ags_inactive_tv_speakers = self.hass.data.get('ags_inactive_tv_speakers', None)
        self.ags_status = self.hass.data.get('ags_status', 'OFF')

        found_room_obj = None
        rooms = self.ags_config.get('rooms', [])
        for room in rooms:
            for device in room.get("devices", []):
                if device.get("device_id") == self.hass.data.get('primary_speaker'):
                    self.primary_speaker_room = room.get("room") or room.get("name") or "Unknown"
                    found_room_obj = room
                    break
            if found_room_obj:
                break

        tv_mode = self.hass.data.get("current_tv_mode", TV_MODE_TV_AUDIO)

        if (
            self.ags_status == "ON TV"
            and tv_mode != TV_MODE_NO_MUSIC
            and self.primary_speaker_room
            and found_room_obj
        ):
            selected_device_id = None

            sorted_devices = sorted(
                [device for device in found_room_obj.get("devices", []) if device.get("device_type") == "tv"],
                key=lambda x: x.get('priority', 999)
            )

            if sorted_devices:
                tv_device = sorted_devices[0]

                # Find OTT devices linked to this TV
                ott_devices = sorted(
                    [d for d in found_room_obj.get("devices", []) if d.get('device_type') == 'ott' and d.get('parent_tv') == tv_device['device_id']],
                    key=lambda x: x.get('priority', 999)
                )

                if ott_devices:
                    # 1. Active Promotion: If any OTT device is playing, it takes priority
                    found_ott = None
                    for ott in ott_devices:
                        ott_state = self.hass.states.get(ott.get('device_id'))
                        if ott_state and ott_state.state == "playing":
                            found_ott = ott['device_id']
                            break

                    if not found_ott:
                        # 2. Source Matching: If TV's source matches an OTT's TV Input Name
                        tv_state = self.hass.states.get(tv_device['device_id'])
                        current_input = tv_state.attributes.get('source') if tv_state else None
                        if current_input:
                            for ott in ott_devices:
                                if str(ott.get('tv_input')).strip().lower() == str(current_input).strip().lower():
                                    found_ott = ott['device_id']
                                    break

                    # 3. Ranked Fallback: Pick the highest ranked (lowest priority number) OTT device
                    selected_device_id = found_ott if found_ott else ott_devices[0]['device_id']
                else:
                    selected_device_id = tv_device["device_id"]
            else:
                selected_device_id = self.hass.data.get('primary_speaker', None)

            self.primary_speaker_entity_id = selected_device_id
        else:
            self.primary_speaker_entity_id = self.hass.data.get('primary_speaker', None)

        if self.primary_speaker_entity_id:
            self.primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id)
        self._handle_source_mode_refresh()

    def _get_source_mode(self):
        if (
            self.ags_status == "ON TV"
            and not self.hass.data.get(DOMAIN, {}).get("disable_tv_source", False)
        ):
            return "tv"
        return "music"

    def _handle_source_mode_refresh(self):
        """Force HA state/source-list refresh when music and TV modes switch."""
        mode = self._get_source_mode()
        browse_target = self._get_browse_target_entity_id()
        mode_changed = self._last_source_mode != mode
        target_changed = self._last_browse_target != browse_target
        if not mode_changed and not target_changed:
            return
        self._last_source_mode = mode
        self._last_browse_target = browse_target
        ags_data = self.hass.data.setdefault(DOMAIN, {})
        ags_data["source_list_revision"] = int(ags_data.get("source_list_revision", 0) or 0) + 1
        if mode == "music" and self._source_inventory_enabled:
            self._schedule_source_inventory_refresh(delay=1, force=True)
        self.async_schedule_update_ha_state(True)

    def _get_reference_player_state(self):
        """Return the best state object for metadata and command fallbacks."""
        if self.primary_speaker_state is not None:
            return self.primary_speaker_state
        target_entity_id = self._get_command_target_entity_id()
        return self.hass.states.get(target_entity_id) if target_entity_id else None

    def _get_command_target_entity_id(self):
        """Return the entity that should receive direct transport commands."""
        if self.primary_speaker_entity_id and self.hass.states.get(self.primary_speaker_entity_id):
            return self.primary_speaker_entity_id
        return self._get_browse_target_entity_id()

    def _dedupe_entity_ids(self, candidates):
        """Return usable entity ids in order while preserving fallbacks."""
        seen = set()
        entity_ids = []
        for entity_id in candidates:
            normalized = str(entity_id or "").strip()
            if (
                not normalized
                or normalized == "none"
                or normalized == self.entity_id
                or normalized in seen
            ):
                continue
            seen.add(normalized)
            entity_ids.append(normalized)
        return entity_ids

    def _get_browse_target_candidates(self, *, include_fallback: bool = True):
        """Return physical media players that should handle media browsing."""
        candidates = [
            self.primary_speaker,
            self.preferred_primary_speaker,
        ]
        if include_fallback:
            candidates.append(self.browsing_fallback_speaker)
            candidates.extend(self._get_configured_speaker_entity_ids())
        return self._dedupe_entity_ids(candidates)

    def _get_configured_speaker_entity_ids(self):
        """Return all configured speakers in priority order."""
        speakers = []
        for room in self.ags_config.get("rooms", []) or []:
            for device in room.get("devices", []) or []:
                if device.get("device_type") == "speaker" and device.get("device_id"):
                    speakers.append(device)
        speakers.sort(key=lambda item: item.get("priority", 999))
        return [speaker.get("device_id") for speaker in speakers]

    def _get_top_configured_speaker_entity_id(self):
        """Return the highest-priority configured speaker even when AGS is idle."""
        speakers = self._get_configured_speaker_entity_ids()
        if not speakers:
            return None
        for entity_id in speakers:
            state = self.hass.states.get(entity_id)
            if state is not None and state.state != "unavailable":
                return entity_id
        return speakers[0]

    def _get_browse_target_entity_id(self, *, include_fallback: bool = True):
        """Return the best speaker target for browse/play_media requests."""
        for entity_id in self._get_browse_target_candidates(
            include_fallback=include_fallback
        ):
            state = self.hass.states.get(entity_id)
            if state is not None and state.state != "unavailable":
                return entity_id
        return None

    def _extract_browse_service_response(self, response, entity_id):
        """Unwrap HA service response data for one browse target."""
        if isinstance(response, dict):
            if entity_id in response:
                return response[entity_id]
            if len(response) == 1:
                return next(iter(response.values()))
        return response

    def _browse_attr(self, node, name, default=None):
        """Read browse nodes returned as dicts or BrowseMedia objects."""
        if isinstance(node, dict):
            return node.get(name, default)
        return getattr(node, name, default)

    def _browse_children(self, node):
        children = self._browse_attr(node, "children", []) or []
        return list(children) if isinstance(children, (list, tuple)) else []

    def _browse_result_has_real_content(self, node):
        if node is None:
            return False
        children = self._browse_children(node)
        if not children:
            return not self._is_empty_browse_placeholder(node)
        return any(not self._is_empty_browse_placeholder(child) for child in children)

    def _is_empty_browse_placeholder(self, node):
        """Return true for synthetic empty browse rows such as "No items"."""
        title = str(
            self._browse_attr(node, "title")
            or self._browse_attr(node, "name")
            or ""
        ).strip().casefold()
        content_id = str(self._browse_attr(node, "media_content_id") or "").strip().casefold()
        media_class = str(self._browse_attr(node, "media_class") or "").strip().casefold()
        return (
            title in {"no item", "no items", "nothing found", "empty"}
            or content_id in {"no item", "no items", "nothing found", "empty"}
            or media_class == "empty"
        )

    def _normalize_favorite_source(self, node, folder_path=None, *, entity_id=None, include_folders=False):
        if self._is_empty_browse_placeholder(node):
            return None

        children = self._browse_children(node)
        can_expand = bool(self._browse_attr(node, "can_expand", False) or children)
        title = str(
            self._browse_attr(node, "title")
            or self._browse_attr(node, "name")
            or self._browse_attr(node, "media_content_id")
            or ""
        ).strip()
        content_id = str(self._browse_attr(node, "media_content_id") or "").strip()
        content_type = str(self._browse_attr(node, "media_content_type") or "music").strip()
        can_play = bool(self._browse_attr(node, "can_play", False) or (not can_expand and content_id))
        if not title or not content_id:
            return None
        if not can_play and not (include_folders and can_expand):
            return None
        source_id = make_browser_source_id(
            content_type,
            content_id,
            title,
            folder_path or [],
        )
        source = normalize_source_entry({
            "id": source_id,
            "Source": title,
            "Source_Value": content_id,
            "media_content_type": content_type,
            "source_default": False,
            "origin": SOURCE_ORIGIN_MEDIA_BROWSER,
            "folder_path": folder_path or [],
            "can_play": can_play,
            "can_expand": can_expand,
            "media_class": self._browse_attr(node, "media_class", "") or ("folder" if can_expand else "music"),
            "thumbnail": self._browse_attr(node, "thumbnail", ""),
            "available_on": [entity_id] if entity_id else [],
        })
        if source:
            source["origin"] = SOURCE_ORIGIN_MEDIA_BROWSER
            source["folder_path"] = folder_path or []
        return apply_default_source_art(source)

    def _browse_title(self, node):
        """Return a readable title for a media-browser node."""
        return str(
            self._browse_attr(node, "title")
            or self._browse_attr(node, "name")
            or self._browse_attr(node, "media_content_id")
            or ""
        ).strip()

    def _apply_default_browse_art(self, node):
        """Apply bundled artwork to browse nodes that do not provide images."""
        if node is None:
            return None

        children = [
            self._apply_default_browse_art(child)
            for child in self._browse_children(node)
        ]
        artwork = None
        if not self._browse_attr(node, "thumbnail", ""):
            artwork = source_artwork_url(
                self._browse_title(node),
                self._browse_attr(node, "media_content_id", ""),
                self._browse_attr(node, "media_content_type", ""),
                self._browse_attr(node, "media_class", ""),
            )

        if isinstance(node, dict):
            updated = {**node}
            if children:
                updated["children"] = children
            if artwork:
                updated["thumbnail"] = artwork
            return updated

        if children:
            try:
                node.children = children
            except Exception:
                pass
        if artwork:
            try:
                node.thumbnail = artwork
            except Exception:
                pass
        return node

    def _normalize_native_source(self, source):
        source_name = str(source or "").strip()
        if source_name in ("", "TV", "Unknown"):
            return None
        return apply_default_source_art(normalize_source_entry({
            "Source": source_name,
            "Source_Value": source_name,
            "media_content_type": "source",
            "source_default": False,
        }))

    def _get_native_source_list_sources(self, entity_id):
        state = self.hass.states.get(entity_id)
        source_list = state.attributes.get("source_list") if state else None
        if not isinstance(source_list, (list, tuple)):
            return []
        return [
            source
            for source in (
                self._normalize_native_source(source_name)
                for source_name in source_list
            )
            if source
        ]

    async def _async_browse_on_entity(self, entity_id, media_content_type=None, media_content_id=None):
        try:
            result = await asyncio.wait_for(
                self._async_browse_media_direct(
                    entity_id,
                    media_content_type,
                    media_content_id,
                ),
                timeout=BROWSE_CALL_TIMEOUT,
            )
            if result is not None:
                return result
        except Exception:
            pass
        return await asyncio.wait_for(
            self._async_browse_media_via_service(
                entity_id,
                media_content_type,
                media_content_id,
            ),
            timeout=BROWSE_CALL_TIMEOUT,
        )

    async def _async_browse_candidate(self, entity_id, media_content_type=None, media_content_id=None):
        try:
            result = await asyncio.wait_for(
                self._async_browse_media_direct(
                    entity_id,
                    media_content_type,
                    media_content_id,
                ),
                timeout=BROWSE_CALL_TIMEOUT,
            )
            if result is not None:
                return result
        except Exception as err:
            _LOGGER.debug(
                "Falling back to service browse_media for %s: %s",
                entity_id,
                err,
            )
        return await asyncio.wait_for(
            self._async_browse_media_via_service(
                entity_id,
                media_content_type,
                media_content_id,
            ),
            timeout=BROWSE_CALL_TIMEOUT,
        )

    async def _async_crawl_favorite_sources(
        self,
        entity_id,
        node,
        results,
        seen,
        *,
        max_depth=4,
        max_items=500,
        depth=0,
        seen_nodes=None,
        folder_path=None,
        include_folders=False,
    ):
        if depth > max_depth or len(results) >= max_items:
            return
        if seen_nodes is None:
            seen_nodes = set()
        folder_path = list(folder_path or [])

        for child in self._browse_children(node):
            if len(results) >= max_items:
                return
            favorite = self._normalize_favorite_source(
                child,
                folder_path,
                entity_id=entity_id,
                include_folders=include_folders,
            )
            if favorite:
                key = favorite["id"]
                if key not in seen:
                    seen.add(key)
                    results.append(favorite)

            if self._browse_attr(child, "can_expand", False):
                content_type = self._browse_attr(child, "media_content_type")
                content_id = self._browse_attr(child, "media_content_id")
                child_path = folder_path + ([self._browse_title(child)] if self._browse_title(child) else [])

                # If the folder already has children loaded, crawl them first
                child_children = self._browse_children(child)
                if child_children:
                    await self._async_crawl_favorite_sources(
                        entity_id,
                        child,
                        results,
                        seen,
                        max_depth=max_depth,
                        max_items=max_items,
                        depth=depth + 1,
                        seen_nodes=seen_nodes,
                        folder_path=child_path,
                        include_folders=include_folders,
                    )

                if not content_id:
                    continue

                node_key = (str(content_type or ""), str(content_id or ""))
                if node_key in seen_nodes:
                    continue
                seen_nodes.add(node_key)
                try:
                    expanded = await self._async_browse_on_entity(
                        entity_id,
                        content_type,
                        content_id,
                    )
                    if expanded is not None:
                        await self._async_crawl_favorite_sources(
                            entity_id,
                            expanded,
                            results,
                            seen,
                            max_depth=max_depth,
                            max_items=max_items,
                            depth=depth + 1,
                            seen_nodes=seen_nodes,
                            folder_path=child_path,
                            include_folders=include_folders,
                        )
                except Exception as err:
                    _LOGGER.debug("Unable to crawl favorite folder %s: %s", content_id, err)

    def _find_favorites_node(self, root):
        """Find the native media-browser Favorites folder when present."""
        return next(
            (
                child
                for child in self._browse_children(root)
                if self._browse_node_looks_like_favorites(child)
            ),
            None,
        )

    def _browse_node_looks_like_favorites(self, node):
        """Return true when a browse node appears to be the user's favorites."""
        values = (
            self._browse_attr(node, "media_class", ""),
            self._browse_attr(node, "title", ""),
            self._browse_attr(node, "name", ""),
            self._browse_attr(node, "media_content_id", ""),
        )
        return any(
            any(keyword in str(value or "").casefold() for keyword in ("favorite", "fv:", "preserving"))
            for value in values
        )

    async def _expand_browse_node(self, entity_id, node):
        """Return an expanded browse node when the current node has a browse target."""
        if node is None:
            return None
        content_id = self._browse_attr(node, "media_content_id", None)
        if not content_id:
            return node
        return await self._async_browse_on_entity(
            entity_id,
            self._browse_attr(node, "media_content_type"),
            content_id,
        )

    async def _async_find_favorites_browse_root(
        self,
        entity_id,
        node,
        *,
        max_depth=3,
        depth=0,
        seen_nodes=None,
    ):
        """Find and expand a Favorites folder anywhere near the browser root."""
        if node is None or depth > max_depth:
            return None
        if seen_nodes is None:
            seen_nodes = set()

        if self._browse_node_looks_like_favorites(node):
            expanded = await self._expand_browse_node(entity_id, node)
            return expanded if self._browse_result_has_real_content(expanded) else node

        for child in self._browse_children(node):
            if self._browse_node_looks_like_favorites(child):
                expanded = await self._expand_browse_node(entity_id, child)
                return expanded if self._browse_result_has_real_content(expanded) else child
            child_children = self._browse_children(child)
            if not self._browse_attr(child, "can_expand", False) and not child_children:
                continue
            child_type = self._browse_attr(child, "media_content_type")
            child_id = self._browse_attr(child, "media_content_id")
            node_key = (str(child_type or ""), str(child_id or ""))
            if node_key in seen_nodes:
                continue
            seen_nodes.add(node_key)
            try:
                child_root = child if child_children else await self._expand_browse_node(entity_id, child)
                found = await self._async_find_favorites_browse_root(
                    entity_id,
                    child_root,
                    max_depth=max_depth,
                    depth=depth + 1,
                    seen_nodes=seen_nodes,
                )
                if found is not None:
                    return found
            except Exception as err:
                _LOGGER.debug("Unable to inspect favorites candidate %s: %s", child_id, err)
        return None

    def _match_catalog_source(self, catalog, source):
        """Return the browser-backed catalog item that best matches a legacy source."""
        if not source:
            return None
        name = str(source.get("Source") or "").strip().casefold()
        value = str(source.get("Source_Value") or "").strip().casefold()
        source_id = str(source.get("id") or "").strip()
        for candidate in catalog:
            candidate_values = {
                str(candidate.get("id") or "").strip(),
                str(candidate.get("Source") or "").strip().casefold(),
                str(candidate.get("Source_Value") or "").strip().casefold(),
            }
            if source_id in candidate_values or name in candidate_values or value in candidate_values:
                return candidate
        return None

    def _merge_browser_favorites(self, ags_data, catalog, native_favorites):
        """Build the visible AGS favorites list from AGS favorites or native Favorites."""
        hidden_ids = {
            str(item).strip()
            for item in ags_data.get(CONF_HIDDEN_SOURCE_IDS, []) or []
            if str(item).strip()
        }
        catalog = normalize_source_list(catalog or [])
        native_favorites = normalize_source_list(native_favorites or [])
        browser_catalog = normalize_source_list([*native_favorites, *catalog])

        existing = normalize_source_list(ags_data.get(CONF_SOURCE_FAVORITES, []) or [])

        merged = []
        seen_ids = set()
        seen_names = set()
        legacy_default_id = str(ags_data.get(CONF_DEFAULT_SOURCE_ID) or "").strip()
        matched_default_id = None

        def add_source(source, *, default=False):
            nonlocal matched_default_id
            normalized = normalize_source_entry(source)
            if not normalized:
                return
            source_id = normalized["id"]
            name_key = normalized["Source"].casefold()
            value = str(normalized.get("Source_Value") or "").strip()

            if source_id in hidden_ids or value in hidden_ids:
                return

            if source_id in seen_ids or name_key in seen_names:
                return

            seen_ids.add(source_id)
            seen_names.add(name_key)
            next_source = {**normalized, "source_default": bool(default)}
            merged.append(next_source)
            if default:
                matched_default_id = source_id

        # Keep user-managed favorites when they still map to a browser item.
        # Legacy config-only source rows are migration hints; they are never
        # exposed unless a real Media Browser item matches them.
        for source in existing:
            matched = self._match_catalog_source(browser_catalog, source)
            if matched:
                add_source(
                    {
                        **matched,
                        "source_default": bool(
                            source.get("source_default")
                            or legacy_default_id in {
                                str(source.get("id") or "").strip(),
                                str(matched.get("id") or "").strip(),
                            }
                        ),
                    },
                    default=bool(
                        source.get("source_default")
                        or legacy_default_id in {
                            str(source.get("id") or "").strip(),
                            str(matched.get("id") or "").strip(),
                        }
                    ),
                )
            elif source.get("origin") == "user_favorite" and not is_legacy_config_source(source):
                add_source(source, default=source.get("source_default", False))

        # First successful discovery defaults AGS favorites to the native Media
        # Browser Favorites folder. The broader catalog only feeds Hidden
        # Sources so random top-level browse items do not become HA inputs.
        if not merged:
            for source in native_favorites:
                add_source(source)

        default_id = matched_default_id or str(ags_data.get(CONF_DEFAULT_SOURCE_ID) or "").strip()
        if default_id and default_id not in seen_ids:
            default_id = None
        if not default_id:
            default_marked = next((s for s in merged if s.get("source_default")), None)
            default_id = default_marked["id"] if default_marked else (merged[0]["id"] if merged else None)

        for source in merged:
            source["source_default"] = bool(default_id and source["id"] == default_id)

        _LOGGER.info("AGS: Merged sources result: %s items", len(merged))
        return merged, default_id

    def _append_discovered_sources(self, sources, results, seen):
        for source in sources:
            normalized = normalize_source_entry(source)
            if not normalized:
                continue
            key = normalized["id"]
            name_key = normalized["Source"].casefold()
            if key in seen or name_key in seen:
                continue
            seen.add(key)
            seen.add(name_key)
            results.append(normalized)

    def _source_to_browse_item(self, source):
        source = apply_default_source_art(source) or source
        name = str(source.get("Source") or "").strip()
        value = str(source.get("Source_Value") or "").strip()
        if not name or not value:
            return None
        content_type = str(source.get("media_content_type") or "music").strip()
        return BrowseMedia(
            title=name,
            media_class="music",
            media_content_id=value,
            media_content_type=content_type,
            can_play=True,
            can_expand=False,
            thumbnail=source.get("thumbnail"),
        )

    def _build_configured_sources_browse_root(self):
        ags_data = self.hass.data.get(DOMAIN, {})
        sources = [
            source
            for source in combine_source_inventory(ags_data)
            if source.get("Source") not in (None, "", "Unknown")
        ]

        children = [
            item
            for item in (self._source_to_browse_item(source) for source in sources)
            if item
        ]
        if not children:
            return None
        return BrowseMedia(
            title="AGS Sources",
            media_class="directory",
            media_content_id="ags_sources",
            media_content_type="library",
            can_play=False,
            can_expand=True,
            children=children,
        )

    async def _async_refresh_source_inventory(self, *, force: bool = False):
        """Populate generated music sources from the selected speaker media browser."""
        ags_data = self.hass.data.get(DOMAIN, {})
        if ags_data.get("_source_inventory_refreshing"):
            return

        ags_data["_source_inventory_refreshing"] = True
        try:
            all_native_favorites = []
            candidates = self._get_browse_target_candidates()
            _LOGGER.info("AGS source discovery starting with candidates: %s", candidates)

            for entity_id in candidates:
                try:
                    state = self.hass.states.get(entity_id)
                    if not state or state.state == "unavailable":
                        continue

                    root = await self._async_browse_on_entity(entity_id)
                    if not self._browse_result_has_real_content(root):
                        continue

                    # 1. Search for native Favorites folder
                    favorite_results = []
                    browse_root = await self._async_find_favorites_browse_root(entity_id, root)
                    if browse_root is not None and self._browse_result_has_real_content(browse_root):
                        await self._async_crawl_favorite_sources(
                            entity_id,
                            browse_root,
                            favorite_results,
                            set(),
                            max_depth=FAVORITES_CRAWL_DEPTH,
                            max_items=FAVORITES_CRAWL_LIMIT,
                            folder_path=["Favorites"],
                            include_folders=True,
                        )

                    if favorite_results:
                        normalized_favs = normalize_source_list(favorite_results)
                        all_native_favorites.extend(normalized_favs)
                        _LOGGER.info("AGS: Found %s favorites on %s", len(normalized_favs), entity_id)

                except Exception as err:
                    _LOGGER.debug("Discovery error on %s: %s", entity_id, err)

            native_favorites = normalize_source_list(all_native_favorites)
            discovered = normalize_source_list(native_favorites)

            _LOGGER.info("AGS: Discovery cycle found %s Media Browser favorite source(s)", len(native_favorites))

            if not native_favorites:
                _LOGGER.debug("AGS: No Media Browser Favorites folder sources found in this refresh cycle")
                self._schedule_favorite_source_retry()
                return

            # Merge with existing data
            next_favorites, next_default_id = self._merge_browser_favorites(
                ags_data,
                discovered,
                native_favorites,
            )

            existing_discovered = normalize_source_list(ags_data.get(CONF_LAST_DISCOVERED_SOURCES, []) or [])
            existing_favorites = normalize_source_list(ags_data.get(CONF_SOURCE_FAVORITES, []) or [])

            if (not force and
                discovered == existing_discovered and
                next_favorites == existing_favorites and
                next_default_id == ags_data.get(CONF_DEFAULT_SOURCE_ID)):
                return

            # Safely build the new config for persistence
            stored_cache = ags_data.get("_stored_config_cache")
            if isinstance(stored_cache, dict) and stored_cache.get("rooms"):
                active_config = copy.deepcopy(stored_cache)
            else:
                # Fallback to reconstructing from live data
                safe_keys = ("rooms", CONF_HIDDEN_SOURCE_IDS, CONF_SOURCE_DISPLAY_NAMES,
                           "off_override", "create_sensors", "default_on", "static_name",
                           "disable_tv_source", "interval_sync", "schedule_entity",
                           "default_source_schedule", "batch_unjoin", "native_room_popup")
                active_config = {k: copy.deepcopy(ags_data[k]) for k in safe_keys if k in ags_data}

            active_config.update({
                CONF_LAST_DISCOVERED_SOURCES: discovered,
                CONF_SOURCE_FAVORITES: next_favorites,
                CONF_DEFAULT_SOURCE_ID: next_default_id,
            })
            valid_hidden_ids = {
                str(source.get("id") or "").strip()
                for source in [*discovered, *next_favorites]
                if str(source.get("id") or "").strip()
            }
            valid_hidden_values = {
                str(source.get("Source_Value") or "").strip()
                for source in [*discovered, *next_favorites]
                if str(source.get("Source_Value") or "").strip()
            }
            active_config[CONF_HIDDEN_SOURCE_IDS] = [
                hidden_id
                for hidden_id in active_config.get(CONF_HIDDEN_SOURCE_IDS, []) or []
                if hidden_id in valid_hidden_ids or hidden_id in valid_hidden_values
            ]

            # Cleanup internal keys
            for key in ("Sources", "favorite_sources", "ExcludedSources", "homekit_player", "media_player_entity"):
                active_config.pop(key, None)

            apply_config = ags_data.get("apply_config")
            if apply_config:
                apply_config(active_config)

            ags_data["_stored_config_cache"] = copy.deepcopy(active_config)
            ags_data["source_list_revision"] = int(ags_data.get("source_list_revision", 0)) + 1

            await _async_save_config_with_backup(self.hass, active_config, store=ags_data.get("store"))
            if self.entity_id:
                self.async_schedule_update_ha_state(True)

        finally:
            ags_data.pop("_source_inventory_refreshing", None)

    def _schedule_source_inventory_refresh(self, *, delay: int = 1, force: bool = False):
        """Schedule source discovery without blocking HA startup."""
        if self._source_inventory_refresh_unsub:
            self._source_inventory_refresh_unsub()
            self._source_inventory_refresh_unsub = None

        async def _refresh(_now):
            self._source_inventory_refresh_unsub = None
            try:
                await self._async_refresh_source_inventory(force=force)
            except Exception as err:
                _LOGGER.debug("Scheduled AGS source inventory refresh failed: %s", err)

        self._source_inventory_refresh_unsub = async_call_later(
            self.hass,
            delay,
            _refresh,
        )

    def _schedule_favorite_source_retry(self):
        """Retry native favorite import after HA media entities finish startup."""
        if self._favorite_refresh_retry_unsub:
            return

        async def _retry(_now):
            self._favorite_refresh_retry_unsub = None
            await self._async_refresh_source_inventory()

        self._favorite_refresh_retry_unsub = async_call_later(
            self.hass,
            30,
            _retry,
        )

    async def _async_browse_media_via_service(
        self,
        entity_id,
        media_content_type,
        media_content_id,
    ):
        """Browse a real media_player through Home Assistant's service layer."""
        payload = {"entity_id": entity_id}
        if media_content_type is not None:
            payload["media_content_type"] = media_content_type
        if media_content_id is not None:
            payload["media_content_id"] = media_content_id

        response = await self.hass.services.async_call(
            "media_player",
            "browse_media",
            payload,
            blocking=True,
            return_response=True,
        )
        return self._extract_browse_service_response(response, entity_id)

    async def _async_browse_media_direct(
        self,
        entity_id,
        media_content_type,
        media_content_id,
    ):
        """Compatibility fallback for HA versions without service responses."""
        component = self.hass.data.get(MEDIA_PLAYER_DATA_COMPONENT)
        if component is None:
            component = self.hass.data.get("entity_components", {}).get("media_player")
        if not component:
            return None
        target_entity = component.get_entity(entity_id)
        if not target_entity or not hasattr(target_entity, "async_browse_media"):
            return None
        return await target_entity.async_browse_media(
            media_content_type,
            media_content_id,
        )

    def _derive_app_name_from_id(self, app_id):
        """Turn raw app IDs into a readable fallback label."""
        raw = str(app_id or "").strip()
        if not raw:
            return None
        tail = raw.split(".")[-1].replace("_", " ").replace("-", " ").strip()
        if not tail:
            return None
        return " ".join(part.capitalize() for part in tail.split())

    def _get_state_source_label(self, state):
        """Return the most useful active source/app label for a player state."""
        if state is None:
            return None

        attrs = state.attributes
        source = attrs.get("source")
        app_name = attrs.get("app_name")
        media_channel = attrs.get("media_channel")
        app_id = attrs.get("app_id")
        media_content_type = attrs.get("media_content_type")

        if app_name:
            return app_name
        if source:
            return source
        if media_channel:
            return media_channel
        derived_app = self._derive_app_name_from_id(app_id)
        if derived_app:
            return derived_app
        if media_content_type and state.state in ("playing", "paused", "buffering"):
            return str(media_content_type).replace("_", " ").title()
        return None



    async def async_primary_speaker_changed(self, event):
        """Handle state change events for tracked entities."""
        old_state = event.data.get("old_state")
        new_state = event.data.get("new_state")

        if old_state is not None and new_state is not None:
            # Filter out spam: Only trigger if the actual state, group, or source changed
            state_changed = old_state.state != new_state.state
            group_changed = old_state.attributes.get("group_members") != new_state.attributes.get("group_members")
            source_changed = self._get_state_source_label(old_state) != self._get_state_source_label(new_state)

            if not (state_changed or group_changed or source_changed):
                return  # Ignore media_position clock ticks

            # Second level check: avoid updates if only state is same and group is same
            if old_state.state == new_state.state and not group_changed:
                # Still check source to be sure
                if not source_changed:
                    return

        if self._pending_refresh_unsub:
            self._pending_refresh_unsub()

        async def _refresh(_now):
            self._pending_refresh_unsub = None
            await update_ags_sensors(self.ags_config, self.hass)
            self._refresh_from_data()
            self.async_schedule_update_ha_state(True)

        self._pending_refresh_unsub = async_call_later(
            self.hass, STATE_REFRESH_DEBOUNCE, _refresh
        )

    def _build_source_details(self):
        """Expose visible generated AGS music sources for richer frontend rendering."""
        return [
            {
                "id": source.get("id"),
                "name": source.get("Source"),
                "value": source.get("Source_Value"),
                "media_content_type": source.get("media_content_type"),
                "default": source.get("source_default", False),
                "can_play": source.get("can_play", True),
                "can_expand": source.get("can_expand", False),
                "folder_path": source.get("folder_path", []),
                "available_on": source.get("available_on", []),
                "thumbnail": source.get("thumbnail"),
            }
            for source in (
                apply_default_source_art(source)
                for source in combine_source_inventory(self.hass.data.get(DOMAIN, {}))
            )
            if source.get("Source")
        ]

    def _build_hidden_source_details(self):
        """Expose hidden generated sources for the AGS Sources panel."""
        _visible, hidden = split_source_inventory(self.hass.data.get(DOMAIN, {}))
        return [
            {
                "id": source.get("id"),
                "name": source.get("Source"),
                "value": source.get("Source_Value"),
                "media_content_type": source.get("media_content_type"),
                "default": source.get("source_default", False),
                "can_play": source.get("can_play", True),
                "can_expand": source.get("can_expand", False),
                "folder_path": source.get("folder_path", []),
                "available_on": source.get("available_on", []),
                "thumbnail": source.get("thumbnail"),
            }
            for source in (apply_default_source_art(source) for source in hidden)
            if source.get("Source")
        ]

    def _build_all_source_details(self):
        """Expose all known generated music sources for settings UI."""
        visible, hidden = split_source_inventory(self.hass.data.get(DOMAIN, {}))
        hidden_ids = {source.get("id") for source in hidden}
        return [
            {
                "id": source.get("id"),
                "name": source.get("Source"),
                "value": source.get("Source_Value"),
                "media_content_type": source.get("media_content_type"),
                "default": source.get("source_default", False),
                "hidden": source.get("id") in hidden_ids,
                "thumbnail": source.get("thumbnail"),
            }
            for source in (apply_default_source_art(source) for source in [*visible, *hidden])
            if source.get("Source")
        ]

    def _get_room_switch_entity_id(self, room_name: str) -> str | None:
        safe_room_id = "".join(
            c for c in room_name.lower().replace(" ", "_") if c.isalnum() or c == "_"
        )
        while "__" in safe_room_id:
            safe_room_id = safe_room_id.replace("__", "_")
        return f"switch.{safe_room_id}_media" if safe_room_id else None

    def _get_global_block_reason(self) -> str | None:
        """Return the global reason AGS is not actively including rooms."""
        if self.ags_status != "OFF":
            return None

        zone_state = self.hass.states.get("zone.home")
        if (
            not self.ags_config.get("off_override", False)
            and zone_state is not None
            and zone_state.state == "0"
        ):
            return "Zone check is pausing AGS because nobody is home"

        schedule_cfg = self.hass.data[DOMAIN].get("schedule_entity")
        if schedule_cfg and self.hass.data.get("schedule_state") is False:
            return "Schedule is currently outside its active window"

        if self.hass.data.get("switch_media_system_state") is False:
            return "AGS system switch is turned off"

        return "AGS is idle"

    def _build_logic_flags(self):
        """Summarize the control conditions behind AGS decisions."""
        actions_switch = self.hass.states.get("switch.ags_actions")
        zone_state = self.hass.states.get("zone.home")
        schedule_cfg = self.hass.data[DOMAIN].get("schedule_entity")
        schedule_entity = (
            self.hass.states.get(schedule_cfg["entity_id"])
            if schedule_cfg and schedule_cfg.get("entity_id")
            else None
        )
        selected_source = self.hass.data.get("ags_media_player_source")

        return [
            {
                "label": "Actions",
                "value": "Enabled" if actions_switch is None or actions_switch.state == "on" else "Paused",
                "tone": "good" if actions_switch is None or actions_switch.state == "on" else "warn",
                "detail": "Join and source actions follow the AGS Actions switch",
            },
            {
                "label": "Off Override",
                "value": (
                    "Enabled"
                    if self.ags_config.get("off_override", False)
                    else (
                        f"Home: {zone_state.state}"
                        if zone_state is not None
                        else "zone.home missing"
                    )
                ),
                "tone": "neutral" if self.ags_config.get("off_override", False) else "info",
                "detail": "Playback can force the system ON when Off Override is enabled",
            },
            {
                "label": "Schedule",
                "value": (
                    "Not configured"
                    if schedule_entity is None
                    else f"{schedule_entity.entity_id}: {schedule_entity.state}"
                ),
                "tone": "neutral" if schedule_entity is None else "info",
                "detail": "Home Assistant schedules can disable or re-enable AGS",
            },
            {
                "label": "TV Mode",
                "value": self.hass.data.get("current_tv_mode") or "None",
                "tone": "info" if self.ags_status == "ON TV" else "neutral",
                "detail": "TV mode can include rooms or intentionally isolate them",
            },
            {
                "label": "Source",
                "value": selected_source or "None selected",
                "tone": "good" if selected_source else "neutral",
                "detail": "The AGS source picker feeds the dashboard card and fallback routing",
            },
        ]

    def _build_room_diagnostics(self):
        """Explain why each room is included, skipped, or idle."""
        active_rooms = set(self.active_rooms or [])
        global_block_reason = self._get_global_block_reason()
        room_diagnostics = []

        for room in self.ags_config.get("rooms", []):
            room_name = room.get("room", "")
            switch_entity_id = self._get_room_switch_entity_id(room_name)
            switch_on = bool(self.hass.data.get(switch_entity_id))
            speaker_states = []
            active_tv_names = []
            no_music_tv = False

            for device in room.get("devices", []):
                state = self.hass.states.get(device["device_id"])
                if device.get("device_type") == "speaker":
                    speaker_states.append(state)
                if (
                    device.get("device_type") == "tv"
                    and is_tv_mode_state(state)
                ):
                    active_tv_names.append(
                        state.attributes.get("friendly_name", device["device_id"])
                    )
                    if device.get("tv_mode", TV_MODE_TV_AUDIO) == TV_MODE_NO_MUSIC:
                        no_music_tv = True

            available_speakers = [
                state
                for state in speaker_states
                if state and state.state.lower() not in TV_IGNORE_STATES
            ]

            if room_name in active_rooms:
                state_label = "included"
                reason = (
                    f"Included with {len(available_speakers) or len(speaker_states)} speaker(s)"
                )
                tone = "good"
            elif switch_on and no_music_tv:
                state_label = "skipped"
                reason = (
                    f"Skipped because {', '.join(active_tv_names)} is active in No Music mode"
                )
                tone = "warn"
            elif switch_on and global_block_reason:
                state_label = "blocked"
                reason = global_block_reason
                tone = "neutral"
            elif switch_on and not speaker_states:
                state_label = "skipped"
                reason = "Room switch is on, but no speaker devices are configured"
                tone = "warn"
            elif switch_on and not available_speakers:
                state_label = "waiting"
                reason = "Room switch is on, but no speaker is currently available"
                tone = "warn"
            elif switch_on:
                state_label = "waiting"
                reason = "Room switch is on and waiting for grouping logic"
                tone = "info"
            else:
                state_label = "off"
                reason = "Room switch is off"
                tone = "neutral"

            room_diagnostics.append(
                {
                    "name": room_name,
                    "switch_entity_id": switch_entity_id,
                    "switch_on": switch_on,
                    "included": room_name in active_rooms,
                    "state": state_label,
                    "tone": tone,
                    "reason": reason,
                    "active_tv_names": active_tv_names,
                    "speaker_count": len(
                        [device for device in room.get("devices", []) if device.get("device_type") == "speaker"]
                    ),
                    "device_count": len(room.get("devices", [])),
                }
            )

        return room_diagnostics

    def _build_speaker_candidates(self):
        """Expose the ranking behind speaker election."""
        candidates = []
        active_rooms = set(self.active_rooms or [])
        preferred = self.preferred_primary_speaker
        selected = self.primary_speaker
        index = 1

        for room in self.ags_config.get("rooms", []):
            if room.get("room") not in active_rooms:
                continue

            tv_active = any(
                (
                    device.get("device_type") == "tv"
                    and is_tv_mode_state(self.hass.states.get(device["device_id"]))
                )
                for device in room.get("devices", [])
            )

            speakers = sorted(
                [
                    device
                    for device in room.get("devices", [])
                    if device.get("device_type") == "speaker"
                ],
                key=lambda item: item.get("priority", 999),
            )

            for device in speakers:
                state = self.hass.states.get(device["device_id"])
                speaker_state = state.state if state else "missing"
                source = state.attributes.get("source") if state else None
                available = (
                    state is not None
                    and speaker_state.lower() not in TV_IGNORE_STATES
                )

                reason_parts = []
                if device["device_id"] == selected:
                    reason_parts.append("Selected as current primary")
                if device["device_id"] == preferred:
                    reason_parts.append("Best priority in active rooms")
                if (
                    device["device_id"] == selected
                    and selected not in (None, "none")
                    and preferred not in (None, "none")
                    and selected != preferred
                ):
                    reason_parts.append("Sticky master kept playing")
                if tv_active:
                    reason_parts.append("TV present in this room")
                if not reason_parts:
                    reason_parts.append("Available for election")

                candidates.append(
                    {
                        "rank": index,
                        "entity_id": device["device_id"],
                        "friendly_name": (
                            state.attributes.get("friendly_name")
                            if state
                            else device["device_id"]
                        ),
                        "room": room.get("room"),
                        "priority": device.get("priority"),
                        "state": speaker_state,
                        "source": self._get_state_source_label(state),
                        "available": available,
                        "selected": device["device_id"] == selected,
                        "preferred": device["device_id"] == preferred,
                        "reason": "; ".join(reason_parts),
                    }
                )
                index += 1

        return candidates

    def _build_room_details(self):
        """Return room and device metadata used by the custom dashboard card."""
        active_rooms = set(self.active_rooms or [])
        active_speakers = set(self.active_speakers or [])
        room_details = []

        for room in self.ags_config.get("rooms", []):
            safe_room_id = "".join(
                c
                for c in room.get("room", "").lower().replace(" ", "_")
                if c.isalnum() or c == "_"
            )
            switch_entity_id = f"switch.{safe_room_id}_media" if safe_room_id else None
            switch_state = self.hass.states.get(switch_entity_id) if switch_entity_id else None

            devices = []
            tv_active = False
            for device in room.get("devices", []):
                if device.get("disabled"):
                    continue
                state = self.hass.states.get(device["device_id"])
                device_type = device.get("device_type", "speaker")
                if (
                    device_type == "tv"
                    and is_tv_mode_state(state)
                ):
                    tv_active = True

                devices.append(
                    {
                        "entity_id": device["device_id"],
                        "friendly_name": (
                            state.attributes.get("friendly_name")
                            if state
                            else device["device_id"]
                        ),
                        "device_type": device_type,
                        "priority": device.get("priority"),
                        "state": state.state if state else None,
                        "source": self._get_state_source_label(state),
                        "active": device["device_id"] in active_speakers,
                        "tv_mode": device.get("tv_mode"),
                    }
                )

            room_details.append(
                {
                    "name": room.get("room"),
                    "switch_entity_id": switch_entity_id,
                    "switch_state": switch_state.state if switch_state else "off",
                    "active": room.get("room") in active_rooms,
                    "tv_active": tv_active,
                    "devices": devices,
                }
            )

        return room_details

    def _build_active_tv_entities(self, room_details):
        """Return active TV entities in active rooms, including the primary room."""
        active_tvs = []
        for room in room_details:
            if not room.get("active") and room.get("name") != self.primary_speaker_room:
                continue
            for device in room.get("devices", []):
                if device.get("device_type") != "tv":
                    continue
                state = self.hass.states.get(device.get("entity_id"))
                if is_tv_mode_state(state):
                    active_tvs.append(device["entity_id"])
        return active_tvs

    def _build_primary_room_devices(self, room_details):
        """Return configured device ids for the current primary speaker room."""
        for room in room_details:
            if room.get("name") == self.primary_speaker_room:
                return [device["entity_id"] for device in room.get("devices", [])]
        return []


    @property
    def extra_state_attributes(self):
        """Return entity specific state attributes."""

        room_count = len(self.hass.data.get('active_rooms', []))
        configured_name = self.name
        if self.primary_speaker_room is None and self.ags_status != "OFF":
            dynamic_title = "All Rooms are Off"
        else:
            rooms_text = self.primary_speaker_room
            if self.ags_status == "OFF":
                dynamic_title = configured_name
            elif room_count == 1:
                dynamic_title = f"{rooms_text} is Active"
            elif room_count > 1:
                dynamic_title = f"{rooms_text} + {room_count-1} Active"
            else:
                dynamic_title = "All Rooms are Off"

        room_details = self._build_room_details()
        active_tv_entities = self._build_active_tv_entities(room_details)
        primary_room_devices = self._build_primary_room_devices(room_details)

        attributes = {
            "dynamic_title": dynamic_title,
            "ags_room_count": room_count,
            "configured_rooms": self.configured_rooms or [],
            "active_rooms": self.active_rooms or [],
            "active_speakers": self.active_speakers or [],
            "inactive_speakers": self.inactive_speakers or [],
            "ags_status": self.ags_status or "OFF",
            "primary_speaker": self.primary_speaker,
            "preferred_primary_speaker": self.preferred_primary_speaker,
            # ags_source now contains the numeric favorite ID. If no source is
            # selected the value will be ``None`` which allows automations to
            # skip calling ``play_media`` rather than passing an invalid
            # favourite reference.
            "ags_source": self.ags_source,
            "selected_source_name": self.hass.data.get("ags_media_player_source"),
            "ags_inactive_tv_speakers": self.ags_inactive_tv_speakers or [],
            "primary_speaker_room": self.primary_speaker_room,
            "control_device_id": self._get_command_target_entity_id(),
            "browse_entity_id": self._get_browse_target_entity_id(),
            "source_mode": self._get_source_mode(),
            "native_room_popup": self.hass.data.get(DOMAIN, {}).get("native_room_popup", True),
            "source_list_revision": self.hass.data.get(DOMAIN, {}).get("source_list_revision", 0),
            "current_tv_mode": self.hass.data.get("current_tv_mode"),
            "active_tv_entities": active_tv_entities,
            "primary_room_devices": primary_room_devices,
            "primary_room_tv_entities": [
                entity_id for entity_id in primary_room_devices if entity_id in active_tv_entities
            ],
            "ags_sources": self._build_source_details(),
            "ags_hidden_sources": self._build_hidden_source_details(),
            "ags_all_sources": self._build_all_source_details(),
            "logic_flags": self._build_logic_flags(),
            "room_diagnostics": self._build_room_diagnostics(),
            "speaker_candidates": self._build_speaker_candidates(),
            "room_details": room_details,
        }
        return attributes



    @property
    def unique_id(self):
        return "ags_media_player"

    @property
    def name(self):
        """Return the name of the device."""
        ags_config = self.hass.data.get(DOMAIN, {})
        static_name = ags_config.get('static_name')
        if static_name:
            return static_name
        return "Whole Home Audio"

    @property
    def icon(self):
        """Return the icon of the device."""
        ags_status = self.hass.data.get('ags_status', 'OFF')
        if ags_status == 'ON TV':
            return "mdi:television-play"
        if ags_status != 'OFF':
            return "mdi:music"
        return "mdi:speaker-multiple"

    @property
    def group_members(self):
        """Return one representative media player per active room for HA's group badge."""
        active_rooms = set(self.hass.data.get("active_rooms", []) or [])
        active_speakers = set(self.hass.data.get("active_speakers", []) or [])
        if not active_rooms or not active_speakers:
            return []

        representatives = []
        for room in self.ags_config.get("rooms", []) or []:
            if room.get("room") not in active_rooms:
                continue
            speakers = [
                device.get("device_id")
                for device in room.get("devices", []) or []
                if (
                    device.get("device_type") == "speaker"
                    and not device.get("disabled")
                    and device.get("device_id") in active_speakers
                )
            ]
            if speakers:
                representatives.append(speakers[0])
        return representatives

    @property
    def state(self):
        # Check the status in hass.data
        if self.ags_status == 'OFF':
            return "off"

        # Fetch the current state of the AGS Primary Speaker entity
        if self.primary_speaker_entity_id:
            self.primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id)

            # If self.primary_speaker_state is None, then the entity ID might be incorrect
            if self.primary_speaker_state is None:
                return STATE_IDLE

            # Return the state of the primary speaker
            return self.primary_speaker_state.state

        return STATE_IDLE

    @property
    def media_title(self):
        reference_state = self._get_reference_player_state()
        if not reference_state:
            return None
        attrs = reference_state.attributes
        return (
            attrs.get('media_title')
            or attrs.get('app_name')
            or self._derive_app_name_from_id(attrs.get('app_id'))
        )

    @property
    def media_artist(self):
        reference_state = self._get_reference_player_state()
        if not reference_state:
            return None
        attrs = reference_state.attributes
        return (
            attrs.get('media_artist')
            or attrs.get('media_channel')
            or attrs.get('friendly_name')
        )

    @property
    def entity_picture(self):
        reference_state = self._get_reference_player_state()
        attrs = reference_state.attributes if reference_state else {}
        native_art = (
            attrs.get("entity_picture")
            or attrs.get("entity_picture_local")
            or attrs.get("media_image_url")
            or attrs.get("thumbnail")
        )
        if native_art:
            return native_art
        return source_artwork_url(
            self.source,
            self.hass.data.get("ags_media_player_source"),
            attrs.get("app_name"),
            attrs.get("source"),
            attrs.get("media_channel"),
            attrs.get("app_id"),
            attrs.get("media_content_type"),
        )
    @property
    def is_volume_muted(self):
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('is_volume_muted') if reference_state else None

    async def async_set_volume_level(self, volume):
        """Set the volume level for all active speakers."""
        active_speakers = self.hass.data.get('active_speakers', [])
        if active_speakers:
            await self.hass.services.async_call('media_player', 'volume_set', {
                'entity_id': active_speakers,
                'volume_level': volume,
            })
            await self.async_update()

    @property
    def volume_level(self):
        """Return the volume level of the media player."""
        active_speakers = self.hass.data.get('active_speakers', [])
        total_volume = 0
        count = 0

        for speaker in active_speakers:
            state = self.hass.states.get(speaker)
            if state and 'volume_level' in state.attributes:
                total_volume += state.attributes['volume_level']
                count += 1

        if count == 0:
            return 0
        return total_volume / count

    @property
    def media_content_type(self):
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('media_content_type') if reference_state else None
    @property
    def media_duration(self):
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('media_duration') if reference_state else None
    @property
    def media_position(self):
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('media_position') if reference_state else None
    @property
    def queue_size(self):
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('queue_size') if reference_state else None




    @property
    def media_position_updated_at(self):
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('media_position_updated_at') if reference_state else None
    @property
    def supported_features(self) -> MediaPlayerEntityFeature:
        return (
            MediaPlayerEntityFeature.SEEK
            | MediaPlayerEntityFeature.PLAY
            | MediaPlayerEntityFeature.PAUSE
            | MediaPlayerEntityFeature.STOP
            | MediaPlayerEntityFeature.SHUFFLE_SET
            | MediaPlayerEntityFeature.REPEAT_SET
            | MediaPlayerEntityFeature.NEXT_TRACK
            | MediaPlayerEntityFeature.PREVIOUS_TRACK
            | MediaPlayerEntityFeature.SELECT_SOURCE
            | MediaPlayerEntityFeature.VOLUME_SET
            | MediaPlayerEntityFeature.VOLUME_STEP
            | MediaPlayerEntityFeature.TURN_ON
            | MediaPlayerEntityFeature.TURN_OFF
            | MediaPlayerEntityFeature.GROUPING
            | MediaPlayerEntityFeature.BROWSE_MEDIA
            | MediaPlayerEntityFeature.PLAY_MEDIA
        )

    async def async_play_media(self, media_content_type=None, media_content_id=None, **kwargs):
        """Play browser-selected media through AGS' queued state machine."""
        # Home Assistant calls can pass these either as direct arguments or in kwargs,
        # and often uses 'media_type'/'media_id' instead of the full names.
        content_type = media_content_type or kwargs.get("media_content_type") or kwargs.pop("media_type", None)
        content_id = media_content_id or kwargs.get("media_content_id") or kwargs.pop("media_id", None)

        # Also pop the standard ones if they are in kwargs to avoid duplicates if spread
        kwargs.pop("media_content_type", None)
        kwargs.pop("media_content_id", None)

        if content_type is None or content_id is None:
            _LOGGER.error(
                "Missing required media content arguments. type=%s, id=%s, kwargs=%s",
                content_type,
                content_id,
                kwargs,
            )
            return

        if content_type == "source":
            self.hass.data["switch_media_system_state"] = True
            await update_ags_sensors(self.ags_config, self.hass)
            self._refresh_from_data()
            target_entity_id = self._get_browse_target_entity_id(
                include_fallback=False
            ) or self._get_browse_target_entity_id()
            if target_entity_id:
                await self.hass.services.async_call(
                    "media_player",
                    "select_source",
                    {
                        "entity_id": target_entity_id,
                        "source": content_id,
                    },
                )
                self.hass.data["ags_media_player_source"] = content_id
                await self.async_update()
            return

        self.hass.data["switch_media_system_state"] = True
        self.hass.data["ags_browser_play_pending"] = True

        try:
            await update_ags_sensors(self.ags_config, self.hass)
            status = self.hass.data.get("ags_status", "OFF")

            if status == "OFF":
                _LOGGER.warning(
                    "Ignoring browser play request because AGS remained OFF after wake request"
                )
                return

            await handle_ags_status_change(
                self.hass,
                self.ags_config,
                status,
                status,
            )
            self._refresh_from_data()

            active_speakers = self.hass.data.get("active_speakers", [])
            if not active_speakers:
                _LOGGER.warning(
                    "Ignoring browser play request because no AGS rooms are active"
                )
                return

            target_entity_id = self._get_browse_target_entity_id(
                include_fallback=False
            )
            if not target_entity_id:
                _LOGGER.warning(
                    "Ignoring browser play request because no active speaker target is available"
                )
                return

            await enqueue_media_action(
                self.hass,
                "play_media",
                {
                    "entity_id": target_entity_id,
                    "media_content_id": content_id,
                    "media_content_type": content_type,
                    **kwargs,
                },
            )
            await wait_for_actions(self.hass)
        finally:
            self.hass.data.pop("ags_browser_play_pending", None)

        await self.async_update()

    async def async_join_media(self, group_members):
        """Join speakers to the primary speaker's group."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'join', {
                'entity_id': target_entity_id,
                'group_members': group_members
            })
            await self.async_update()

    async def async_unjoin_media(self):
        """Unjoin this player from any group."""
        # When unjoin is called on the AGS player, we unjoin all active speakers
        # because the AGS player represents the whole group.
        active_speakers = self.hass.data.get('active_speakers', [])
        if active_speakers:
            await self.hass.services.async_call('media_player', 'unjoin', {
                'entity_id': active_speakers
            })
            await self.async_update()

    async def async_browse_media(self, media_content_type=None, media_content_id=None):
        """Proxy media browsing through the current AGS control speaker."""
        from homeassistant.components import media_source

        self._refresh_from_data()

        is_media_source_request = bool(
            media_content_id
            and getattr(media_source, "is_media_source_id", lambda _value: False)(
                media_content_id
            )
        )
        last_error = None

        for target_entity_id in self._get_browse_target_candidates():
            try:
                result = await self._async_browse_candidate(
                    target_entity_id,
                    media_content_type,
                    media_content_id,
                )
                if result is not None:
                    if not media_content_id and not self._browse_result_has_real_content(result):
                        last_error = RuntimeError(
                            f"{target_entity_id} returned an empty browse placeholder"
                        )
                        continue
                    return self._apply_default_browse_art(result)
                last_error = RuntimeError(
                    f"{target_entity_id} returned no browse media"
                )
            except Exception as err:
                last_error = err
                _LOGGER.debug("Error browsing media on %s: %s", target_entity_id, err)

        if not media_content_id:
            fallback_root = self._build_configured_sources_browse_root()
            if fallback_root is not None:
                return fallback_root

        if last_error is not None and not is_media_source_request:
            _LOGGER.warning(
                "Unable to browse native media from AGS speaker candidates: %s",
                last_error,
            )
            raise last_error

        try:
            return self._apply_default_browse_art(await media_source.async_browse_media(
                self.hass,
                media_content_id,
            ))
        except TypeError:
            return self._apply_default_browse_art(await media_source.async_browse_media(
                self.hass,
                media_content_type,
                media_content_id,
            ))

    # Implement methods to control the AGS Primary Speaker

    async def async_media_play(self):
        """Play media."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'media_play', {
                'entity_id': target_entity_id
            })
            await self.async_update()

    async def async_media_pause(self):
        """Pause media."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'media_pause', {
                'entity_id': target_entity_id
            })
            await self.async_update()

    async def async_media_stop(self):
        """Stop media."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'media_stop', {
                'entity_id': target_entity_id
            })
            await self.async_update()

    async def async_media_next_track(self):
        """Next track."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'media_next_track', {
                'entity_id': target_entity_id
            })
            await self.async_update()

    async def async_turn_on(self):
        """Turn on."""
        _LOGGER.info("AGS: Turning on system via media player")
        self.hass.data['switch_media_system_state'] = True
        await update_ags_sensors(self.ags_config, self.hass)
        self.async_write_ha_state()

    async def async_turn_off(self):
        """Turn off."""
        _LOGGER.info("AGS: Turning off system via media player")
        self.hass.data['switch_media_system_state'] = False
        await update_ags_sensors(self.ags_config, self.hass)
        self.async_write_ha_state()

    async def async_media_previous_track(self):
        """Previous track."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'media_previous_track', {
                'entity_id': target_entity_id
            })
            await self.async_update()

    async def async_media_seek(self, position):
        """Seek to a specific point in the media on the primary speaker."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'media_seek', {
                'entity_id': target_entity_id,
                'seek_position': position
            })
            await self.async_update()

    def _get_tv_source_list(self):
        """Return source inputs from the active TV/OTT control target."""
        if self._get_source_mode() != "tv":
            return []
        target_entity_id = self._get_command_target_entity_id()
        state = self.hass.states.get(target_entity_id) if target_entity_id else None
        source_list = state.attributes.get("source_list") if state else None
        if not isinstance(source_list, (list, tuple)):
            return []
        return [str(source).strip() for source in source_list if str(source or "").strip()]

    @property
    def source_list(self):
        """Return the current AGS source list for music or TV/OTT mode."""
        self._refresh_from_data()
        tv_sources = self._get_tv_source_list()
        if tv_sources:
            return tv_sources

        return [
            source["Source"]
            for source in combine_source_inventory(self.hass.data.get(DOMAIN, {}))
            if source.get("Source")
        ]

    @property
    def source(self):
        """Return the current input source."""
        reference_state = self._get_reference_player_state()
        active_source = self._get_state_source_label(reference_state)
        if self.ags_status == "ON TV":
            if self.hass.data.get(DOMAIN, {}).get("disable_tv_source", False):
                return self.hass.data.get("ags_media_player_source")
            return active_source or "TV"

        ags_data = self.hass.data.get(DOMAIN, {})
        selected_source = find_source_by_name_or_id(
            ags_data,
            self.hass.data.get("ags_media_player_source_id"),
        )
        if not selected_source:
            selected_source = find_source_by_name_or_id(
                ags_data,
                self.hass.data.get("ags_media_player_source"),
            )
        if selected_source:
            return selected_source["Source"]

        matched_active = find_source_by_name_or_id(ags_data, active_source)
        if matched_active:
            return matched_active["Source"]

        return active_source

    def get_source_value_by_name(self, source_name):
        ags_data = self.hass.data.get(DOMAIN, {})
        source = find_source_by_name_or_id(ags_data, source_name)
        return source["Source_Value"] if source else None

    async def async_select_source(self, source):
        """Select the desired source and play it on the primary speaker."""
        ags_data = self.hass.data.get(DOMAIN, {})

        if source == "TV" and ags_data.get("disable_tv_source", False):
            return

        tv_sources = self._get_tv_source_list()
        if tv_sources and source in tv_sources:
            target_entity_id = self._get_command_target_entity_id()
            if target_entity_id:
                await self.hass.services.async_call('media_player', 'select_source', {
                    'entity_id': target_entity_id,
                    'source': source
                })
            await self.async_update()
            return

        source_entry = find_source_by_name_or_id(ags_data, source)
        if source_entry or source == "TV":
            if source_entry:
                self.hass.data["ags_media_player_source_id"] = source_entry["id"]
                self.hass.data["ags_media_player_source"] = source_entry["Source"]
            else:
                self.hass.data["ags_media_player_source"] = source
            state_obj = self.hass.states.get("switch.ags_actions")
            actions_enabled = state_obj.state == "on" if state_obj else True
            if actions_enabled:
                await ags_select_source(
                    self.ags_config,
                    self.hass,
                    ignore_playing=True,
                )
        else:
            # It might be a native source from the current control hardware.
            target_entity_id = self._get_command_target_entity_id()
            if target_entity_id:
                await self.hass.services.async_call('media_player', 'select_source', {
                    'entity_id': target_entity_id,
                    'source': source
                })

        await self.async_update()

    @property
    def shuffle(self):
        """Return the shuffle state of the primary speaker."""
        reference_state = self._get_reference_player_state()
        if reference_state:
            return reference_state.attributes.get('shuffle', False)
        return False

    @property
    def repeat(self):
        """Return the repeat state of the primary speaker."""
        reference_state = self._get_reference_player_state()
        if reference_state:
            return reference_state.attributes.get('repeat', 'off')
        return 'off'

    async def async_set_shuffle(self, shuffle):
        """Enable/Disable shuffle mode."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'shuffle_set', {
                'entity_id': target_entity_id,
                'shuffle': shuffle
            })
            await self.async_update()

    async def async_set_repeat(self, repeat):
        """Set repeat mode."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'repeat_set', {
                'entity_id': target_entity_id,
                'repeat':  repeat
            })
            await self.async_update()
