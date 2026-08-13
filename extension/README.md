# Webby Chrome extension

Load this directory as an unpacked Manifest V3 extension during development. The extension connects directly to the loopback Webby Phoenix Channel; it has no Labby dependency.

The default `granted_sites` mode scans only tabs whose origin Chrome already permits. Invoking Webby on the current tab grants a one-tab `activeTab` scan from that explicit user gesture without broadening background access. Selecting `all_tabs` from the popup triggers Chrome's optional-host-permission prompt and shows a persistent warning. Returning to granted-sites mode removes the broad permission.

Discovery feature-detects `document.modelContext.getTools()` in the page main world. Unsupported pages are ignored; Webby does not emulate WebMCP with DOM automation.
