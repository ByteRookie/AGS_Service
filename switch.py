"""Platform for switch integration."""
from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType

# Setup platform function
def setup_platform(
    hass: HomeAssistant,
    config: ConfigType,
    add_entities: AddEntitiesCallback,
    discovery_info: DiscoveryInfoType | None = None
) -> None:
    """Set up the switch platform."""
    # Retrieve the room information from the shared data
    rooms = hass.data['ags_service']
    # Add the switch entities
    add_entities([RoomSwitch(room) for room in rooms])

class RoomSwitch(SwitchEntity):
    """Representation of a Switch for each Room."""

    def __init__(self, room):
        """Initialize the switch."""
        self.room = room
        self._attr_name = f"{room['room']} Media"
        self._attr_is_on = False
        self._attr_unique_id = f"switch.{room['room'].lower().replace(' ', '_')}_media"

    @property
    def is_on(self):
        """Return true if the switch is on."""
        return self._attr_is_on

    def turn_on(self, **kwargs):
        """Turn the switch on."""
        self._attr_is_on = True

    def turn_off(self, **kwargs):
        """Turn the switch off."""
        self._attr_is_on = False
