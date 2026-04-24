"""Hermes Voice dashboard plugin.

This plugin intentionally registers no CLI/gateway tools or hooks. It exists so
Hermes can install and manage the dashboard extension as a normal user plugin.
"""


def register(ctx):
    """Dashboard-only plugin entrypoint."""
    return None
