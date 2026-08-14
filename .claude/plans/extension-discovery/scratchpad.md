# Scratchpad

- Default scanning mode must not request new host access.
- All-tabs requires a user gesture and Chrome optional host permission request.
- Persist origin + sanitized path only; never query, fragment, credentials, page contents, results, form values, cookies, or request bodies.
- Discovery uniqueness: browser + origin + sanitized path + catalog fingerprint.
- Extension probe must feature-detect the live WebMCP API and return unsupported when it cannot enumerate a catalog.

## Live verification

- Chromium loaded the unpacked MV3 extension and exposed its service worker.
- The extension joined the loopback Phoenix pairing topic on port 6480.
- The popup submitted a pairing request; the local LiveView approved it.
- The extension reconnected with the durable browser ID, signed the Ed25519 challenge, authenticated, synchronized scanning settings, and completed `browser.resync`.
- Chromium 150 exposed the real `document.modelContext.getTools()` draft API and accepted a live registered tool. A fully automated host-permission prompt was not bypassed; granted-sites enforcement remained intact.
