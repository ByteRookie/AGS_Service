import types
import os
import sys
import importlib.util

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
spec = importlib.util.spec_from_file_location(
    "ags_service_module",
    os.path.join(ROOT, "custom_components", "ags_service", "ags_service.py"),
)
ags_service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ags_service)
update_ags_status = ags_service.update_ags_status

class FakeState:
    def __init__(self, state, attributes=None):
        self.state = state
        self.attributes = attributes or {}

class FakeStates:
    def __init__(self):
        self.data = {
            'zone.home': FakeState('1')
        }
    def get(self, entity_id):
        return self.data.get(entity_id)

class FakeHass:
    def __init__(self):
        self.states = FakeStates()
        self.data = {}


def base_config():
    return {
        'rooms': [],
        'Sources': [{'Source': 'Default', 'Source_Value': '1', 'media_content_type': 'music', 'source_default': True}],
        'disable_zone': False,
        'primary_delay': 5,
        'homekit_player': None,
        'create_sensors': False,
        'default_on': True,
        'static_name': None,
        'disable_Tv_Source': False,
        'interval_sync': 30,
    }


def test_schedule_off_sets_status_off():
    hass = FakeHass()
    hass.data['ags_schedule'] = False
    hass.data['ags_service'] = base_config()
    ags_config = base_config()
    status = update_ags_status(ags_config, hass)
    assert status == 'OFF'
    assert hass.data['ags_status'] == 'OFF'
