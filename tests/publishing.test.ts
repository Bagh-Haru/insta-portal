import { env } from "cloudflare:workers";
import type { MessageBatch } from "@cloudflare/workers-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeQueue, runScheduled } from "../worker/publishing";
import type { Env, PublicationRow, PublishJob } from "../worker/types";

const baseEnv = env as unknown as Env;
const send = vi.fn(async () => undefined);
const testEnv = { ...baseEnv, PUBLISH_QUEUE: { send } } as unknown as Env;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  send.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function seed(step = "create", type = "post", count = 1) {
  await baseEnv.DB.prepare("INSERT INTO users (id,email,display_name) VALUES ('owner','owner@example.test','Owner')").run();
  await baseEnv.DB.prepare(
    `INSERT INTO publications (id,created_by,type,status,idempotency_key,request_hash,media_count,publish_step,publish_data_json)
     VALUES ('job','owner',?,'publishing','key','hash',?,?,?)`,
  ).bind(type, count, step, step === "create" ? "{}" : '{"containerId":"parent"}').run();
  for (let index = 0; index < count; index++) {
    await baseEnv.DB.prepare(
      `INSERT INTO publication_media (id,publication_id,object_key,original_name,mime_type,size_bytes,position,media_url_expires_at)
       VALUES (?,'job',?,'video.mp4','video/mp4',4,?,?)`,
    ).bind(`item-${index}`, `test/publishing/${index}`, index, Math.floor(Date.now() / 1000) + 21600).run();
    await baseEnv.MEDIA.put(`test/publishing/${index}`, "test");
  }
}

async function state() {
  return (await baseEnv.DB.prepare("SELECT * FROM publications WHERE id = 'job'").first<PublicationRow & { error_code: string | null; ig_media_id: string | null }>())!;
}

async function deliver(environment = testEnv, makeDue = true) {
  if (makeDue) await baseEnv.DB.prepare("UPDATE publications SET next_attempt_at = NULL WHERE id = 'job'").run();
  const message = { body: { publicationId: "job" }, ack: vi.fn(), retry: vi.fn() };
  await consumeQueue({ messages: [message] } as unknown as MessageBatch<PublishJob>, environment);
  return message;
}

describe("durable Instagram publishing", () => {
  it.each([429, 500, 503])("retries a temporary %i while keeping the existing container", async (status) => {
    await seed("poll");
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: 2, error_subcode: 123, fbtrace_id: "trace" } }, { status }))
      .mockResolvedValueOnce(Response.json({ status_code: "FINISHED" }));
    await deliver();
    expect((await state()).status).toBe("publishing");
    expect((await state()).retry_attempts).toBe(1);
    expect(send).toHaveBeenLastCalledWith({ publicationId: "job" }, { delaySeconds: 30 });
    await deliver();
    expect((await state()).publish_step).toBe("ready");
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("parent?"))).toBe(true);
    const audit = await baseEnv.DB.prepare("SELECT details_json FROM audit_log WHERE action = 'instagram_request_failed'").first<{ details_json: string }>();
    expect(JSON.parse(audit!.details_json)).toMatchObject({ code: "2", subcode: 123, traceId: "trace", step: "poll" });
  });

  it("recovers from a failed container creation request", async () => {
    await seed();
    fetchMock.mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(Response.json({ id: "created" }));
    await deliver();
    expect((await state()).retry_attempts).toBe(1);
    await deliver();
    expect(JSON.parse((await state()).publish_data_json)).toEqual({ containerId: "created" });
    expect((await state()).publish_step).toBe("poll");
  });

  it("does not let duplicate messages bypass the retry delay", async () => {
    await seed("poll");
    fetchMock.mockResolvedValue(Response.json({ error: { code: 4 } }, { status: 429 }));
    await deliver();
    await deliver(testEnv, false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after five temporary retries", async () => {
    await seed("poll");
    fetchMock.mockResolvedValue(Response.json({ error: { code: 2 } }, { status: 503 }));
    for (let index = 0; index < 6; index++) await deliver();
    expect((await state()).status).toBe("failed");
    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls.map((call) => (call as unknown as [unknown, { delaySeconds: number }])[1].delaySeconds)).toEqual([30, 60, 120, 240, 480]);
  });

  it("does not retry an expired Instagram credential", async () => {
    await seed("poll");
    fetchMock.mockResolvedValue(Response.json({ error: { code: 190, is_transient: true } }, { status: 400 }));
    await deliver();
    expect((await state()).error_code).toBe("190");
    expect(send).not.toHaveBeenCalled();
  });

  it("retries a non-JSON server response", async () => {
    await seed("poll");
    fetchMock.mockResolvedValue(new Response("Unavailable", { status: 503 }));
    await deliver();
    expect((await state()).retry_attempts).toBe(1);
  });

  it("redelivers infrastructure failures instead of acknowledging them", async () => {
    const environment = { ...testEnv, DB: { prepare: () => { throw new Error("D1 unavailable"); } } } as unknown as Env;
    const message = await deliver(environment, false);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("persists progress when sending the next Queue message fails", async () => {
    await seed();
    fetchMock.mockResolvedValue(Response.json({ id: "created" }));
    send.mockRejectedValueOnce(new Error("Queue unavailable"));
    const message = await deliver();
    expect((await state()).publish_step).toBe("poll");
    expect(message.retry).toHaveBeenCalled();
    fetchMock.mockResolvedValue(Response.json({ status_code: "FINISHED" }));
    await deliver();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("never repeats a publish request after a lost Instagram response", async () => {
    await seed("ready");
    fetchMock.mockRejectedValue(new TypeError("response lost"));
    await deliver();
    await deliver();
    await runScheduled(testEnv);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await state()).error_code).toBe("publish_outcome_unknown");
  });

  it("keeps publication success when permalink lookup fails", async () => {
    await seed("ready");
    fetchMock.mockResolvedValueOnce(Response.json({ id: "published" })).mockRejectedValueOnce(new TypeError("permalink unavailable"));
    await deliver();
    await deliver();
    expect((await state()).status).toBe("published");
    expect((await state()).ig_media_id).toBe("published");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/media_publish"))).toHaveLength(1);
  });

  it("keeps success if the audit write fails after Instagram publishes", async () => {
    await seed("ready");
    fetchMock.mockResolvedValue(Response.json({ id: "published" }));
    const environment = { ...testEnv, DB: { prepare: (sql: string) => {
      if (sql.includes("INSERT INTO audit_log")) throw new Error("Audit unavailable");
      return baseEnv.DB.prepare(sql);
    } } } as unknown as Env;
    const message = await deliver(environment);
    expect((await state()).status).toBe("published");
    expect(message.retry).toHaveBeenCalled();
    await deliver();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/media_publish"))).toHaveLength(1);
  });

  it("creates each carousel child once and waits before creating the parent", async () => {
    await seed("create", "carousel", 2);
    fetchMock.mockResolvedValueOnce(Response.json({ id: "child-1" }))
      .mockResolvedValueOnce(Response.json({ error: { code: 2 } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: "child-2" }))
      .mockResolvedValueOnce(Response.json({ status_code: "IN_PROGRESS" }))
      .mockResolvedValueOnce(Response.json({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(Response.json({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(Response.json({ id: "parent" }));
    await deliver(); await deliver(); await deliver();
    expect(JSON.parse((await state()).publish_data_json).children).toEqual(["child-1", "child-2"]);
    await deliver();
    expect((await state()).publish_step).toBe("poll_children");
    await deliver(); await deliver();
    expect((await state()).publish_step).toBe("create_parent");
    await deliver();
    const postBodies = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => new URLSearchParams(String(init!.body)));
    expect(postBodies.filter((body) => body.get("video_url")?.includes("item-0"))).toHaveLength(1);
    expect(postBodies.at(-1)!.get("children")).toBe("child-1,child-2");
    expect((await state()).publish_step).toBe("poll");
  });

  it("reports processing timeout after sixty checks", async () => {
    await seed("poll");
    await baseEnv.DB.prepare("UPDATE publications SET poll_attempts = 59 WHERE id = 'job'").run();
    fetchMock.mockResolvedValue(Response.json({ status_code: "IN_PROGRESS" }));
    await deliver();
    expect((await state()).error_code).toBe("processing_timeout");
  });

  it("recovers a missed next message but respects scheduled backoff", async () => {
    await seed("poll");
    await baseEnv.DB.prepare("UPDATE publications SET updated_at = '2020-01-01T00:00:00Z', next_attempt_at = ? WHERE id = 'job'")
      .bind(Math.floor(Date.now() / 1000) + 900).run();
    await runScheduled(testEnv);
    expect(send).not.toHaveBeenCalled();
    await baseEnv.DB.prepare("UPDATE publications SET next_attempt_at = NULL WHERE id = 'job'").run();
    await runScheduled(testEnv);
    expect(send).toHaveBeenCalledWith({ publicationId: "job" });
  });
});
