# Mobile release checklist

Walk this by hand on the TestFlight and Play internal-track builds before promoting one to production. The UI tests in `.github/workflows/mobile.yml` cover pairing, the LibraOS Engine screen, revocation and a loopback address on an emulator and a simulator; this covers real phones, real hosts and real networks.

For each phone (an iPhone and an Android phone), against each host (macOS, Windows and Linux), over each network (the same LAN, and Tailscale with the phone off the LAN):

| Check             | What passes                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pair              | Scan the code from `libraos-next pair` or Settings → Sharing & access; the environment appears on the phone.                                                                                                                                   |
| Continue a thread | Open a thread started on the computer and send a message; the reply streams on both.                                                                                                                                                           |
| Stop a turn       | Stop a running turn from the phone; the computer shows it stopped.                                                                                                                                                                             |
| LibraOS Engine    | Open the environment's LibraOS Engine screen: tasks by section, or "Set up LibraOS Engine on your computer" on a host without it. Stop shows only on a device paired with operate permission. Approvals are listed, to answer on the computer. |
| Revoke            | Revoke the phone on the host (Settings → Sharing & access); the phone is refused and has to pair again.                                                                                                                                        |
| Airplane mode     | Turn airplane mode on, then off; the phone reconnects without pairing again.                                                                                                                                                                   |

Once per platform:

- [ ] A fresh install, before and after pairing, makes no request except to the paired host (watch it with a proxy or the host's firewall log).
- [ ] The first screen asks to pair with your computer and says how.
- [ ] Settings → Notifications says notifications arrive while LibraOS Next is open.
