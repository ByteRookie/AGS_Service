from __future__ import annotations

import logging

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType
from homeassistant.helpers.restore_state import RestoreEntity

from .ags_service import (
    get_active_rooms,
    ensure_action_queue,
    enqueue_media_action,
    update_ags_sensors,
    ags_select_source,
)
from . import ags_service as ags

import asyncio

_LOGGER = logging.getLogger(__name__)


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
    rooms = ags_config["rooms"]

    entities = [RoomSwitch(hass, room) for room in rooms]

    if ags_config.get("create_sensors"):
        entities.append(AGSActionsSwitch(hass))

    async_add_entities(entities)

    await ensure_action_queue(hass)

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
        rooms = self.hass.data["ags_service"]["rooms"]
        prev_active = get_active_rooms(rooms, self.hass)
        prev_primary = self.hass.data.get("primary_speaker")
        self._attr_is_on = True
        self.hass.data[self._attr_unique_id] = True
        self.async_write_ha_state()
        await self._maybe_join(
            first_room=len(prev_active) == 0,
            prev_primary=prev_primary,
        )

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

    async def _maybe_join(
        self,
        *,
        first_room: bool = False,
        prev_primary: str | None = None,
    ) -> None:
        """Join this room's speaker to the primary group if allowed."""
        while ags.AGS_SENSOR_RUNNING:
            await asyncio.sleep(0.05)
        await self.hass.async_add_executor_job(
            update_ags_sensors, self.hass.data["ags_service"], self.hass
        )
        current_status = self.hass.data.get("ags_status")
        if current_status == "OFF":
            return
        actions_enabled = self.hass.data.get("switch.ags_actions", True)
        if not actions_enabled:
            return
        primary = self.hass.data.get("primary_speaker")
        if not primary or primary == "none":
            primary = self.hass.data.get("preferred_primary_speaker")
        if not primary or primary == "none":
            return
        members = [
            d["device_id"]
            for d in self.room.get("devices", [])
            if d.get("device_type") == "speaker"
        ]
        if not members:
            return
        await enqueue_media_action(
            self.hass,
            "join",
            {"entity_id": primary, "group_members": members},
        )
        if first_room:
            if current_status == "ON TV":
                preferred = self.hass.data.get("preferred_primary_speaker")
                if preferred and preferred != "none":
                    await enqueue_media_action(
                        self.hass,
                        "select_source",
                        {"entity_id": preferred, "source": "TV"},
                    )
            elif not prev_primary or prev_primary == "none":
                await ags_select_source(
                    self.hass.data["ags_service"],
                    self.hass,
                )
        while ags.AGS_SENSOR_RUNNING:
            await asyncio.sleep(0.05)
        await self.hass.async_add_executor_job(
            update_ags_sensors, self.hass.data["ags_service"], self.hass
        )

    async def _maybe_unjoin(self) -> None:
        """Unjoin this room's speaker from any group if allowed."""
        while ags.AGS_SENSOR_RUNNING:
            await asyncio.sleep(0.05)
        await self.hass.async_add_executor_job(
            update_ags_sensors, self.hass.data["ags_service"], self.hass
        )
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
        await enqueue_media_action(self.hass, "unjoin", {"entity_id": members})

        has_tv = any(d.get("device_type") == "tv" for d in self.room.get("devices", []))
        if has_tv and not self.hass.data["ags_service"].get("disable_Tv_Source"):
            await enqueue_media_action(self.hass, "delay", {"seconds": 0.5})
            for member in members:
                await enqueue_media_action(
                    self.hass,
                    "select_source",
                    {"entity_id": member, "source": "TV"},
                )

        rooms = self.hass.data["ags_service"]["rooms"]
        active_rooms = get_active_rooms(rooms, self.hass)
        if not active_rooms:
            await enqueue_media_action(self.hass, "media_stop", {"entity_id": members})

        while ags.AGS_SENSOR_RUNNING:
            await asyncio.sleep(0.05)
        await self.hass.async_add_executor_job(
            update_ags_sensors, self.hass.data["ags_service"], self.hass
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



           
