import {BROAD_ORIGINS, disableAllTabs, enableAllTabs} from "./permissions.js";

const baseUrl = document.querySelector("#base-url");
const mode = document.querySelector("#mode");
const paused = document.querySelector("#paused");
const disclosure = document.querySelector("#disclosure");
const status = document.querySelector("#status");

const saved = await chrome.storage.local.get(["baseUrl", "scanningMode", "scanningPaused"]);
baseUrl.value = saved.baseUrl || "http://127.0.0.1:6477";
mode.value = saved.scanningMode || "granted_sites";
paused.checked = saved.scanningPaused || false;
await renderDisclosure();

document.querySelector("#save").addEventListener("click", async () => {
  if (mode.value === "all_tabs") {
    const granted = await enableAllTabs(chrome.permissions);
    if (!granted) { mode.value = "granted_sites"; status.textContent = "Broad permission was not granted."; return; }
  } else {
    const {removed, stillBroad} = await disableAllTabs(chrome.permissions);
    if (!removed && stillBroad) { mode.value = "all_tabs"; renderDisclosure(); status.textContent = "Chrome did not remove broad permission."; return; }
  }
  await chrome.storage.local.set({baseUrl: baseUrl.value, scanningMode: mode.value, scanningPaused: paused.checked});
  renderDisclosure();
  status.textContent = "Saved.";
});
document.querySelector("#scan").addEventListener("click", async () => { await chrome.runtime.sendMessage({type: "scan-now"}); status.textContent = "Scan requested."; });
document.querySelector("#pair").addEventListener("click", async () => { await chrome.runtime.sendMessage({type: "pair", displayName: "Chrome"}); status.textContent = "Pairing request sent. Approve it in Webby."; });
mode.addEventListener("change", renderDisclosure);

async function renderDisclosure() {
  const broad = await chrome.permissions.contains({origins: BROAD_ORIGINS});
  disclosure.hidden = mode.value !== "all_tabs" && !broad;
}
