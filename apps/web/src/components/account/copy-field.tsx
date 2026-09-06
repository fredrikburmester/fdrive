"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

export interface CopyFieldProps {
  label: string;
  value: string;
}

/** A read-only field with a copy-to-clipboard button, used for secrets and snippets shown once. */
export function CopyField({ label, value }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <InputGroup>
        <InputGroupInput readOnly value={value} className="font-mono text-xs" />
        <InputGroupAddon align="inline-end">
          <Button type="button" variant="ghost" size="icon-sm" onClick={handleCopy}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            <span className="sr-only">Copy {label}</span>
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
