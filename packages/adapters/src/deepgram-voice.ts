import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import {
  readVoiceAudio,
  readVoiceJson,
  verifyVoiceHttpGet,
  voiceDeadline,
  voiceLanguageHint,
  voiceRequestError,
} from "./voice-http.js";

const API = "https://api.deepgram.com/v1";
const TRANSCRIBE_MODEL = "nova-3";
const MAX_ERROR_DETAIL = 500;

/** Aura-2 English models from Deepgram's voice list, ordered by label. */
const AURA_VOICES: VoiceInfo[] = [
  { id: "aura-2-amalthea-en", label: "Amalthea", description: "Filipino, feminine" },
  { id: "aura-2-andromeda-en", label: "Andromeda", description: "American, feminine" },
  { id: "aura-2-apollo-en", label: "Apollo", description: "American, masculine" },
  { id: "aura-2-arcas-en", label: "Arcas", description: "American, masculine" },
  { id: "aura-2-aries-en", label: "Aries", description: "American, masculine" },
  { id: "aura-2-asteria-en", label: "Asteria", description: "American, feminine" },
  { id: "aura-2-athena-en", label: "Athena", description: "American, feminine" },
  { id: "aura-2-atlas-en", label: "Atlas", description: "American, masculine" },
  { id: "aura-2-aurora-en", label: "Aurora", description: "American, feminine" },
  { id: "aura-2-callista-en", label: "Callista", description: "American, feminine" },
  { id: "aura-2-cora-en", label: "Cora", description: "American, feminine" },
  { id: "aura-2-cordelia-en", label: "Cordelia", description: "American, feminine" },
  { id: "aura-2-delia-en", label: "Delia", description: "American, feminine" },
  { id: "aura-2-draco-en", label: "Draco", description: "British, masculine" },
  { id: "aura-2-electra-en", label: "Electra", description: "American, feminine" },
  { id: "aura-2-harmonia-en", label: "Harmonia", description: "American, feminine" },
  { id: "aura-2-helena-en", label: "Helena", description: "American, feminine" },
  { id: "aura-2-hera-en", label: "Hera", description: "American, feminine" },
  { id: "aura-2-hermes-en", label: "Hermes", description: "American, masculine" },
  { id: "aura-2-hyperion-en", label: "Hyperion", description: "Australian, masculine" },
  { id: "aura-2-iris-en", label: "Iris", description: "American, feminine" },
  { id: "aura-2-janus-en", label: "Janus", description: "American, feminine" },
  { id: "aura-2-juno-en", label: "Juno", description: "American, feminine" },
  { id: "aura-2-jupiter-en", label: "Jupiter", description: "American, masculine" },
  { id: "aura-2-luna-en", label: "Luna", description: "American, feminine" },
  { id: "aura-2-mars-en", label: "Mars", description: "American, masculine" },
  { id: "aura-2-minerva-en", label: "Minerva", description: "American, feminine" },
  { id: "aura-2-neptune-en", label: "Neptune", description: "American, masculine" },
  { id: "aura-2-odysseus-en", label: "Odysseus", description: "American, masculine" },
  { id: "aura-2-ophelia-en", label: "Ophelia", description: "American, feminine" },
  { id: "aura-2-orion-en", label: "Orion", description: "American, masculine" },
  { id: "aura-2-orpheus-en", label: "Orpheus", description: "American, masculine" },
  { id: "aura-2-pandora-en", label: "Pandora", description: "British, feminine" },
  { id: "aura-2-phoebe-en", label: "Phoebe", description: "American, feminine" },
  { id: "aura-2-pluto-en", label: "Pluto", description: "American, masculine" },
  { id: "aura-2-saturn-en", label: "Saturn", description: "American, masculine" },
  { id: "aura-2-selene-en", label: "Selene", description: "American, feminine" },
  { id: "aura-2-thalia-en", label: "Thalia", description: "American, feminine" },
  { id: "aura-2-theia-en", label: "Theia", description: "Australian, feminine" },
  { id: "aura-2-vesta-en", label: "Vesta", description: "American, feminine" },
  { id: "aura-2-zeus-en", label: "Zeus", description: "American, masculine" },
];

export class DeepgramVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "deepgram",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  /** Deepgram's documented key test; the JSON it returns is not needed after the check. */
  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    return verifyVoiceHttpGet({
      url: `${API}/auth/token`,
      headers: deepgramHeaders(apiKey),
      signal: context.signal,
      provider: "Deepgram",
    });
  }

  async listVoices(_apiKey: string, _context: AdapterContext): Promise<VoiceInfo[]> {
    return AURA_VOICES;
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const params = new URLSearchParams({ model: request.voiceId, encoding: "mp3" });
    const res = await fetch(`${API}/speak?${params}`, {
      method: "POST",
      headers: { ...deepgramHeaders(request.apiKey), "content-type": "application/json" },
      body: JSON.stringify({ text: request.text }),
      signal,
    });
    if (!res.ok) throw await deepgramError(res, "speaking", request.apiKey);
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    const params = new URLSearchParams({ model: TRANSCRIBE_MODEL });
    const language = voiceLanguageHint(request.language);
    if (language) params.set("language", language);
    const res = await fetch(`${API}/listen?${params}`, {
      method: "POST",
      headers: {
        ...deepgramHeaders(request.apiKey),
        "content-type": request.mimeType || "audio/webm",
      },
      body: new Uint8Array(request.audio),
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
    });
    if (!res.ok) throw await deepgramError(res, "transcribing", request.apiKey);
    const body = await readVoiceJson(res, { requireValid: true });
    const channels = (body as DeepgramTranscription | null)?.results?.channels;
    const transcript = channels?.[0]?.alternatives?.[0]?.transcript;
    return { text: typeof transcript === "string" ? transcript.trim() : "" };
  }
}

interface DeepgramTranscription {
  results?: {
    channels?: Array<{ alternatives?: Array<{ transcript?: unknown }> }>;
  };
}

function deepgramHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Token ${apiKey}` };
}

/** Include Deepgram's `err_msg` or `message`, with the key removed, and cap the length. */
async function deepgramError(res: Response, what: string, apiKey: string): Promise<Error> {
  const detail = deepgramDetail(await readVoiceJson(res, { rawOnInvalid: true }), apiKey);
  return voiceRequestError(res.status, "Deepgram", what, detail ? { detail } : null);
}

function deepgramDetail(body: unknown, apiKey: string): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const raw =
    typeof body === "string"
      ? body
      : [record?.err_msg, record?.message, record?.error, record?.detail].find(
          (value): value is string => typeof value === "string" && value.trim() !== "",
        );
  if (!raw) return "";
  const redacted = apiKey ? raw.replaceAll(apiKey, "[redacted]") : raw;
  return redacted
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .trim()
    .slice(0, MAX_ERROR_DETAIL);
}
