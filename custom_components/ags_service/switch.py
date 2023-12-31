from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType
from homeassistant.helpers.restore_state import RestoreEntity

# Setup platform function
def setup_platform(
    hass: HomeAssistant,
    config: ConfigType,
    add_entities: AddEntitiesCallback,
    discovery_info: DiscoveryInfoType | None = None
) -> None:
    """Set up the switch platform."""
    # Retrieve the room information from the shared data
    ags_config = hass.data['ags_service']
    rooms = ags_config['rooms']

    # Add the switch entities
    add_entities([RoomSwitch(hass, room) for room in rooms] )

class RoomSwitch(SwitchEntity, RestoreEntity):
    """Representation of a Switch for each Room."""

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

    def turn_on(self, **kwargs):
        """Turn the switch on."""
        self._attr_is_on = True
        self.hass.data[self._attr_unique_id] = True
        self.async_schedule_update_ha_state()

    def turn_off(self, **kwargs):
        """Turn the switch off."""
        self._attr_is_on = False
        self.hass.data[self._attr_unique_id] = False
        self.async_schedule_update_ha_state()

    async def async_added_to_hass(self):
        """Run when entity about to be added to hass."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state:
            self._attr_is_on = last_state.state == "on"
            self.hass.data[self._attr_unique_id] = self._attr_is_on

           
