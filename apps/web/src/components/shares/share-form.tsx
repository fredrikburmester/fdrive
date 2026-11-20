"use client";

import { CreateShareRequest, type FsEntry, type ManagedShare } from "@fdrive/contracts";
import { cn } from "cn";
import { Eye, EyeOff, Wand2 } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { SettingRow } from "@/components/shell/page-layout";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  canUploadShare,
  initialShareFields,
  passwordFromBytes,
  type ShareFields,
  shareRequest,
} from "@/lib/shares/forms";
import { useShareManagement } from "@/lib/shares/management";
import { PRESENTATION_DESCRIPTION, PRESENTATION_LABEL } from "@/lib/shares/presentation-label";

export interface ShareFormOptions {
  /** The shared files and folders, as they are in storage now. */
  entries: readonly FsEntry[];
  /** The link being edited. Left out, the form creates one. */
  share?: ManagedShare | undefined;
  /** Called with the link as the server now holds it. */
  onSaved: (share: ManagedShare) => void;
}

export interface ShareForm {
  readonly entries: readonly FsEntry[];
  readonly share: ManagedShare | undefined;
  readonly fields: ShareFields;
  readonly change: (patch: Partial<ShareFields>) => void;
  /** True once a field differs from what the link has. */
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  /** True from a successful save until the next change. */
  readonly saved: boolean;
  readonly passwordVisible: boolean;
  readonly togglePasswordVisible: () => void;
  readonly generatePassword: () => void;
  readonly submit: (event: FormEvent) => Promise<void>;
}

/**
 * The state behind a link's settings, shared by the dialog that creates or edits one from the
 * file browser and the sheet on the Shares page. Untouched fields follow the link as it is, and
 * the password never outlives the form.
 */
export function useShareForm({ entries, share, onSaved }: ShareFormOptions): ShareForm {
  const management = useShareManagement();
  const initial = initialShareFields(entries, share);
  const [draft, setDraft] = useState<ShareFields | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const fields = draft ?? initial;

  function change(patch: Partial<ShareFields>) {
    setDraft((current) => ({ ...(current ?? initial), ...patch }));
  }

  function generatePassword() {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    change({ password: passwordFromBytes(bytes), passwordAction: "change" });
    setPasswordVisible(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const request = shareRequest(fields, entries, share !== undefined);
      setPending(true);
      const result = share
        ? await management.update(share.id, request)
        : await management.create(CreateShareRequest.parse(request));
      // An edited link goes back to following the link; a new one only forgets its password.
      setDraft(share ? null : { ...fields, password: "" });
      setPasswordVisible(false);
      setSaved(true);
      onSaved(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the link.");
    } finally {
      setPending(false);
    }
  }

  return {
    entries,
    share,
    fields,
    change,
    dirty:
      draft !== null &&
      (Object.keys(initial) as (keyof ShareFields)[]).some((key) => draft[key] !== initial[key]),
    pending,
    error,
    saved: saved && draft === null,
    passwordVisible,
    togglePasswordVisible: () => setPasswordVisible((visible) => !visible),
    generatePassword,
    submit,
  };
}

type ShareFormLayout = "dialog" | "sheet";

/** A sheet's fields are at least 44px tall on a phone; the dialog keeps its compact ones. */
const FIELD = "max-md:sheet:min-h-11";

/** One field: stacked under its label in a dialog, a `SettingRow` in a sheet. */
function FormRow({
  layout,
  label,
  htmlFor,
  description,
  children,
}: {
  layout: ShareFormLayout;
  label: string;
  /** The id of the control. Left out, the control names itself with `aria-label`. */
  htmlFor?: string;
  description: ReactNode;
  children: ReactNode;
}) {
  const labelled = htmlFor === undefined ? {} : { htmlFor };
  if (layout === "sheet") {
    return (
      <SettingRow label={label} description={description} {...labelled}>
        {children}
      </SettingRow>
    );
  }
  return (
    <Field>
      <FieldLabel {...labelled}>{label}</FieldLabel>
      {children}
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}

/**
 * The fields of a link: its name, description, access, how its page shows, its password, when it
 * expires and how often it can be used. `layout` only changes how each field is laid out.
 */
export function ShareFormFields({ form, layout }: { form: ShareForm; layout: ShareFormLayout }) {
  const id = useId();
  const { entries, share, fields, change, pending } = form;
  const limits = (
    <>
      <FormRow
        layout={layout}
        label="Expires"
        htmlFor={`${id}-expiry`}
        description="Optional expiration in your local time."
      >
        <Input
          id={`${id}-expiry`}
          className={FIELD}
          type="datetime-local"
          value={fields.expires}
          disabled={pending}
          onChange={(event) => change({ expires: event.target.value })}
        />
      </FormRow>
      <FormRow
        layout={layout}
        label={fields.scope === "write" ? "Upload limit" : "Download limit"}
        htmlFor={`${id}-limit`}
        description="Blank or zero means unlimited. Each download, preview or peek counts once; thumbnails never do."
      >
        <Input
          id={`${id}-limit`}
          className={FIELD}
          type="number"
          min="0"
          step="1"
          value={fields.maxDownloads}
          disabled={pending}
          onChange={(event) => change({ maxDownloads: event.target.value })}
        />
      </FormRow>
    </>
  );
  const rows = (
    <>
      <FormRow
        layout={layout}
        label="Link name"
        htmlFor={`${id}-name`}
        description="Shown to anyone opening the link."
      >
        <Input
          id={`${id}-name`}
          className={FIELD}
          value={fields.name}
          maxLength={255}
          required
          disabled={pending}
          onChange={(event) => change({ name: event.target.value })}
        />
      </FormRow>
      <FormRow
        layout={layout}
        label="Description"
        htmlFor={`${id}-description`}
        description="Optional instructions for the people receiving this link."
      >
        <Textarea
          id={`${id}-description`}
          className="sheet:bg-background sheet:px-3"
          value={fields.description}
          maxLength={2048}
          disabled={pending}
          onChange={(event) => change({ description: event.target.value })}
        />
      </FormRow>
      <FormRow
        layout={layout}
        label="Access"
        description={
          fields.scope === "write"
            ? "People can send files into this folder, without seeing its contents."
            : entries.length > 1
              ? "The selected files are downloaded together as a ZIP archive."
              : "People can browse, preview, and download shared content."
        }
      >
        <Select
          value={fields.scope}
          disabled={pending}
          onValueChange={(value) => {
            if (value === "read" || value === "write") change({ scope: value });
          }}
        >
          <SelectTrigger aria-label="Access" className={cn("w-full", FIELD)}>
            <SelectValue>{fields.scope === "write" ? "Can upload" : "Can view"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="read">Can view</SelectItem>
            <SelectItem value="write" disabled={!canUploadShare(entries)}>
              Can upload
            </SelectItem>
          </SelectContent>
        </Select>
      </FormRow>
      <FormRow
        layout={layout}
        label="Show as"
        description={PRESENTATION_DESCRIPTION[fields.presentation]}
      >
        <Select
          value={fields.presentation}
          disabled={pending}
          onValueChange={(value) => {
            if (value === "auto" || value === "list" || value === "gallery" || value === "download")
              change({ presentation: value });
          }}
        >
          <SelectTrigger aria-label="Show as" className={cn("w-full", FIELD)}>
            <SelectValue>{PRESENTATION_LABEL[fields.presentation]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(["auto", "list", "gallery", "download"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {PRESENTATION_LABEL[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormRow>
      {share && (
        <FormRow
          layout={layout}
          label="Password protection"
          description="Keeping the current setting never changes the existing password."
        >
          <Select
            value={fields.passwordAction}
            disabled={pending}
            onValueChange={(value) => {
              if (value === "keep" || value === "change" || value === "remove")
                change({ passwordAction: value, password: "" });
            }}
          >
            <SelectTrigger aria-label="Password protection" className={cn("w-full", FIELD)}>
              <SelectValue>
                {fields.passwordAction === "change"
                  ? "Change password"
                  : fields.passwordAction === "remove"
                    ? "Remove password"
                    : share.hasPassword
                      ? "Keep existing password"
                      : "Keep without password"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="keep">
                Keep {share.hasPassword ? "existing password" : "without password"}
              </SelectItem>
              <SelectItem value="change">Change password</SelectItem>
              <SelectItem value="remove">Remove password</SelectItem>
            </SelectContent>
          </Select>
        </FormRow>
      )}
      {(!share || fields.passwordAction === "change") && (
        <FormRow
          layout={layout}
          label={share ? "New password" : "Password"}
          htmlFor={`${id}-password`}
          description={
            share
              ? "A new password replaces the previous one."
              : "Optional. Leave blank for a link without a password, or generate a random one."
          }
        >
          <InputGroup className={cn("sheet:h-10 sheet:bg-background", FIELD)}>
            <InputGroupInput
              id={`${id}-password`}
              // The group, not the input inside it, is the field a sheet draws.
              className="sheet:h-full sheet:bg-transparent"
              type={form.passwordVisible ? "text" : "password"}
              autoComplete="new-password"
              maxLength={1024}
              value={fields.password}
              disabled={pending}
              onChange={(event) => change({ password: event.target.value })}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label={form.passwordVisible ? "Hide password" : "Show password"}
                disabled={pending}
                onClick={form.togglePasswordVisible}
              >
                {form.passwordVisible ? <EyeOff /> : <Eye />}
              </InputGroupButton>
              <InputGroupButton disabled={pending} onClick={form.generatePassword}>
                <Wand2 />
                Generate
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </FormRow>
      )}
      {layout === "dialog" ? <div className="grid gap-4 sm:grid-cols-2">{limits}</div> : limits}
    </>
  );
  return layout === "dialog" ? <FieldGroup>{rows}</FieldGroup> : rows;
}
