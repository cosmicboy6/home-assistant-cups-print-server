"""Sidebar panel for the CUPS Print Server integration.

Registers a small custom frontend panel so the integration shows up as its own
page in the Home Assistant sidebar ("CUPS Print Server"). The page lists every
CUPS printer queue with its sensors and the power-management controls.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

_FRONTEND_DIR = Path(__file__).parent / "frontend"
_STATIC_URL = "/cups_print_server_frontend"
_MODULE_URL = f"{_STATIC_URL}/cups-print-server-panel.js"
_ELEMENT = "cups-print-server-panel"
_PANEL_URL = "cups-print-server"
_PANEL_TITLE = "CUPS Print Server"
_PANEL_ICON = "mdi:printer"

_DATA_STATIC = f"{DOMAIN}_panel_static"
_DATA_PANEL = f"{DOMAIN}_panel_registered"
_DATA_ENTRIES = f"{DOMAIN}_panel_entries"


async def async_register_panel(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Register the static path and the sidebar panel (once)."""
    if not hass.data.get(_DATA_STATIC):
        try:
            await hass.http.async_register_static_paths(
                [StaticPathConfig(_STATIC_URL, str(_FRONTEND_DIR), False)]
            )
            hass.data[_DATA_STATIC] = True
        except Exception as err:  # noqa: BLE001 - path may already exist
            _LOGGER.debug("Static path %s not registered: %s", _STATIC_URL, err)
            hass.data[_DATA_STATIC] = True

    hass.data.setdefault(_DATA_ENTRIES, set()).add(entry.entry_id)

    if hass.data.get(_DATA_PANEL):
        return

    frontend.async_register_built_in_panel(
        hass,
        component_name="custom",
        sidebar_title=_PANEL_TITLE,
        sidebar_icon=_PANEL_ICON,
        frontend_url_path=_PANEL_URL,
        config={
            "_panel_custom": {
                "name": _ELEMENT,
                "module_url": _MODULE_URL,
                "embed_iframe": False,
                "trust_external": False,
            }
        },
        require_admin=False,
    )
    hass.data[_DATA_PANEL] = True


def async_remove_panel(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Remove the panel once the last config entry is unloaded."""
    entries = hass.data.get(_DATA_ENTRIES)
    if entries is None:
        return

    entries.discard(entry.entry_id)

    if entries:
        return

    if hass.data.get(_DATA_PANEL):
        frontend.async_remove_panel(hass, _PANEL_URL)
        hass.data[_DATA_PANEL] = False
