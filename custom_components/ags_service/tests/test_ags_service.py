import os
import sys
import importlib.util
import asyncio
import types
import pytest

class DummyVol:
    def __getattr__(self, name):
        def identity(v, *a, **k):
            return v
        return identity

# Provide minimal stubs for Home Assistant modules required by the media_player
sys.modules['voluptuous'] = DummyVol()

class DummyRestoreEntity:
    pass


class DummyMediaPlayerEntity:
    pass


ORIGINAL_MODULES = {}

class DummyFeature:
    SEEK = PLAY = PAUSE = STOP = SHUFFLE_SET = REPEAT_SET = NEXT_TRACK = (
        PREVIOUS_TRACK
    ) = SELECT_SOURCE = VOLUME_SET = TURN_ON = TURN_OFF = 1

STUB_MODULES = {
    'homeassistant.helpers.restore_state': types.SimpleNamespace(
        RestoreEntity=DummyRestoreEntity
    ),
    'homeassistant.components.media_player': types.SimpleNamespace(
        MediaPlayerEntity=DummyMediaPlayerEntity
    ),
    'homeassistant.components.media_player.const': types.SimpleNamespace(
        MediaPlayerEntityFeature=DummyFeature
    ),
    'homeassistant.const': types.SimpleNamespace(
        STATE_IDLE='idle',
        STATE_PLAYING='playing',
        STATE_PAUSED='paused',
        CONF_DEVICES='devices',
    ),
    'homeassistant.helpers.event': types.SimpleNamespace(
        async_track_state_change_event=lambda *a, **k: None
    ),
    'homeassistant.helpers.config_validation': types.SimpleNamespace(
        Schema=lambda v: v,
        ensure_list=lambda v: v,
        string=lambda v=None: v,
        boolean=lambda v=None: v,
        positive_int=lambda v=None: v,
    ),
    'homeassistant.helpers.discovery': types.SimpleNamespace(
        async_load_platform=lambda *a, **k: None
    ),
}

for name, stub in STUB_MODULES.items():
    ORIGINAL_MODULES[name] = sys.modules.get(name)
    sys.modules[name] = stub

sys.modules['homeassistant.helpers'] = types.SimpleNamespace(
    config_validation=sys.modules['homeassistant.helpers.config_validation'],
    discovery=sys.modules['homeassistant.helpers.discovery'],
    event=sys.modules['homeassistant.helpers.event'],
)
sys.modules.setdefault('custom_components', types.ModuleType('custom_components'))

# Load ags_service module directly without executing package __init__
MODULE_PATH = os.path.join(os.path.dirname(__file__), '..', 'ags_service.py')
spec = importlib.util.spec_from_file_location('ags_service', MODULE_PATH)
ags_service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ags_service)

# Expose ags_service under the package namespace so relative imports work
pkg_name = 'custom_components.ags_service'
package = types.ModuleType(pkg_name)
package.__path__ = []
sys.modules[pkg_name] = package
sys.modules[pkg_name + '.ags_service'] = ags_service

# Load the media_player module used for additional tests
MP_MODULE_PATH = os.path.join(
    os.path.dirname(__file__), '..', 'media_player.py'
)
mp_spec = importlib.util.spec_from_file_location(
    'custom_components.ags_service.media_player', MP_MODULE_PATH
)
ags_media_player = importlib.util.module_from_spec(mp_spec)
mp_spec.loader.exec_module(ags_media_player)

# Load __init__ module for async_setup tests
INIT_PATH = os.path.join(
    os.path.dirname(__file__), '..', '__init__.py'
)
init_spec = importlib.util.spec_from_file_location('custom_components.ags_service.__init__', INIT_PATH)
ags_init = importlib.util.module_from_spec(init_spec)
init_spec.loader.exec_module(ags_init)


class FakeState:
    def __init__(self, state, **attributes):
        self.state = state
        self.attributes = attributes


class FakeStates:
    def __init__(self):
        self._states = {}

    def set(self, entity_id, state, **attrs):
        self._states[entity_id] = FakeState(state, **attrs)

    def get(self, entity_id, default=None):
        return self._states.get(entity_id, default)


class FakeServices:
    def __init__(self):
        self.calls = []

    async def async_call(self, domain, service, data):
        self.calls.append((domain, service, data))

    def async_register(self, domain, service, func):
        self.calls.append((domain, service, 'register'))


class FakeLoop:
    def call_soon_threadsafe(self, func, *args, **kwargs):
        func(*args, **kwargs)


class FakeHass:
    def __init__(self):
        self.data = {}
        self.states = FakeStates()
        self.loop = FakeLoop()
        self.services = FakeServices()

    def async_create_task(self, coro):
        asyncio.get_event_loop().run_until_complete(coro)

    async def async_add_executor_job(self, func, *args):
        return func(*args)

@pytest.fixture
def basic_setup():
    rooms = [
        {
            "room": "Living",
            "devices": [
                {"device_id": "media_player.living", "device_type": "speaker", "priority": 1},
                {"device_id": "media_player.tv", "device_type": "tv", "priority": 2},
            ],
        }
    ]
    config = {
        "rooms": rooms,
        "Sources": [
            {"Source": "Default", "Source_Value": "1", "media_content_type": "favorite_item_id", "source_default": True}
        ],
        "disable_zone": False,
        "primary_delay": 1,
        "homekit_player": None,
        "create_sensors": False,
        "default_on": True,
        "static_name": None,
        "disable_Tv_Source": False,
    }
    hass = FakeHass()
    hass.data["ags_service"] = config
    hass.states.set("zone.home", "1")
    return config, hass


def test_get_configured_rooms(basic_setup):
    config, hass = basic_setup
    rooms = config["rooms"]
    result = ags_service.get_configured_rooms(rooms, hass)
    assert result == ["Living"]
    assert hass.data["configured_rooms"] == ["Living"]


def test_get_active_rooms(basic_setup):
    config, hass = basic_setup
    rooms = config["rooms"]
    hass.data["switch.living_media"] = True
    result = ags_service.get_active_rooms(rooms, hass)
    assert result == ["Living"]
    assert hass.data["active_rooms"] == ["Living"]


def test_update_ags_status_zone_off(basic_setup):
    config, hass = basic_setup
    hass.states.set("zone.home", "0")
    result = ags_service.update_ags_status(config, hass)
    assert result == "OFF"
    assert hass.data["ags_status"] == "OFF"


def test_update_ags_status_override(basic_setup):
    config, hass = basic_setup
    hass.states.set("media_player.living", "playing", media_content_id="fav")
    config["rooms"][0]["devices"][0]["override_content"] = "fav"
    result = ags_service.update_ags_status(config, hass)
    assert result == "Override"
    assert hass.data["ags_status"] == "Override"


def test_update_ags_status_tv_mode(basic_setup):
    config, hass = basic_setup
    hass.data["active_rooms"] = ["Living"]
    hass.data["switch_media_system_state"] = True
    hass.states.set("media_player.tv", "on")
    result = ags_service.update_ags_status(config, hass)
    assert result == "ON TV"
    assert hass.data["ags_status"] == "ON TV"


def test_check_primary_speaker_logic_override(basic_setup):
    config, hass = basic_setup
    hass.data["ags_status"] = "Override"
    hass.states.set("media_player.living", "playing", media_content_id="fav")
    config["rooms"][0]["devices"][0]["override_content"] = "fav"
    result = ags_service.check_primary_speaker_logic(config, hass)
    assert result == "media_player.living"


def test_determine_primary_speaker(basic_setup):
    config, hass = basic_setup
    hass.data["ags_status"] = "ON"
    hass.data["active_rooms"] = ["Living"]
    hass.states.set("media_player.living", "playing", group_members=["media_player.living"])
    result = ags_service.determine_primary_speaker(config, hass)
    assert result == "media_player.living"
    assert hass.data["primary_speaker"] == "media_player.living"


def test_determine_primary_speaker_priority_order():
    rooms = [{
        "room": "Living",
        "devices": [
            {"device_id": "media_player.first", "device_type": "speaker", "priority": 1},
            {"device_id": "media_player.second", "device_type": "speaker", "priority": 2},
        ],
    }]
    config = {
        "rooms": rooms,
        "Sources": [{"Source": "Default", "Source_Value": "1", "media_content_type": "favorite_item_id", "source_default": True}],
        "disable_zone": False,
        "primary_delay": 1,
        "homekit_player": None,
        "create_sensors": False,
        "default_on": True,
        "static_name": None,
        "disable_Tv_Source": False,
    }
    hass = FakeHass()
    hass.data["ags_service"] = config
    hass.states.set("zone.home", "1")
    hass.data["ags_status"] = "ON"
    hass.data["active_rooms"] = ["Living"]
    hass.states.set("media_player.first", "playing", group_members=["media_player.first"])
    hass.states.set("media_player.second", "playing", group_members=["media_player.second"])
    result = ags_service.determine_primary_speaker(config, hass)
    assert result == "media_player.first"


def test_update_speaker_states_on(basic_setup):
    config, hass = basic_setup
    hass.data["ags_status"] = "ON"
    hass.data["active_rooms"] = ["Living"]
    hass.states.set("media_player.living", "on")
    active, inactive = ags_service.update_speaker_states(config["rooms"], hass)
    assert active == ["media_player.living"]
    assert inactive == []


def test_get_preferred_primary_speaker(basic_setup):
    config, hass = basic_setup
    hass.data["active_speakers"] = ["media_player.living"]
    result = ags_service.get_preferred_primary_speaker(config["rooms"], hass)
    assert result == "media_player.living"


def test_get_inactive_tv_speakers(basic_setup):
    config, hass = basic_setup
    hass.data["ags_status"] = "ON"
    hass.data["active_rooms"] = ["Living"]
    result = ags_service.get_inactive_tv_speakers(config["rooms"], hass)
    assert result == []


def test_execute_ags_logic_calls_services(basic_setup):
    config, hass = basic_setup
    hass.data.update({
        "active_speakers": ["media_player.living"],
        "ags_status": "ON",
        "inactive_speakers": [],
        "primary_speaker": "media_player.living",
        "ags_inactive_tv_speakers": []
    })
    ags_service.execute_ags_logic(hass)
    assert ("media_player", "join", {"entity_id": "media_player.living", "group_members": ["media_player.living"]}) in hass.services.calls


def test_ags_select_source_tv(basic_setup):
    config, hass = basic_setup
    hass.data.update({
        "ags_media_player_source": "TV",
        "ags_status": "ON",
        "primary_speaker": "media_player.living"
    })
    ags_service.ags_select_source(config, hass)
    assert hass.services.calls[0][1] == "select_source"


def test_determine_primary_speaker_delay_default(monkeypatch):
    rooms = [
        {"room": "Living", "devices": [{"device_id": "media_player.living", "device_type": "speaker", "priority": 1}]}
    ]
    config = {
        "rooms": rooms,
        "Sources": [{"Source": "Default", "Source_Value": "1", "media_content_type": "favorite_item_id", "source_default": True}],
        "disable_zone": False,
        "primary_delay": 5,
        "homekit_player": None,
        "create_sensors": False,
        "default_on": True,
        "static_name": None,
        "disable_Tv_Source": False,
    }
    hass = FakeHass()
    hass.data["ags_service"] = config
    hass.data["ags_status"] = "ON"
    hass.data["active_rooms"] = ["Living"]
    hass.states.set("media_player.living", "paused", group_members=["media_player.living"])

    delays = []

    async def fake_sleep(sec):
        delays.append(sec)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    ags_service.determine_primary_speaker(config, hass)
    assert delays == [5]


def test_determine_primary_speaker_delay_custom(monkeypatch):
    rooms = [
        {"room": "Living", "devices": [{"device_id": "media_player.living", "device_type": "speaker", "priority": 1}]}
    ]
    config = {
        "rooms": rooms,
        "Sources": [{"Source": "Default", "Source_Value": "1", "media_content_type": "favorite_item_id", "source_default": True}],
        "disable_zone": False,
        "primary_delay": 2,
        "homekit_player": None,
        "create_sensors": False,
        "default_on": True,
        "static_name": None,
        "disable_Tv_Source": False,
    }
    hass = FakeHass()
    hass.data["ags_service"] = config
    hass.data["ags_status"] = "ON"
    hass.data["active_rooms"] = ["Living"]
    hass.states.set("media_player.living", "paused", group_members=["media_player.living"])

    delays = []

    async def fake_sleep(sec):
        delays.append(sec)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    ags_service.determine_primary_speaker(config, hass)
    assert delays == [2]


def test_update_ags_status_disable_zone_true(basic_setup):
    config, hass = basic_setup
    config["disable_zone"] = True
    hass.states.set("zone.home", "0")
    result = ags_service.update_ags_status(config, hass)
    assert result != "OFF"


def test_update_speaker_states_off(basic_setup):
    config, hass = basic_setup
    hass.data["ags_status"] = "OFF"
    active, inactive = ags_service.update_speaker_states(config["rooms"], hass)
    assert active == []
    assert inactive == ["media_player.living"]


def test_default_on_behavior(monkeypatch):
    rooms = [{"room": "Living", "devices": []}]
    config = {
        "rooms": rooms,
        "Sources": [],
        "disable_zone": False,
        "primary_delay": 1,
        "homekit_player": None,
        "create_sensors": False,
        "default_on": False,
        "static_name": None,
        "disable_Tv_Source": False,
    }
    hass = FakeHass()
    hass.data["ags_service"] = config
    hass.states.set("zone.home", "1")
    hass.data.pop("switch_media_system_state", None)
    result = ags_service.update_ags_status(config, hass)
    assert result == "OFF"
    config["default_on"] = True
    hass.data.pop("switch_media_system_state", None)
    result = ags_service.update_ags_status(config, hass)
    assert result == "ON"


def test_default_source_used_when_blank(basic_setup, monkeypatch):
    config, hass = basic_setup
    hass.data.pop("ags_media_player_source", None)

    monkeypatch.setattr(ags_media_player, "update_ags_sensors", lambda c, h: None)
    player = ags_media_player.AGSPrimarySpeakerMediaPlayer(hass, config)
    player.hass = hass
    player.update()
    assert player.ags_source == "1"


def test_disable_tv_sources_behavior(monkeypatch):
    rooms = [
        {
            "room": "Living",
            "devices": [
                {"device_id": "media_player.living", "device_type": "speaker", "priority": 1},
                {"device_id": "media_player.tv", "device_type": "tv", "priority": 2},
            ],
        }
    ]
    config = {
        "rooms": rooms,
        "Sources": [
            {"Source": "Default", "Source_Value": "1", "media_content_type": "favorite_item_id", "source_default": True}
        ],
        "disable_zone": False,
        "primary_delay": 1,
        "homekit_player": None,
        "create_sensors": False,
        "default_on": True,
        "static_name": None,
        "disable_Tv_Source": False,
    }
    hass = FakeHass()
    hass.data["ags_service"] = config
    hass.data["ags_status"] = "ON TV"
    hass.data["primary_speaker"] = "media_player.living"
    hass.states.set(
        "media_player.tv",
        "on",
        source_list=["HDMI1", "HDMI2"],
        source="HDMI1",
        group_members=["media_player.tv"],
    )

    monkeypatch.setattr(ags_media_player, "update_ags_sensors", lambda c, h: None)
    player = ags_media_player.AGSPrimarySpeakerMediaPlayer(hass, config)
    player.hass = hass
    player.update()
    assert player.source_list == ["HDMI1", "HDMI2"]

    config["disable_Tv_Source"] = True
    hass.data["ags_service"] = config
    player = ags_media_player.AGSPrimarySpeakerMediaPlayer(hass, config)
    player.hass = hass
    player.update()
    assert "TV" in player.source_list


def test_homekit_player_creation_and_sync(basic_setup, monkeypatch):
    config, hass = basic_setup
    config["homekit_player"] = "HK"
    added = []

    def add_entities(entities, update=False):
        added.extend(entities)

    monkeypatch.setattr(ags_media_player, "update_ags_sensors", lambda c, h: None)
    asyncio.get_event_loop().run_until_complete(
        ags_media_player.async_setup_platform(hass, {}, add_entities)
    )

    assert any(isinstance(e, ags_media_player.MediaSystemMediaPlayer) for e in added)

    primary = next(e for e in added if isinstance(e, ags_media_player.AGSPrimarySpeakerMediaPlayer))
    hk = next(e for e in added if isinstance(e, ags_media_player.MediaSystemMediaPlayer))
    primary.hass = hass
    hk.hass = hass
    hass.data.update({"primary_speaker": "media_player.living", "ags_status": "ON"})
    hass.states.set("media_player.living", "playing", group_members=["media_player.living"])
    primary.update()
    assert hk.state == primary.state


def test_homekit_player_absent(basic_setup, monkeypatch):
    config, hass = basic_setup
    added = []

    def add_entities(entities, update=False):
        added.extend(entities)

    monkeypatch.setattr(ags_media_player, "update_ags_sensors", lambda c, h: None)
    asyncio.get_event_loop().run_until_complete(
        ags_media_player.async_setup_platform(hass, {}, add_entities)
    )

    assert not any(isinstance(e, ags_media_player.MediaSystemMediaPlayer) for e in added)


def test_update_ags_status_override_when_off(basic_setup):
    config, hass = basic_setup
    hass.data["switch_media_system_state"] = False
    hass.states.set("media_player.living", "playing", media_content_id="fav")
    config["rooms"][0]["devices"][0]["override_content"] = "fav"
    result = ags_service.update_ags_status(config, hass)
    assert result == "Override"


def test_async_setup_creates_sensors(monkeypatch):
    """Sensors load when create_sensors=True."""
    config = {
        ags_init.DOMAIN: {
            "rooms": [],
            "Sources": [],
            "disable_zone": False,
            "primary_delay": 1,
            "homekit_player": None,
            "create_sensors": True,
            "default_on": False,
            "static_name": None,
            "disable_Tv_Source": False,
        }
    }
    hass = FakeHass()
    calls = []

    async def fake_load(h, platform, domain, data, conf):
        calls.append(platform)

    monkeypatch.setattr(ags_init, "async_load_platform", fake_load)
    asyncio.get_event_loop().run_until_complete(ags_init.async_setup(hass, config))
    assert "sensor" in calls


def test_async_setup_skips_sensors(monkeypatch):
    """Sensors are skipped when create_sensors=False."""
    config = {
        ags_init.DOMAIN: {
            "rooms": [],
            "Sources": [],
            "disable_zone": False,
            "primary_delay": 1,
            "homekit_player": None,
            "create_sensors": False,
            "default_on": False,
            "static_name": None,
            "disable_Tv_Source": False,
        }
    }
    hass = FakeHass()
    calls = []

    async def fake_load(h, platform, domain, data, conf):
        calls.append(platform)

    monkeypatch.setattr(ags_init, "async_load_platform", fake_load)
    asyncio.get_event_loop().run_until_complete(ags_init.async_setup(hass, config))
    assert "sensor" not in calls


def teardown_module(module):
    """Restore any Home Assistant modules we replaced with stubs."""
    for name, original in ORIGINAL_MODULES.items():
        if original is None:
            del sys.modules[name]
        else:
            sys.modules[name] = original
