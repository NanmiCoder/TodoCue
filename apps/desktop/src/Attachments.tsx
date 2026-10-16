import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@todocue/shared";
import { client, saveAttachment } from "./bridge.js";
import { Icon } from "./icons.js";
import { isCompositionKey } from "./quickAdd.js";
import { menuTriggers, useContextMenu } from "./ContextMenu.js";
import { attachmentMenuItems } from "./taskMenu.js";

export type PreviewFile = Pick<Attachment, "name" | "mediaType"> & { id?: string };
export interface FilePreview { file: PreviewFile; data: string; taskId?: string }

export function AttachmentGallery({ taskId, files, online, language, onOpen, onError, onRemove }: {
  taskId: string; files: Attachment[]; online: boolean; language: string;
  onOpen: (preview: FilePreview) => void; onError: (message: string) => void;
  onRemove?: (file: Attachment) => void;
}) {
  const images = files.filter(file => file.mediaType.startsWith("image/"));
  const columns = images.length <= 1 ? 1 : images.length === 2 || images.length === 4 ? 2 : 3;
  return <div className="attachment-gallery">
    <div className="attachment-images" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {images.map(file => <AttachmentTile key={file.id} taskId={taskId} file={file} online={online} language={language} onOpen={onOpen} onError={onError} onRemove={onRemove} />)}
    </div>
    {files.filter(file => !file.mediaType.startsWith("image/")).map(file => <AttachmentTile key={file.id} taskId={taskId} file={file} online={online} language={language} onOpen={onOpen} onError={onError} onRemove={onRemove} />)}
  </div>;
}

function AttachmentTile({ taskId, file, online, language, onOpen, onError, onRemove }: {
  taskId: string; file: Attachment; online: boolean; language: string;
  onOpen: (preview: FilePreview) => void; onError: (message: string) => void;
  onRemove?: (file: Attachment) => void;
}) {
  const [data, setData] = useState<string | null>(null);
  const image = file.mediaType.startsWith("image/");
  const menu = useContextMenu();
  // Save-as goes to the host's save dialog (which fetches the file itself); the browser preview
  // downloads the bytes it has or loads.
  const save = () => void saveAttachment(taskId, file, data ? async () => data : undefined).catch(error => onError(String(error)));
  useEffect(() => {
    if (!online || !image) return;
    let stopped = false;
    void client.getAttachment(taskId, file.id).then(result => {
      if (!stopped) setData(result.dataBase64);
    }).catch(error => { if (!stopped) onError(String(error)); });
    return () => { stopped = true; };
  }, [taskId, file.id, file.sha256, online, image, onError]);
  return <div className={`attachment-tile ${image ? "attachment-image" : "attachment-file"}`}
    {...menuTriggers(anchor => menu.open(anchor, attachmentMenuItems({ language, available: online || !!data, save }), file.name))}>
    {menu.node}
    <button type="button" disabled={!online && !data} aria-label={`${language === "en" ? "Preview attachment" : "预览附件"} ${file.name}`}
      onClick={() => data ? onOpen({ file, data, taskId }) : void client.getAttachment(taskId, file.id).then(result => onOpen({ file, data: result.dataBase64, taskId })).catch(error => onError(String(error)))}>
      {data && image ? <img src={`data:${file.mediaType};base64,${data}`} alt={file.name} /> : <Icon name="paperclip" size={22} />}
      {!image && <span>{file.name}<small>{Math.ceil(file.size / 1024)} KB</small></span>}
    </button>
    {image && <span className="attachment-caption">{file.name}</span>}
    {onRemove && <button type="button" className="attachment-remove" aria-label={`${language === "en" ? "Remove attachment" : "移除附件"} ${file.name}`} onClick={() => onRemove(file)}>{language === "en" ? "Remove" : "移除"}</button>}
  </div>;
}

export function AttachmentPreview({ preview, language, onClose, onError }: { preview: FilePreview; language: string; onClose: () => void; onError?: (message: string) => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const zh = language !== "en";
  const { file, data, taskId } = preview;
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isCompositionKey(event)) {
        event.preventDefault(); event.stopImmediatePropagation(); close.current();
      } else if (event.key === "Tab") {
        const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const edge = event.shiftKey ? buttons[0] : buttons.at(-1);
        if (document.activeElement === edge) { event.preventDefault(); (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus(); }
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      if (previous instanceof HTMLElement && previous.isConnected && !previous.closest("[inert]")) previous.focus();
    };
  }, []);
  return <div ref={dialog} className="file-preview frost" role="dialog" aria-modal="true" aria-label={file.name}>
    <div><h3>{file.name}</h3><button type="button" className="icon-button" onClick={onClose} aria-label={zh ? "关闭预览" : "Close preview"}><Icon name="close" /></button></div>
    {file.mediaType.startsWith("image/") ? <img src={`data:${file.mediaType};base64,${data}`} alt={file.name} /> : <p className="muted">{zh ? "下载后打开此文件" : "Download to open this file"}</p>}
    <button type="button" className="pill" onClick={() => void saveAttachment(taskId, file, async () => data).catch(error => onError?.(String(error)))}>{zh ? "下载文件" : "Download file"}</button>
  </div>;
}
