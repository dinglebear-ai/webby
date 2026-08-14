export function eligibleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function sanitizePage(urlValue, title = "") {
  const url = new URL(urlValue);
  if (!eligibleUrl(url.href)) throw new Error("ineligible_url");
  return {
    url: `${url.origin}${url.pathname || "/"}`,
    title: String(title).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200)
  };
}

export async function canScanTab(tab, permissionsApi) {
  if (!tab?.id || tab.incognito || !eligibleUrl(tab.url)) return false;
  const origin = new URL(tab.url).origin + "/*";
  return permissionsApi.contains({origins: [origin]});
}

export function normalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > 64) return [];
  return tools.flatMap((tool) => {
    if (!tool || typeof tool.name !== "string" || tool.name.length < 1 || tool.name.length > 128) return [];
    let inputSchema = tool.inputSchema ?? tool.input_schema ?? {};
    if (typeof inputSchema === "string") {
      try { inputSchema = JSON.parse(inputSchema); } catch { return []; }
    }
    return [{
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description.slice(0, 1000) : "",
      input_schema: inputSchema
    }];
  }).sort((left, right) => left.name.localeCompare(right.name));
}
