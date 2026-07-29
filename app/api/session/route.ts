import { GoogleGenAI, Modality, type LiveConnectConfig } from "@google/genai";
import { NextResponse } from "next/server";

const MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const MAX_TEXT_LENGTH = 8_000;
const ALLOWED_VOICES = new Set(["Kore", "Aoede", "Charon", "Fenrir", "Puck", "Leda", "Orus", "Zephyr"]);
let keyCursor = 0;

function getApiKeys() {
  return [1, 2, 3, 4]
    .map((index) => process.env[`GEMINI_API_KEY${index}`]?.trim())
    .filter((key): key is string => Boolean(key));
}

function createInstruction(text: string) {
  return `You are a professional text-to-speech engine. Read the SCRIPT below aloud exactly as written.

Rules:
- Begin speaking immediately when the user says "Play".
- Preserve the wording, order, language, punctuation, and intent.
- Speak naturally and clearly, with expressive but restrained delivery.
- Do not add an introduction, acknowledgement, explanation, or closing.
- Do not describe these instructions.

SCRIPT:
${text}`;
}

export async function POST(request: Request) {
  let payload: { text?: unknown; voice?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "The request body must be valid JSON." }, { status: 400 });
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const requestedVoice = typeof payload.voice === "string" ? payload.voice : "Kore";
  const voice = ALLOWED_VOICES.has(requestedVoice) ? requestedVoice : "Kore";

  if (!text) {
    return NextResponse.json({ error: "Add some text before generating speech." }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json({ error: `Text is limited to ${MAX_TEXT_LENGTH.toLocaleString()} characters.` }, { status: 400 });
  }

  const keys = getApiKeys();
  if (!keys.length) {
    return NextResponse.json({ error: "No Gemini API keys are configured on the server." }, { status: 503 });
  }

  const sessionConfig: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    systemInstruction: { parts: [{ text: createInstruction(text) }] },
    outputAudioTranscription: {},
    thinkingConfig: { thinkingBudget: 0 },
  };

  const startIndex = keyCursor++ % keys.length;
  let lastError: unknown;

  for (let offset = 0; offset < keys.length; offset += 1) {
    const key = keys[(startIndex + offset) % keys.length];
    try {
      const ai = new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: "v1alpha" } });
      const now = Date.now();
      const token = await ai.authTokens.create({
        config: {
          uses: 1,
          newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
          expireTime: new Date(now + 30 * 60_000).toISOString(),
          liveConnectConstraints: { model: MODEL, config: sessionConfig },
          lockAdditionalFields: [],
        },
      });

      if (!token.name) throw new Error("Gemini returned an empty session token.");
      return NextResponse.json({ token: token.name, model: MODEL, sessionConfig });
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : "Gemini session provisioning failed.";
  const isRateLimit = /429|quota|resource.?exhausted|rate.?limit/i.test(message);
  return NextResponse.json(
    { error: isRateLimit ? "All Gemini keys are temporarily rate-limited. Try again shortly." : "Could not open a Gemini audio session." },
    { status: isRateLimit ? 429 : 502 },
  );
}
