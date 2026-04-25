from __future__ import annotations

import logging

from homeassistant.components.switch import SwitchEntity
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType
from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .ags_service import (
    ensure_action_queue,
    update_ags_sensors,
)

# Import the signal and domain
from . import DOMAIN, SIGNAL_AGS_RELOAD

_LOGGER = logging.getLogger(__name__)


def schedule_ags_update_after_start(hass: HomeAssistant, config_provider) -> None:
    """Schedule AGS updates after HA startup without blocking entity restore."""
    async def _refresh():
        try:
            if DOMAIN in hass.data:
                await update_ags_sensors(config_provider(), hass)
        except Exception as err:
            _LOGGER.debug("Deferred AGS switch refresh failed: %s", err)

    async def _after_started(_event=None):
        await _refresh()

    if getattr(hass, "is_running", False):
        hass.async_create_task(_after_started())
    else:
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _after_started)


# Setup platform function
async def async_setup_platform(
    hass: HomeAssistant,
    config: ConfigType,
    async_add_entities: AddEntitiesCallback,
    discovery_info: DiscoveryInfoType | None = None
) -> None:
    """Set up the switch platform."""
    # Retrieve the room information from the shared data
    ags_config = hass.data[DOMAIN]

    # Track which rooms already have switches
    added_room_switches = set()
    reload_unsub = None
    cleanup_done = False

    def cleanup_reload_listener():
        nonlocal cleanup_done
        if cleanup_done:
            return
        cleanup_done = True
        if reload_unsub:
            reload_unsub()

    @callback
    def async_discover_switches():
        """Discover and add new room switches dynamically."""
        if DOMAIN not in hass.data or "rooms" not in hass.data[DOMAIN]:
            return

        new_entities = []
        rooms = hass.data[DOMAIN]["rooms"]

        for room in rooms:
            safe_room_id = "".join(c for c in room['room'].lower().replace(' ', '_') if c.isalnum() or c == '_')
            while "__" in safe_room_id:
                safe_room_id = safe_room_id.replace("__", "_")
            unique_id = f"switch.{safe_room_id}_media"
            if unique_id not in added_room_switches:
                entity = RoomSwitch(hass, room)
                entity.async_on_remove(cleanup_reload_listener)
                new_entities.append(entity)
                added_room_switches.add(unique_id)

        if new_entities:
            async_add_entities(new_entities)

    # Initial setup
    async_discover_switches()

    if ags_config.get("create_sensors"):
        actions_switch = AGSActionsSwitch(hass)
        actions_switch.async_on_remove(cleanup_reload_listener)
        async_add_entities([actions_switch])

    # Phase 2: Hot-Reload Engine
    # Listen for reload signal to add new rooms dynamically
    reload_unsub = async_dispatcher_connect(hass, SIGNAL_AGS_RELOAD, async_discover_switches)

    await ensure_action_queue(hass)


async def async_setup_entry(
    hass: HomeAssistant,
    entry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the switch platform from a config entry."""
    await async_setup_platform(hass, {}, async_add_entities)

class RoomSwitch(SwitchEntity, RestoreEntity):
    """Representation of a Switch for each Room."""

    _attr_should_poll = False

    def __init__(self, hass, room):
        """Initialize the switch."""
        self.hass = hass
        self.room = room
        self._attr_name = f"{room['room']} Media"

        # Use a safe slugified version for internal keys and force the entity_id
        safe_room_id = "".join(c for c in room['room'].lower().replace(' ', '_') if c.isalnum() or c == '_')
        while "__" in safe_room_id:
            safe_room_id = safe_room_id.replace("__", "_")
        self.entity_id = f"switch.{safe_room_id}_media"
        self._attr_unique_id = self.entity_id

        # Check if the state is already stored in hass.data
        switch_key = self._attr_unique_id
        if switch_key in hass.data:
            self._attr_is_on = hass.data[switch_key]
        else:
            self._attr_is_on = False
            hass.data[switch_key] = False  # Initialize in hass.data

    @property
    def is_on(self):
        """Return true if the switch is on."""
        return self._attr_is_on

    async def async_turn_on(self, **kwargs):
        """Turn the switch on."""
        self._attr_is_on = True
        self.hass.data[self._attr_unique_id] = True
        self.async_write_ha_state()
        await update_ags_sensors(self.hass.data[DOMAIN], self.hass)

    async def async_turn_off(self, **kwargs):
        """Turn the switch off."""
        self._attr_is_on = False
        self.hass.data[self._attr_unique_id] = False
        self.async_write_ha_state()
        await update_ags_sensors(self.hass.data[DOMAIN], self.hass)

    async def async_added_to_hass(self):
        """Run when entity about to be added to hass."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state:
            self._attr_is_on = last_state.state == "on"
            self.hass.data[self._attr_unique_id] = self._attr_is_on
        schedule_ags_update_after_start(
            self.hass,
            lambda: self.hass.data[DOMAIN],
        )

class AGSActionsSwitch(SwitchEntity, RestoreEntity):
    """Global switch controlling join/unjoin actions."""

    _attr_should_poll = False

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._attr_name = "AGS Actions"
        self._attr_unique_id = "switch.ags_actions"
        if self._attr_unique_id in hass.data:
            self._attr_is_on = hass.data[self._attr_unique_id]
        else:
            self._attr_is_on = True
            hass.data[self._attr_unique_id] = True

    @property
    def is_on(self) -> bool:
        return self._attr_is_on

    async def async_turn_on(self, **kwargs) -> None:
        self._attr_is_on = True
        self.hass.data[self._attr_unique_id] = True
        self.async_write_ha_state()
        await update_ags_sensors(self.hass.data[DOMAIN], self.hass)

    async def async_turn_off(self, **kwargs) -> None:
        self._attr_is_on = False
        self.hass.data[self._attr_unique_id] = False
        self.async_write_ha_state()
        await update_ags_sensors(self.hass.data[DOMAIN], self.hass)

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state:
            self._attr_is_on = last_state.state == "on"
            self.hass.data[self._attr_unique_id] = self._attr_is_on
        schedule_ags_update_after_start(
            self.hass,
            lambda: self.hass.data[DOMAIN],
        )



