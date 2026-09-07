export interface AudioViewerProps {
  readonly src: string;
  readonly onError?: () => void;
}

/** A native `<audio>` element with controls, centered in the available space. */
export function AudioViewer({ src, onError }: AudioViewerProps) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <audio controls src={src} onError={onError} className="w-full max-w-md">
        <track kind="captions" />
      </audio>
    </div>
  );
}
