import sys
import os
import types
from unittest.mock import MagicMock

def mock_module(name):
    m = MagicMock()
    sys.modules[name] = m
    return m

# Mock homeassistant modules and their submodules
mock_module("homeassistant")
mock_module("homeassistant.core")
mock_module("homeassistant.exceptions")
mock_module("homeassistant.helpers")
mock_module("homeassistant.helpers.config_validation")
mock_module("homeassistant.helpers.discovery")
mock_module("homeassistant.helpers.dispatcher")
mock_module("homeassistant.helpers.entity_platform")
mock_module("homeassistant.helpers.event")
mock_module("homeassistant.helpers.restore_state")
mock_module("homeassistant.helpers.storage")
mock_module("homeassistant.helpers.typing")
mock_module("homeassistant.helpers.entity_registry")
mock_module("homeassistant.components")
mock_module("homeassistant.components.media_player")
mock_module("homeassistant.components.switch")
mock_module("homeassistant.components.sensor")
mock_module("homeassistant.components.websocket_api")
mock_module("homeassistant.components.http")
mock_module("homeassistant.components.panel_custom")
mock_module("homeassistant.components.frontend")
mock_module("homeassistant.const")
mock_module("voluptuous")

class DummyEntity:
    def __init__(self, *args, **kwargs):
        pass

class DummyRestoreEntity:
    def __init__(self, *args, **kwargs):
        pass

class DummyFeature:
    SEEK = 1
    PLAY = 2
    PAUSE = 4
    STOP = 8
    SHUFFLE_SET = 16
    REPEAT_SET = 32
    NEXT_TRACK = 64
    PREVIOUS_TRACK = 128
    SELECT_SOURCE = 256
    VOLUME_SET = 512
    VOLUME_STEP = 1024
    TURN_ON = 2048
    TURN_OFF = 4096
    GROUPING = 8192
    BROWSE_MEDIA = 16384
    PLAY_MEDIA = 32768

sys.modules["homeassistant.components.media_player"].MediaPlayerEntity = DummyEntity
sys.modules["homeassistant.components.media_player"].MediaPlayerDeviceClass = types.SimpleNamespace(TV="tv")
sys.modules["homeassistant.components.media_player"].MediaPlayerEntityFeature = DummyFeature
sys.modules["homeassistant.components.switch"].SwitchEntity = DummyEntity
sys.modules["homeassistant.components.sensor"].SensorEntity = DummyEntity
sys.modules["homeassistant.components.sensor"].SensorDeviceClass = types.SimpleNamespace(ENUM="enum")
sys.modules["homeassistant.helpers.restore_state"].RestoreEntity = DummyRestoreEntity
sys.modules["homeassistant.const"].STATE_IDLE = "idle"
sys.modules["homeassistant.const"].EVENT_HOMEASSISTANT_STARTED = "homeassistant_started"

# Add the custom_components directory to the path
sys.path.append(os.path.abspath("custom_components"))

def test_imports():
    try:
        from ags_service import ags_service
        print("✓ ags_service import successful")
        from ags_service import media_player
        print("✓ media_player import successful")
        from ags_service import sensor
        print("✓ sensor import successful")
        from ags_service import switch
        print("✓ switch import successful")
        from ags_service import config_flow
        print("✓ config_flow import successful")
        return True
    except Exception as e:
        print(f"✗ Import failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_source_utils():
    try:
        from ags_service.source_utils import (
            CONF_DEFAULT_SOURCE_ID,
            CONF_HIDDEN_SOURCE_IDS,
            CONF_SOURCE_FAVORITES,
            CONF_SOURCE_DISPLAY_NAMES,
            combine_source_inventory,
            make_browser_source_id,
            make_source_id,
            normalize_source_storage,
            normalize_source_list,
            split_source_inventory,
        )

        migrated = normalize_source_storage({
            "favorite_sources": [
                {
                    "Source": "Top Hit",
                    "Source_Value": "FV:top-hit",
                    "media_content_type": "favorite_item_id",
                    "source_default": True,
                },
                {
                    "Source": "Chill",
                    "Source_Value": "FV:chill",
                    "media_content_type": "favorite_item_id",
                    "source_default": True,
                },
            ],
            "ExcludedSources": ["FV:chill"],
        })
        top_hit_id = make_source_id("favorite_item_id", "FV:top-hit")
        chill_id = make_source_id("favorite_item_id", "FV:chill")
        assert migrated[CONF_DEFAULT_SOURCE_ID] == top_hit_id
        assert chill_id in migrated[CONF_HIDDEN_SOURCE_IDS]
        assert combine_source_inventory(migrated) == []

        browser_top_hit = {
            "id": make_browser_source_id("favorite_item_id", "FV:top-hit", "Top Hit", ["Favorites"]),
            "Source": "Top Hit",
            "Source_Value": "FV:top-hit",
            "media_content_type": "favorite_item_id",
            "origin": "media_browser",
        }
        browser_chill = {
            "id": make_browser_source_id("favorite_item_id", "FV:chill", "Chill", ["Favorites"]),
            "Source": "Chill",
            "Source_Value": "FV:chill",
            "media_content_type": "favorite_item_id",
            "origin": "media_browser",
        }
        migrated["last_discovered_sources"] = [browser_top_hit, browser_chill]

        migrated[CONF_SOURCE_DISPLAY_NAMES] = {top_hit_id: "Top Hits"}
        visible, hidden = split_source_inventory(migrated)
        assert visible[0]["Source"] == "Top Hit"
        assert hidden[0]["Source"] == "Chill"

        migrated[CONF_SOURCE_FAVORITES] = migrated[CONF_SOURCE_FAVORITES][:1]
        assert combine_source_inventory(migrated)[0]["id"] == browser_top_hit["id"]

        legacy_only = normalize_source_storage({
            "source_favorites": [
                {
                    "id": "source::Top Hit",
                    "Source": "Top Hit",
                    "Source_Value": "Top Hit",
                    "media_content_type": "source",
                    "source_default": True,
                }
            ],
            "default_source_id": "source::Top Hit",
        })
        assert combine_source_inventory(legacy_only) == []

        generic_sources = normalize_source_list([
            {
                "id": make_browser_source_id("favorites_folder", "object.item", "Jazz", ["Favorites"]),
                "Source": "Jazz",
                "Source_Value": "object.item",
                "media_content_type": "favorites_folder",
                "available_on": ["media_player.a"],
            },
            {
                "id": make_browser_source_id("favorites_folder", "object.item", "Rock", ["Favorites"]),
                "Source": "Rock",
                "Source_Value": "object.item",
                "media_content_type": "favorites_folder",
                "available_on": ["media_player.a"],
            },
            {
                "id": make_browser_source_id("favorites_folder", "object.item", "Jazz", ["Favorites"]),
                "Source": "Jazz",
                "Source_Value": "object.item",
                "media_content_type": "favorites_folder",
                "available_on": ["media_player.b"],
            },
        ])
        assert len(generic_sources) == 2
        assert generic_sources[0]["available_on"] == ["media_player.a", "media_player.b"]
        assert split_source_inventory(legacy_only) == ([], [])

        catalog_top_id = make_source_id("favorite_item_id", "FV:top-hit")
        catalog_chill_id = make_source_id("favorite_item_id", "FV:chill")
        catalog_deep_id = make_source_id("favorite_item_id", "FV:deep-focus")
        discovered = [
            {
                "Source": "Top Hit",
                "Source_Value": "FV:top-hit",
                "media_content_type": "favorite_item_id",
            },
            {
                "Source": "Chill",
                "Source_Value": "FV:chill",
                "media_content_type": "favorite_item_id",
            },
            {
                "Source": "Deep Focus",
                "Source_Value": "FV:deep-focus",
                "media_content_type": "favorite_item_id",
            },
        ]
        catalog_config = normalize_source_storage({
            "source_favorites": [
                {
                    "Source": "Top Hit",
                    "Source_Value": "FV:top-hit",
                    "media_content_type": "favorite_item_id",
                    "source_default": True,
                }
            ],
            "last_discovered_sources": discovered,
        })
        visible, hidden = split_source_inventory(catalog_config)
        assert [source["id"] for source in visible] == [catalog_top_id]
        assert [source["id"] for source in hidden] == [catalog_chill_id, catalog_deep_id]

        catalog_only = normalize_source_storage({
            "last_discovered_sources": discovered,
        })
        visible, hidden = split_source_inventory(catalog_only)
        assert visible == []
        assert [source["id"] for source in hidden] == [catalog_top_id, catalog_chill_id, catalog_deep_id]

        catalog_config[CONF_SOURCE_FAVORITES].append({
            "id": catalog_chill_id,
            "Source": "Chill",
            "Source_Value": "FV:chill",
            "media_content_type": "favorite_item_id",
        })
        catalog_config[CONF_HIDDEN_SOURCE_IDS] = [catalog_chill_id]
        visible, hidden = split_source_inventory(catalog_config)
        assert [source["id"] for source in visible] == [catalog_top_id]
        assert catalog_chill_id in [source["id"] for source in hidden]

        print("✓ source_utils migration/filtering/catalog split successful")
        return True
    except Exception as e:
        print(f"✗ source_utils test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_media_player_source_helpers():
    try:
        from ags_service.media_player import AGSPrimarySpeakerMediaPlayer

        class State:
            def __init__(self, state="idle", attributes=None):
                self.state = state
                self.attributes = attributes or {}

        class States:
            def __init__(self, values):
                self.values = values

            def get(self, entity_id):
                return self.values.get(entity_id)

        hass = types.SimpleNamespace(
            data={
                "ags_service": {
                    "rooms": [
                        {
                            "room": "Kitchen",
                            "devices": [
                                {
                                    "device_id": "media_player.low_rank",
                                    "device_type": "speaker",
                                    "priority": 2,
                                },
                                {
                                    "device_id": "media_player.top_rank",
                                    "device_type": "speaker",
                                    "priority": 1,
                                },
                            ],
                        }
                    ],
                }
            },
            states=States({
                "media_player.top_rank": State("idle"),
                "media_player.low_rank": State("idle"),
            }),
        )
        player = AGSPrimarySpeakerMediaPlayer(hass, {})
        player.hass = hass
        player.entity_id = "media_player.ags_media_system"
        assert player._get_browse_target_entity_id() == "media_player.top_rank"

        hass.states = States({
            "media_player.top_rank": State("unavailable"),
            "media_player.low_rank": State("idle"),
        })
        assert player._get_browse_target_entity_id() == "media_player.low_rank"

        catalog = [
            {
                "id": "favorite_item_id::FV:top-hit",
                "Source": "Top Hit",
                "Source_Value": "FV:top-hit",
                "media_content_type": "favorite_item_id",
            }
        ]
        favorites, default_id = player._merge_browser_favorites(
            {
                "source_favorites": [
                    {
                        "id": "source::Top Hit",
                        "Source": "Top Hit",
                        "Source_Value": "Top Hit",
                        "media_content_type": "source",
                        "source_default": True,
                    }
                ],
                "default_source_id": "source::Top Hit",
            },
            catalog,
            [],
        )
        assert favorites[0]["id"] == "favorite_item_id::FV:top-hit"
        assert favorites[0]["source_default"] is True
        assert default_id == "favorite_item_id::FV:top-hit"

        print("✓ media_player source helper fallback/migration successful")
        return True
    except Exception as e:
        print(f"✗ media_player helper test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_media_player_display_metadata():
    try:
        from ags_service.media_player import AGSPrimarySpeakerMediaPlayer
        from ags_service.source_art import source_artwork_url

        class State:
            def __init__(self, state="idle", attributes=None):
                self.state = state
                self.attributes = attributes or {}

        class States:
            def __init__(self, values):
                self.values = values

            def get(self, entity_id):
                return self.values.get(entity_id)

        source_value = "spotify:playlist:top"
        hass = types.SimpleNamespace(
            data={
                "ags_service": {
                    "static_name": "Jason Audio",
                    "rooms": [
                        {
                            "room": "Kitchen",
                            "devices": [
                                {
                                    "device_id": "media_player.kitchen",
                                    "device_type": "speaker",
                                    "priority": 1,
                                },
                            ],
                        },
                        {
                            "room": "Patio",
                            "devices": [
                                {
                                    "device_id": "media_player.patio",
                                    "device_type": "speaker",
                                    "priority": 2,
                                },
                            ],
                        },
                    ],
                    "source_favorites": [
                        {
                            "id": "music::spotify:playlist:top",
                            "Source": "Spotify",
                            "Source_Value": source_value,
                            "media_content_type": "music",
                        }
                    ],
                    "last_discovered_sources": [],
                    "hidden_source_ids": [],
                    "source_display_names": {},
                    "default_source_id": None,
                },
                "active_rooms": ["Kitchen", "Patio"],
                "active_speakers": ["media_player.kitchen", "media_player.patio"],
                "ags_status": "ON",
                "primary_speaker": "media_player.kitchen",
                "preferred_primary_speaker": "media_player.kitchen",
                "ags_media_player_source": "Spotify",
            },
            states=States({
                "media_player.kitchen": State("playing", {"app_name": "Spotify"}),
                "media_player.patio": State("idle", {}),
                "switch.kitchen_media": State("on", {}),
                "switch.patio_media": State("on", {}),
            }),
        )

        player = AGSPrimarySpeakerMediaPlayer(hass, {})
        player.hass = hass
        player.entity_id = "media_player.ags_media_player"
        player.ags_status = "ON"
        player.primary_speaker_room = "Kitchen"
        player.primary_speaker_entity_id = "media_player.kitchen"
        player.primary_speaker_state = hass.states.get("media_player.kitchen")
        player.active_rooms = hass.data["active_rooms"]
        player.active_speakers = hass.data["active_speakers"]

        attrs = player.extra_state_attributes
        assert player.name == "Jason Audio"
        assert attrs["dynamic_title"] == "Kitchen + 1 Active"
        assert attrs["ags_room_count"] == 2
        assert len(player.group_members) == 2
        assert "AGS Media System" not in attrs["dynamic_title"]
        assert player.icon == "mdi:music"
        assert player.entity_picture == source_artwork_url("Spotify")
        assert source_artwork_url("Music").endswith("/apple-music.svg")
        assert player._normalize_native_source("Netflix")["thumbnail"] == source_artwork_url("Netflix")
        assert attrs["ags_sources"][0]["thumbnail"] == source_artwork_url("Spotify")
        browse_tree = player._apply_default_browse_art({
            "title": "Root",
            "media_content_type": "library",
            "media_content_id": "root",
            "children": [
                {
                    "title": "Paramount+",
                    "media_content_type": "app",
                    "media_content_id": "paramount",
                }
            ],
        })
        assert browse_tree["children"][0]["thumbnail"] == source_artwork_url("Paramount+")

        player.ags_status = "ON TV"
        hass.data["ags_status"] = "ON TV"
        assert player.icon == "mdi:television-play"

        player.ags_status = "OFF"
        hass.data["ags_status"] = "OFF"
        player.primary_speaker_room = None
        attrs = player.extra_state_attributes
        assert attrs["dynamic_title"] == "Jason Audio"
        assert player.icon == "mdi:speaker-multiple"

        print("✓ media_player display metadata/artwork successful")
        return True
    except Exception as e:
        print(f"✗ media_player display metadata test failed: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    if (
        test_imports()
        and test_source_utils()
        and test_media_player_source_helpers()
        and test_media_player_display_metadata()
    ):
        print("\nAll imports and source utility checks successful in mocked environment.")
    else:
        sys.exit(1)
