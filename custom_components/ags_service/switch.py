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
    ags_config = hass.data['ags_service']
    rooms = ags_config['rooms']

    # Add the switch entities
    add_entities([RoomSwitch(hass, room) for room in rooms] + [MediaSystemSwitch(hass)])

class RoomSwitch(SwitchEntity):
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

    def turn_off(self, **kwargs):
        """Turn the switch off."""
        self._attr_is_on = False
        self.hass.data[self._attr_unique_id] = False


class MediaSystemSwitch(SwitchEntity):
    """Representation of a Switch for the Media System."""

    _attr_name = "Media System"
    _attr_unique_id = "switch.media_system"

    def __init__(self, hass):
        """Initialize the switch."""
        self.hass = hass
        # Check if the state is already stored in hass.data
        if 'switch_media_system_state' in hass.data:
            self._attr_is_on = hass.data['switch_media_system_state']
        else:
            self._attr_is_on = False
            hass.data['switch_media_system_state'] = False  # Initialize in hass.data

    @property
    def is_on(self):
        """Return true if the switch is on."""
        return self._attr_is_on

    def turn_on(self, **kwargs):
        """Turn the switch on."""
        self._attr_is_on = True
        self.hass.data['switch_media_system_state'] = True

    def turn_off(self, **kwargs):
        """Turn the switch off."""
        self._attr_is_on = False
        self.hass.data['switch_media_system_state'] = False
