import type { Metadata } from "next";
import { TtsStudio } from "../tts-studio";

export const metadata: Metadata = {
  title: "Quick Studio — SyncVoice",
  description: "Generate a single synchronized voice clip with Gemini native audio.",
};

export default function QuickStudioPage() {
  return <TtsStudio />;
}
