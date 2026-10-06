import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

type State = { creates: Array<Record<string, any>>; uploads: Buffer[]; completions: number; routes: string[] };
async function mock(page: Page, catalog = false) {
  const state: State = { creates: [], uploads: [], completions: 0, routes: [] };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()); const p = url.pathname; state.routes.push(p);
    let body: any = {}; let status = 200;
    if (p === "/api/session") body = { user: { id: "browser-user", email: "browser@example.test", name: "Browser User", role: "admin" }, csrfToken: "browser-csrf", bootstrapAvailable: false };
    else if (p === "/api/creative/capabilities") body = { catalogMusic: catalog };
    else if (p === "/api/publications" && request.method() === "POST") { const data = request.postDataJSON(); state.creates.push(data); body = { id: "draft", status: "uploading", uploads: data.media.map((_: unknown, index: number) => ({ mediaId: "media-" + index, url: "unused" })) }; status = 201; }
    else if (/\/uploads\/[^/]+\/complete$/.test(p)) body = { ok: true };
    else if (/\/uploads\/[^/]+$/.test(p)) body = { uploaded: false, url: `http://127.0.0.1:8789/upload/${p.split('/').pop()}` };
    else if (p === "/api/publications/draft/complete") { state.completions++; body = { status: "queued" }; status = 202; }
    else if (p === "/api/music") body = { items: [{ id: "123", title: "Catalog test track", artist: "Test artist", durationMs: 10000, hasPreview: false }] };
    else if (p === "/api/admin/meta-connection") body = { appConfigured: false, connected: false, catalogMusic: false, redirectUri: "https://baghharu.neerrn.com/api/auth/meta/callback" };
    else body = { items: [] };
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/upload/**", async route => { state.uploads.push(route.request().postDataBuffer()!); await route.fulfill({ status: 200, body: "" }); });
  return state;
}
async function photo(page: Page, label = "Choose media", mime = "image/jpeg", name = "test-photo.jpg") {
  const bytes = await page.evaluate(async mime => { const c = document.createElement("canvas"); c.width = 800; c.height = 1000; const ctx = c.getContext("2d")!; ctx.fillStyle = "#1d5c54"; ctx.fillRect(0, 0, 800, 1000); return [...new Uint8Array(await (await new Promise<Blob>(r => c.toBlob(b => r(b!), mime))).arrayBuffer())]; }, mime);
  await page.getByLabel(label, { exact: true }).setInputFiles({ name, mimeType: mime, buffer: Buffer.from(bytes) });
  await expect(page.locator(".composer-media-item")).not.toHaveCount(0);
  await expect(page.getByRole("button", { name: "Publish to Instagram" })).toBeEnabled();
  return Buffer.from(bytes);
}
test("Story mentions move without zoom controls and preserve original JPEG bytes", async ({ page }) => {
  const state = await mock(page), errors: string[] = []; page.on("pageerror", e => errors.push(e.name));
  await page.goto("/new"); await page.getByRole("button", { name: "◌ Story", exact: true }).click(); const original = await photo(page);
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("button", { name: /Edit · Aa/ })).toHaveCount(0);
  await page.getByRole("button", { name: "@ Mention people", exact: true }).click();
  await page.getByLabel("Instagram username").fill("@classmate"); await page.getByRole("button", { name: "Add mention", exact: true }).click();
  const marker = page.getByRole("button", { name: "Position @classmate", exact: true }); await marker.focus(); await page.keyboard.press("ArrowLeft");
  await expect(page.getByLabel("Preview zoom")).toHaveCount(0); await expect(page.getByText("Placement preview", { exact: true })).toBeVisible(); const rect = await page.locator(".tags-media").boundingBox();
  const current = await marker.boundingBox(); await page.mouse.move(current!.x + current!.width / 2, current!.y + current!.height / 2); await page.mouse.down(); await page.mouse.move(rect!.x + rect!.width * .4, rect!.y + rect!.height * .6); await page.mouse.up();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/insta-simple-mentions.png" });
  await page.getByRole("button", { name: "Save mentions", exact: true }).click(); await page.getByRole("button", { name: "Publish to Instagram" }).click(); await expect(page).toHaveURL(/\/submissions$/);
  const tag = state.creates[0].media[0].options.tags[0]; expect(tag.username).toBe("classmate"); expect(tag.x).toBeCloseTo(.4, 2); expect(tag.y).toBeCloseTo(.6, 2);
  expect(state.uploads[0]).toEqual(original); expect(errors).toEqual([]); expect(state.routes.some(p => p.includes("media-engine"))).toBe(false);
});
test("automatic PNG conversion preserves framing without opening an editor", async ({ page }) => {
  const state = await mock(page); await page.goto("/new"); await photo(page, "Choose media", "image/png", "phone.png");
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("button", { name: /Crop|Stickers|Filters|Draw|Sunrise/ })).toHaveCount(0);
  const dimensions = await page.locator(".creative-preview img.preview-media").evaluate(async e => { const img = e as HTMLImageElement; await img.decode(); return [img.naturalWidth, img.naturalHeight]; }); expect(dimensions).toEqual([800, 1000]);
  await page.getByRole("button", { name: "Publish to Instagram" }).click(); await expect(page).toHaveURL(/\/submissions$/); expect(state.creates[0].media[0].mimeType).toBe("image/jpeg"); expect(state.uploads[0].subarray(0, 3)).toEqual(Buffer.from([255,216,255]));
});
test("tagging validates duplicates, supports removal and cancellation, and traps focus", async ({ page }) => {
  const state = await mock(page); await page.goto("/new"); await photo(page); await page.getByRole("button", { name: "Tag people", exact: true }).click();
  await page.getByLabel("Instagram username").fill("bad name"); await page.getByRole("button", { name: "Add person", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("Enter an Instagram username");
  await page.getByLabel("Instagram username").fill("friend"); await page.getByRole("button", { name: "Add person", exact: true }).click();
  await page.getByLabel("Instagram username").fill("FRIEND"); await page.getByRole("button", { name: "Add person", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("already added");
  await page.getByRole("button", { name: "Remove @friend", exact: true }).click(); await expect(page.locator(".person-marker")).toHaveCount(0);
  await page.getByLabel("Instagram username").fill("cancelled_friend"); await page.getByRole("button", { name: "Add person", exact: true }).click();
  await page.getByRole("button", { name: "Save tags", exact: true }).focus(); await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "Close mentions" })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("button", { name: "Tag people", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Publish to Instagram" }).click(); await expect(page).toHaveURL(/\/submissions$/); expect(state.creates[0].media[0].options.tags).toEqual([]);
});
test("saved drafts retain native tags and captions across reloads", async ({ page }) => {
  await mock(page); await page.goto("/new"); await photo(page); await page.getByRole("button", { name: "Tag people", exact: true }).click();
  await page.getByLabel("Instagram username").fill("friend"); await page.getByRole("button", { name: "Add person", exact: true }).click(); await page.getByRole("button", { name: "Save tags", exact: true }).click();
  await page.getByLabel("Caption", { exact: true }).fill("Saved caption @friend"); await page.getByRole("button", { name: "Save draft", exact: true }).click(); await expect(page.getByText("Draft saved on this device. You can come back later.")).toBeVisible();
  await page.reload(); await page.getByRole("button", { name: /Drafts/ }).click(); await page.locator(".draft-row button").first().click();
  await expect(page.getByLabel("Caption", { exact: true })).toHaveValue("Saved caption @friend"); await expect(page.locator(".preview-tag-label")).toHaveText("@friend");
});
test("carousel reorders native tags with their photos and retains collaborator settings", async ({ page }) => {
  const state = await mock(page); await page.goto("/new"); await page.getByRole("button", { name: "▣ Carousel", exact: true }).click(); await photo(page);
  await page.getByRole("button", { name: "Publish to Instagram" }).click(); await expect(page.getByRole("alert")).toContainText("at least two");
  await page.getByRole("button", { name: "Tag people", exact: true }).click(); await page.getByLabel("Instagram username").fill("first_friend"); await page.getByRole("button", { name: "Add person", exact: true }).click(); await page.getByRole("button", { name: "Save tags", exact: true }).click();
  await photo(page, "Add carousel media", "image/jpeg", "second.jpg"); await expect(page.locator(".composer-media-item")).toHaveCount(2); await page.getByRole("button", { name: "Move item 2 earlier" }).click();
  await page.getByText("Invite collaborators", { exact: true }).click(); await page.getByLabel("Collaborators").fill("@collab_friend");
  await page.getByRole("button", { name: "Publish to Instagram" }).click(); await expect(page).toHaveURL(/\/submissions$/);
  expect(state.creates[0].media[0].name).toBe("second.jpg"); expect(state.creates[0].media[1].options.tags[0].username).toBe("first_friend"); expect(state.creates[0].options.collaborators).toEqual(["collab_friend"]); expect(state.uploads).toHaveLength(2);
});
test("catalog selection keeps the exact audio ID, volume, Reel cover and feed sharing", async ({ page }) => {
  const state = await mock(page, true); await page.goto("/new"); await page.getByRole("button", { name: "▷ Reel", exact: true }).click();
  await expect(page.getByText("Edit first, upload here", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Instagram Edits" })).toHaveAttribute("href", "https://creators.instagram.com/edits");
  const original = Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109]);
  await page.getByLabel("Choose media", { exact: true }).setInputFiles({ name: "video.mp4", mimeType: "video/mp4", buffer: original });
  await page.getByRole("button", { name: /Instagram music/ }).click(); await page.getByLabel("Search Instagram music").fill("test"); await page.getByRole("button", { name: "Search", exact: true }).click(); await page.getByRole("button", { name: /Catalog test track/ }).click();
  await page.getByLabel("Original video volume").fill("25"); await page.getByLabel("Catalog music volume").fill("80");
  await page.getByText("Reel cover & feed sharing", { exact: true }).click(); await page.getByLabel("Reel cover frame").fill("1.2"); await page.getByLabel("Also share to feed").uncheck();
  await page.getByRole("button", { name: "Publish to Instagram" }).click(); await expect(page).toHaveURL(/\/submissions$/); expect(state.creates[0].options).toMatchObject({ coverFrameMs: 1200, shareToFeed: false, audio: { id: "123", volume: 80, videoVolume: 25 } }); expect(state.uploads[0]).toEqual(original);
});
test("missing songs show a clear fallback without changing the selected media", async ({ page }) => {
  const state = await mock(page, true);
  await page.route("**/api/music?*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) }));
  await page.goto("/new"); await page.getByRole("button", { name: "▷ Reel", exact: true }).click();
  const original = Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109]);
  await page.getByLabel("Choose media", { exact: true }).setInputFiles({ name: "finished-video.mp4", mimeType: "video/mp4", buffer: original });
  await page.getByRole("button", { name: /Instagram music/ }).click();
  await page.getByLabel("Search Instagram music").fill("unavailable song"); await page.getByLabel("Search Instagram music").press("Enter");
  expect(state.creates).toHaveLength(0);
  await expect(page.getByRole("status")).toContainText("No matching tracks in this catalog");
  await expect(page.getByText(/Music in the exported video may appear as original audio/)).toBeVisible();
  await page.getByRole("button", { name: "Publish to Instagram" }).click(); await expect(page).toHaveURL(/\/submissions$/);
  expect(state.creates[0].options.audio).toBeUndefined(); expect(state.uploads[0]).toEqual(original);
});
test("Instagram-only setup explains Facebook requirements without offering fabricated music", async ({ page }) => {
  const state = await mock(page); await page.goto("/new"); await page.getByRole("button", { name: "▷ Reel", exact: true }).click(); await page.getByRole("button", { name: /Instagram music/ }).click();
  await expect(page.getByText("Instagram catalog connection needed", { exact: true })).toBeVisible(); await expect(page.getByLabel("Search Instagram music")).toHaveCount(0); await expect(page.getByRole("button", { name: /Sunrise|Celebrate|After class/ })).toHaveCount(0);
  for (const name of ["◌ Story", "▧ Post", "▣ Carousel"]) { await page.getByRole("button", { name, exact: true }).click(); await expect(page.getByRole("button", { name: /Instagram music/ })).toHaveCount(0); }
  await page.goto("/admin"); await expect(page.getByLabel("Meta app secret")).toHaveCount(0); await expect(page.getByLabel("Meta App ID")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect Facebook Login", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(state.creates).toHaveLength(0);
});
test("interrupted submission retries without uploading the same media again", async ({ page }) => {
  const state = await mock(page); let attempts = 0;
  await page.route("**/api/publications/draft/complete", async route => { attempts++; await route.fulfill({ status: attempts === 1 ? 503 : 202, contentType: "application/json", body: JSON.stringify(attempts === 1 ? { message: "Temporary failure" } : { status: "queued" }) }); });
  await page.goto("/new"); await photo(page); await page.getByRole("button", { name: "Publish to Instagram" }).click(); await expect(page).toHaveURL(/\/submissions$/); expect(attempts).toBe(2); expect(state.uploads).toHaveLength(1); expect(state.creates).toHaveLength(1);
});
