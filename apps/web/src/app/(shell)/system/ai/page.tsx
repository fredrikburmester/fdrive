import type { Metadata } from "next";
import { AiSystemPage } from "@/components/system/ai-page";

export const metadata: Metadata = {
  title: "AI - fdrive",
};

export default function SystemAiPage() {
  return <AiSystemPage />;
}
