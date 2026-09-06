import type { Metadata } from "next";
import { OcrPage } from "@/components/system/ocr-page";

export const metadata: Metadata = {
  title: "OCR - fdrive",
};

export default function SystemOcrPage() {
  return <OcrPage />;
}
