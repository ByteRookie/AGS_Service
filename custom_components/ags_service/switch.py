from __future__ import annotations

import asyncio
import logging

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType
from homeassistant.helpers.restore_state import RestoreEntity

from .ags_service import get_active_rooms

_LOGGER = logging.getLogger(__name__)

_ACTION_QUEUE: asyncio.Queue | None = None
_ACTION_WORKER: asyncio.Task | None = None

async def _action_worker(hass: HomeAssistant) -> None:
    """Process join/unjoin requests sequentially."""
    while True:
        service, data = await _ACTION_QUEUE.get()
        try:
            await hass.services.async_call("media_player", service, data)
        except Exception as exc:  # pragma: no cover - safety net
            _LOGGER.warning("Failed media action %s: %s", service, exc)
        _ACTION_QUEUE.task_done()

# Setup platform function
async def async_setup_platform(
    hass: HomeAssistant,
    config: ConfigType,
    async_add_entities: AddEntitiesCallback,
    discovery_info: DiscoveryInfoType | None = None
) -> None:
    """Set up the switch platform."""
    # Retrieve the room information from the shared data
    ags_config = hass.data["ags_service"]
    global _ACTION_QUEUE, _ACTION_WORKER

    rooms = ags_config["rooms"]

    entities = [RoomSwitch(hass, room) for room in rooms]

    if ags_config.get("create_sensors"):
        entities.append(AGSActionsSwitch(hass))

    async_add_entities(entities)

    if _ACTION_QUEUE is None:
        _ACTION_QUEUE = asyncio.Queue()
        _ACTION_WORKER = hass.loop.create_task(_action_worker(hass))

class RoomSwitch(SwitchEntity, RestoreEntity):
    """Representation of a Switch for each Room."""

    _attr_should_poll = False

    def __init__(self, hass, room):
        """Initialize the switch."""
        self.hass = hass
        self.room = room
        self._attr_name = f"{room['room']} Media"
        self._attr_unique_id = f"switch.{room['room'].lower().replace(' ', '_')}_media"

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
        await self._maybe_join()

    async def async_turn_off(self, **kwargs):
        """Turn the switch off."""
        self._attr_is_on = False
        self.hass.data[self._attr_unique_id] = False
        self.async_write_ha_state()
        await self._maybe_unjoin()

    async def async_added_to_hass(self):
        """Run when entity about to be added to hass."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state:
            self._attr_is_on = last_state.state == "on"
            self.hass.data[self._attr_unique_id] = self._attr_is_on

    async def _maybe_join(self) -> None:
        """Join this room's speaker to the primary group if allowed."""
        if self.hass.data.get("ags_status") == "OFF":
            return
        actions_enabled = self.hass.data.get("switch.ags_actions", True)
        if not actions_enabled:
            return
        primary = self.hass.data.get("primary_speaker")
        if not primary or primary == "none":
            return
        members = [
            d["device_id"]
            for d in self.room.get("devices", [])
            if d.get("device_type") == "speaker"
        ]
        if not members:
            return
        await _ACTION_QUEUE.put(("join", {"entity_id": primary, "group_members": members}))

    async def _maybe_unjoin(self) -> None:
        """Unjoin this room's speaker from any group if allowed."""
        if self.hass.data.get("ags_status") == "OFF":
            return
        actions_enabled = self.hass.data.get("switch.ags_actions", True)
        if not actions_enabled:
            return
        members = [
            d["device_id"]
            for d in self.room.get("devices", [])
            if d.get("device_type") == "speaker"
        ]
        if not members:
            return
        await _ACTION_QUEUE.put(("unjoin", {"entity_id": members}))
        rooms = self.hass.data["ags_service"]["rooms"]
        active_rooms = get_active_rooms(rooms, self.hass)
        if not active_rooms:
            await _ACTION_QUEUE.put(("media_pause", {"entity_id": members}))
            await _ACTION_QUEUE.put(("clear_playlist", {"entity_id": members}))


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

    async def async_turn_off(self, **kwargs) -> None:
        self._attr_is_on = False
        self.hass.data[self._attr_unique_id] = False
        self.async_write_ha_state()

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state:
            self._attr_is_on = last_state.state == "on"
            self.hass.data[self._attr_unique_id] = self._attr_is_on



           
