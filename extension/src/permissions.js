export const BROAD_ORIGINS = ["http://*/*", "https://*/*"];

export async function enableAllTabs(permissionsApi) {
  return permissionsApi.request({origins: BROAD_ORIGINS});
}

export async function disableAllTabs(permissionsApi) {
  const removed = await permissionsApi.remove({origins: BROAD_ORIGINS});
  const stillBroad = await permissionsApi.contains({origins: BROAD_ORIGINS});
  return {removed, stillBroad};
}

export async function reconcileModeAfterRemoval(permissionsApi, storageApi) {
  const broad = await permissionsApi.contains({origins: BROAD_ORIGINS});
  const {scanningMode} = await storageApi.get("scanningMode");
  if (!broad && scanningMode === "all_tabs") {
    await storageApi.set({scanningMode: "granted_sites"});
    return "granted_sites";
  }
  return scanningMode || "granted_sites";
}
