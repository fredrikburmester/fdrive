"use client";

import {
  CheckCircle2Icon,
  CircleAlertIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function resolveTheme(theme: string | undefined): NonNullable<ToasterProps["theme"]> {
  return theme === "light" || theme === "dark" ? theme : "system";
}

function Toaster({ ...props }: ToasterProps) {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={resolveTheme(theme)}
      className="toaster group"
      icons={{
        success: <CheckCircle2Icon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <CircleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
