# Voice plugin installed

## Next steps

1. Enable it if you did not install with `--enable`:
   ```bash
   hermes plugins enable voice
   ```
2. Restart the gateway/dashboard process:
   ```bash
   hermes gateway restart
   ```
3. Open the Hermes dashboard and look for the **Voice** tab.

## What you get

- mobile-first browser voice chat
- persistent voice session continuity across turns
- replay and new-session controls
- one-tap transfer into Telegram / any `send_message` target

## Notes

- Set your own transfer target in Voice settings before using the handoff button.
- Browser microphone permission is required.
