"use client";

import { CreateShareRequest, type FsEntry, type ManagedShare } from "@fdrive/contracts";
import { Copy, Eye, EyeOff, Wand2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  type PasswordAction,
  passwordFromBytes,
  shareRequest,
} from "@/lib/shares/forms";
import { useShareManagement } from "@/lib/shares/management";
import { publicShareHref } from "@/lib/shares/paths";
import { PRESENTATION_DESCRIPTION, PRESENTATION_LABEL } from "@/lib/shares/presentation-label";

/** Mounted only while open, so closing always discards transient password state. */
export function ShareDialog({
  entries,
  share,
  onClose,
}: {
  entries: readonly FsEntry[];
  share?: ManagedShare;
  onClose: () => void;
}) {
  const [fields, setFields] = useState(() => initialShareFields(entries, share));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ManagedShare | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const management = useShareManagement();
  function generatePassword() {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    setFields((previous) => ({
      ...previous,
      password: passwordFromBytes(bytes),
      passwordAction: "change",
    }));
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
      if (result) {
        setFields((previous) => ({ ...previous, password: "" }));
        if (share) onClose();
        else setCreated(result);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the link.");
    } finally {
      setPending(false);
    }
  }
  async function copyCreated() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(
        new URL(publicShareHref(created.id), window.location.origin).href,
      );
    } catch {
      setError("Could not copy the link. Select and copy it below.");
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {created ? "Share link ready" : share ? "Edit share link" : "Create share link"}
          </DialogTitle>
          <DialogDescription>
            {created
              ? "Anyone with this link can use it under the limits you chose."
              : "Choose how people can access the selected files. Your originals stay in place."}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <>
            <Input
              aria-label="Share link"
              readOnly
              value={
                typeof window === "undefined"
                  ? publicShareHref(created.id)
                  : new URL(publicShareHref(created.id), window.location.origin).href
              }
            />
            {error && <FieldError>{error}</FieldError>}
            <DialogFooter>
              <Button variant="outline" onClick={() => void copyCreated()}>
                <Copy />
                Copy link
              </Button>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="space-y-5">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="share-name">Link name</FieldLabel>
                <Input
                  id="share-name"
                  value={fields.name}
                  maxLength={255}
                  required
                  disabled={pending}
                  onChange={(event) => setFields({ ...fields, name: event.target.value })}
                />
                <FieldDescription>Shown to anyone opening the link.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="share-description">Description</FieldLabel>
                <Textarea
                  id="share-description"
                  value={fields.description}
                  maxLength={2048}
                  disabled={pending}
                  onChange={(event) => setFields({ ...fields, description: event.target.value })}
                />
                <FieldDescription>
                  Optional instructions for the people receiving this link.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Access</FieldLabel>
                <Select
                  value={fields.scope}
                  disabled={pending}
                  onValueChange={(value) => {
                    if (value === "read" || value === "write")
                      setFields({ ...fields, scope: value });
                  }}
                >
                  <SelectTrigger aria-label="Access">
                    <SelectValue>
                      {fields.scope === "write" ? "Can upload" : "Can view"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">Can view</SelectItem>
                    <SelectItem value="write" disabled={!canUploadShare(entries)}>
                      Can upload
                    </SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {fields.scope === "write"
                    ? "People can send files into this folder, without seeing its contents."
                    : entries.length > 1
                      ? "The selected files are downloaded together as a ZIP archive."
                      : "People can browse, preview, and download shared content."}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Show as</FieldLabel>
                <Select
                  value={fields.presentation}
                  disabled={pending}
                  onValueChange={(value) => {
                    if (
                      value === "auto" ||
                      value === "list" ||
                      value === "gallery" ||
                      value === "download"
                    )
                      setFields({ ...fields, presentation: value });
                  }}
                >
                  <SelectTrigger aria-label="Show as">
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
                <FieldDescription>{PRESENTATION_DESCRIPTION[fields.presentation]}</FieldDescription>
              </Field>
              {share && (
                <Field>
                  <FieldLabel>Password protection</FieldLabel>
                  <Select
                    value={fields.passwordAction}
                    disabled={pending}
                    onValueChange={(value) => {
                      if (value === "keep" || value === "change" || value === "remove")
                        setFields({
                          ...fields,
                          passwordAction: value as PasswordAction,
                          password: "",
                        });
                    }}
                  >
                    <SelectTrigger aria-label="Password protection">
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
                  <FieldDescription>
                    Keeping the current setting never changes the existing password.
                  </FieldDescription>
                </Field>
              )}
              {(!share || fields.passwordAction === "change") && (
                <Field>
                  <FieldLabel htmlFor="share-password">
                    {share ? "New password" : "Password"}
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id="share-password"
                      type={passwordVisible ? "text" : "password"}
                      autoComplete="new-password"
                      maxLength={1024}
                      value={fields.password}
                      disabled={pending}
                      onChange={(event) => setFields({ ...fields, password: event.target.value })}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        aria-label={passwordVisible ? "Hide password" : "Show password"}
                        disabled={pending}
                        onClick={() => setPasswordVisible((visible) => !visible)}
                      >
                        {passwordVisible ? <EyeOff /> : <Eye />}
                      </InputGroupButton>
                      <InputGroupButton disabled={pending} onClick={generatePassword}>
                        <Wand2 />
                        Generate
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                  <FieldDescription>
                    {share
                      ? "A new password replaces the previous one."
                      : "Optional. Leave blank for a link without a password, or generate a random one."}
                  </FieldDescription>
                </Field>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="share-expiry">Expires</FieldLabel>
                  <Input
                    id="share-expiry"
                    type="datetime-local"
                    value={fields.expires}
                    disabled={pending}
                    onChange={(event) => setFields({ ...fields, expires: event.target.value })}
                  />
                  <FieldDescription>Optional expiration in your local time.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="share-limit">
                    {fields.scope === "write" ? "Upload limit" : "Download limit"}
                  </FieldLabel>
                  <Input
                    id="share-limit"
                    type="number"
                    min="0"
                    step="1"
                    value={fields.maxDownloads}
                    disabled={pending}
                    onChange={(event) => setFields({ ...fields, maxDownloads: event.target.value })}
                  />
                  <FieldDescription>
                    Blank or zero means unlimited. Full-size previews and downloads count; gallery
                    thumbnails do not.
                  </FieldDescription>
                </Field>
              </div>
            </FieldGroup>
            {error && <FieldError>{error}</FieldError>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : share ? "Save changes" : "Create link"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
