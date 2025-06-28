from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType
from homeassistant.helpers.restore_state import RestoreEntity

# New switch used to bypass the schedule entirely. When turned on the
# AGS service ignores the schedule entity and follows the media system
# switch state only.
class ScheduleOverrideSwitch(SwitchEntity, RestoreEntity):
    """Switch enabling schedule override."""

    _attr_should_poll = False
    _attr_name = "AGS Schedule Override"
    _attr_unique_id = "ags_schedule_override"

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._attr_is_on = hass.data.get(self._attr_unique_id, False)
        hass.data[self._attr_unique_id] = self._attr_is_on

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

    # Add the room switches and the global schedule override switch
    entities = [ScheduleOverrideSwitch(hass)]
    entities.extend(RoomSwitch(hass, room) for room in rooms)
    async_add_entities(entities)

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

    async def async_turn_off(self, **kwargs):
        """Turn the switch off."""
        self._attr_is_on = False
        self.hass.data[self._attr_unique_id] = False
        self.async_write_ha_state()

    async def async_added_to_hass(self):
        """Run when entity about to be added to hass."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state:
            self._attr_is_on = last_state.state == "on"
            self.hass.data[self._attr_unique_id] = self._attr_is_on

           
