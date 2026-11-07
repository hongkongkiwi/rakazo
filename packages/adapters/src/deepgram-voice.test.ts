import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepgramVoiceProvider } from "./deepgram-voice.js";

const context: AdapterContext = {
  operationId: "test-operation",
  traceId: "test-trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Reads a request header case-insensitively, as HTTP requires. */
function header(init: RequestInit | undefined, name: string): string | null {
  if (!init?.headers) return null;
  return new Headers(init.headers).get(name);
}

/** The raw bytes of a binary request body, regardless of how fetch was given them. */
async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new Error("expected a raw binary body");
}

describe("DeepgramVoiceProvider", () => {
  it("advertises catalog, synthesis, and transcription", () => {
    expect(new DeepgramVoiceProvider().describe()).toMatchObject({
      id: "deepgram",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    });
  });

  it("returns a deterministic offline Aura-2 voice catalog", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DeepgramVoiceProvider();

    const voices = await provider.listVoices("dg-key", context);
    expect(voices.length).toBeGreaterThan(0);
    for (const voice of voices) {
      expect(voice.id.length).toBeGreaterThan(0);
      expect(voice.label.length).toBeGreaterThan(0);
    }
    expect(await provider.listVoices("dg-key", context)).toEqual(voices);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the key against /v1/auth/token with a Token header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DeepgramVoiceProvider().verify("dg-key", context)).resolves.toEqual({
      ok: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.deepgram.com/v1/auth/token");
    expect(header(init, "authorization")).toBe("Token dg-key");
  });

  it("reports a rejected key without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));

    await expect(new DeepgramVoiceProvider().verify("dg-key", context)).resolves.toEqual({
      ok: false,
      message: "Deepgram rejected that key. Check the key and that it has speech permissions.",
    });
  });

  it("synthesizes through /v1/speak as JSON with a Token header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([7, 8]), { headers: { "content-type": "audio/mpeg" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const clip = await new DeepgramVoiceProvider().synthesize(
      { text: "Hello there.", voiceId: "aura-2-angus-en", apiKey: "dg-key" },
      context,
    );

    expect(clip).toEqual({ bytes: new Uint8Array([7, 8]), mimeType: "audio/mpeg" });
    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/v1/speak");
    expect(init.method).toBe("POST");
    expect(header(init, "authorization")).toBe("Token dg-key");
    expect(header(init, "content-type")).toContain("application/json");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.text).toBe("Hello there.");
    // Deepgram names a voice by its model; the picker's voice id reaches it as `model`.
    expect(body.model ?? parsed.searchParams.get("model")).toBe("aura-2-angus-en");
  });

  it("transcribes raw audio through /v1/listen with nova-3", async () => {
    const audio = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: { channels: [{ alternatives: [{ transcript: "  Hello there. " }] }] },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new DeepgramVoiceProvider().transcribe!(
        { audio, mimeType: "audio/webm", apiKey: "dg-key" },
        context,
      ),
    ).resolves.toEqual({ text: "Hello there." });

    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/v1/listen");
    expect(parsed.searchParams.get("model")).toBe("nova-3");
    expect(init.method).toBe("POST");
    expect(header(init, "authorization")).toBe("Token dg-key");
    expect(header(init, "content-type")).toBe("audio/webm");
    expect(init.body).not.toBeInstanceOf(FormData);
    expect(await bodyBytes(init.body)).toEqual(audio);
  });

  it("extracts the transcript from results.channels[0].alternatives[0]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: {
              channels: [
                {
                  alternatives: [
                    { transcript: "first", confidence: 0.9 },
                    { transcript: "ignored" },
                  ],
                },
              ],
            },
          }),
        ),
      ),
    );

    await expect(
      new DeepgramVoiceProvider().transcribe!(
        { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey: "dg-key" },
        context,
      ),
    ).resolves.toEqual({ text: "first" });
  });

  it.each(["synthesize", "transcribe"] as const)(
    "keeps the API key out of %s failure messages",
    async (operation) => {
      const apiKey = "dg-verysecretkey12345";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ message: `model rejected key ${apiKey}`, status: 502 }), {
            status: 502,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      const provider = new DeepgramVoiceProvider();
      const attempt: Promise<unknown> =
        operation === "synthesize"
          ? provider.synthesize({ text: "Hi", voiceId: "aura-2-angus-en", apiKey }, context)
          : provider.transcribe!(
              { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey },
              context,
            );

      const error = await attempt.catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(apiKey);
    },
  );
});
