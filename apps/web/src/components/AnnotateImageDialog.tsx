import { Trans, useLingui } from "@lingui/react/macro";
import type { ImageAnnotationMark } from "@rakazo/contracts";
import { IMAGE_ANNOTATION_MAX_MARKS } from "@rakazo/contracts";
import { Button, Dialog, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readFileAsBase64 } from "../lib/pending-attachments";
import { prepareImage } from "../lib/prepare-image";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

type Point = { x: number; y: number };
type Draft = Point & { width: number; height: number };

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function pointIn(element: HTMLElement, event: React.PointerEvent): Point {
  const rect = element.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width),
    y: clamp((event.clientY - rect.top) / rect.height),
  };
}

export function AnnotateImageDialog({
  attachmentId,
  file,
  target,
  onClose,
  onSaved,
}: {
  attachmentId: string;
  file: File;
  target: { botId: string } | { groupId: string };
  onClose: () => void;
  onSaved: (saved: { artifactId: string; previewUrl: string; mimeType: string }) => void;
}) {
  const { t } = useLingui();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<Point | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [marks, setMarks] = useState<ImageAnnotationMark[]>([]);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [previewUrl] = useState(() => URL.createObjectURL(file));
  // A reopened editor must not reuse the previous save's idempotency key.
  const [sessionId] = useState(() => crypto.randomUUID());
  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);

  const changeMarks = (next: ImageAnnotationMark[]) => {
    setMarks(next);
    setRevision((current) => current + 1);
  };

  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    if (marks.length >= IMAGE_ANNOTATION_MAX_MARKS) return;
    const element = surfaceRef.current;
    if (!element) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointIn(element, event);
    startRef.current = point;
    setDraft({ ...point, width: 0, height: 0 });
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = surfaceRef.current;
    const from = startRef.current;
    if (!element || !from) return;
    const point = pointIn(element, event);
    setDraft({
      x: Math.min(from.x, point.x),
      y: Math.min(from.y, point.y),
      width: Math.abs(point.x - from.x),
      height: Math.abs(point.y - from.y),
    });
  };

  const finish = () => {
    const next = draft;
    startRef.current = null;
    setDraft(null);
    // A stray click is not a box.
    if (!next || next.width < 0.02 || next.height < 0.02) return;
    changeMarks([...marks, next]);
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const prepared = await prepareImage(file);
      const contentBase64 = await readFileAsBase64(prepared);
      const artifact = await rpc.artifacts.annotate({
        ...target,
        name: file.name,
        mimeType: prepared.type || file.type || "image/png",
        contentBase64,
        marks,
        clientNonce: `annotation:${attachmentId}:${sessionId}:${revision}`,
      });
      const content = await rpc.artifacts.get({ ...target, artifactId: artifact.id });
      const preview = `data:${content.mimeType};base64,${content.contentBase64}`;
      onSaved({ artifactId: artifact.id, previewUrl: preview, mimeType: content.mimeType });
    } catch (cause) {
      setError(errorText(cause, t`Could not annotate this image`));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !saving ? onClose() : undefined)}>
      <DialogContent
        className="max-h-[90vh] w-[min(90vw,56rem)] overflow-y-auto"
        // A file dropped on the dialog belongs to the dialog, not the composer behind it.
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <DialogTitle>
          <Trans>Annotate image</Trans>
        </DialogTitle>
        <p className="text-body text-muted-foreground">
          <Trans>Drag over the image to point at what matters.</Trans>
        </p>
        <div
          ref={surfaceRef}
          className="relative mt-3 w-fit max-w-full touch-none select-none"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={finish}
        >
          <img
            src={previewUrl}
            alt={file.name}
            draggable={false}
            className="max-h-[55vh] max-w-full rounded-xl object-contain"
          />
          {marks.map((mark, index) => (
            <div
              key={`${index}-${mark.x}-${mark.y}`}
              className="pointer-events-none absolute border-2 border-destructive"
              style={{
                left: `${mark.x * 100}%`,
                top: `${mark.y * 100}%`,
                width: `${mark.width * 100}%`,
                height: `${mark.height * 100}%`,
              }}
            >
              <span className="absolute -top-3 -left-3 flex h-6 w-6 items-center justify-center rounded-full bg-destructive text-body-sm font-semibold text-white">
                {index + 1}
              </span>
            </div>
          ))}
          {draft ? (
            <div
              className="pointer-events-none absolute border-2 border-destructive/70 bg-destructive/10"
              style={{
                left: `${draft.x * 100}%`,
                top: `${draft.y * 100}%`,
                width: `${draft.width * 100}%`,
                height: `${draft.height * 100}%`,
              }}
            />
          ) : null}
        </div>
        {marks.length > 0 ? (
          <ol className="mt-4 flex flex-col gap-2">
            {marks.map((mark, index) => (
              <li key={`${index}-${mark.x}-${mark.y}`} className="flex items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-destructive text-body-sm font-semibold text-white">
                  {index + 1}
                </span>
                <input
                  value={mark.label ?? ""}
                  aria-label={t`Note for box ${index + 1}`}
                  placeholder={t`What is wrong here?`}
                  maxLength={200}
                  onChange={(event) =>
                    changeMarks(
                      marks.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, label: event.target.value || undefined }
                          : candidate,
                      ),
                    )
                  }
                  className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-body"
                />
                <button
                  type="button"
                  aria-label={t`Remove box ${index + 1}`}
                  onClick={() => changeMarks(marks.filter((_, i) => i !== index))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ol>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-body text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void save()} disabled={saving || marks.length === 0}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Use annotated image</Trans>}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
