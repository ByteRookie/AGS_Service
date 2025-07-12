"""Constants for AGS Service."""
from __future__ import annotations

import voluptuous as vol
from homeassistant.helpers import config_validation as cv

DOMAIN = "ags_service"

CONF_ROOM = "room"
CONF_ROOMS = "rooms"
CONF_DEVICE_ID = "device_id"
CONF_DEVICE_TYPE = "device_type"
CONF_PRIORITY = "priority"
CONF_OVERRIDE_CONTENT = "override_content"
CONF_DISABLE_ZONE = "disable_zone"
CONF_HOMEKIT_PLAYER = "homekit_player"
CONF_CREATE_SENSORS = "create_sensors"
CONF_DEFAULT_ON = "default_on"
CONF_STATIC_NAME = "static_name"
CONF_DISABLE_TV_SOURCE = "disable_Tv_Source"
CONF_INTERVAL_SYNC = "interval_sync"
CONF_SCHEDULE_ENTITY = "schedule_entity"
CONF_OTT_DEVICE = "ott_device"
CONF_OTT_DEVICES = "ott_devices"
CONF_TV_INPUT = "tv_input"
CONF_SOURCES = "Sources"
CONF_SOURCE = "Source"
CONF_MEDIA_CONTENT_TYPE = "media_content_type"
CONF_SOURCE_VALUE = "Source_Value"
CONF_SOURCE_DEFAULT = "source_default"

DEVICE_SCHEMA = vol.Schema({
    vol.Required(CONF_ROOMS): vol.All(
        cv.ensure_list,
        [
            vol.Schema(
                {
                    vol.Required(CONF_ROOM): cv.string,
                    vol.Required("devices"): vol.All(
                        cv.ensure_list,
                        [
                            vol.Schema(
                                {
                                    vol.Required(CONF_DEVICE_ID): cv.string,
                                    vol.Required(CONF_DEVICE_TYPE): cv.string,
                                    vol.Required(CONF_PRIORITY): cv.positive_int,
                                    vol.Optional(CONF_OVERRIDE_CONTENT): cv.string,
                                    vol.Optional(CONF_OTT_DEVICES): vol.All(
                                        cv.ensure_list,
                                        [
                                            vol.Schema(
                                                {
                                                    vol.Required(CONF_OTT_DEVICE): cv.string,
                                                    vol.Required(CONF_TV_INPUT): cv.string,
                                                    vol.Optional("default", default=False): cv.boolean,
                                                }
                                            )
                                        ],
                                    ),
                                }
                            )
                        ],
                    ),
                }
            )
        ],
    ),
    vol.Required(CONF_SOURCES): vol.All(
        cv.ensure_list,
        [
            vol.Schema(
                {
                    vol.Required(CONF_SOURCE): cv.string,
                    vol.Required(CONF_SOURCE_VALUE): cv.string,
                    vol.Required(CONF_MEDIA_CONTENT_TYPE): cv.string,
                    vol.Optional(CONF_SOURCE_DEFAULT, default=False): cv.boolean,
                }
            )
        ],
    ),
    vol.Optional(CONF_DISABLE_ZONE, default=False): cv.boolean,
    vol.Optional(CONF_HOMEKIT_PLAYER, default=None): cv.string,
    vol.Optional(CONF_CREATE_SENSORS, default=False): cv.boolean,
    vol.Optional(CONF_DEFAULT_ON, default=False): cv.boolean,
    vol.Optional(CONF_STATIC_NAME, default=None): cv.string,
    vol.Optional(CONF_DISABLE_TV_SOURCE, default=False): cv.boolean,
    vol.Optional(CONF_INTERVAL_SYNC, default=30): cv.positive_int,
    vol.Optional(CONF_SCHEDULE_ENTITY): vol.Schema({
        vol.Required("entity_id"): cv.string,
        vol.Optional("on_state", default="on"): cv.string,
        vol.Optional("off_state", default="off"): cv.string,
        vol.Optional("schedule_override", default=False): cv.boolean,
    }),
})
