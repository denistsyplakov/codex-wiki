import React, { useState, useEffect, useRef } from "react";
import { X } from "lucide-react";
import "./NewFolderModal.css";

interface NewFolderModalProps {
  parentPath: string;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export const NewFolderModal: React.FC<NewFolderModalProps> = ({
  parentPath,
  onConfirm,
  onClose,
}) => {
  const [folderName, setFolderName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const parentLabel =
    parentPath === "/" || parentPath === "" ? "root" : `"${parentPath.split("/").pop()}"`;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) onClose();
  };

  const handleSubmit = () => {
    const trimmed = folderName.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <div
      className="new-folder-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="New folder"
    >
      <div className="new-folder-modal">
        <div className="new-folder-header">
          <h3 className="new-folder-title">New folder in {parentLabel}</h3>
          <button
            className="new-folder-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <input
          ref={inputRef}
          className="new-folder-input"
          type="text"
          placeholder="Folder name"
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
          aria-label="Folder name"
        />
        <div className="new-folder-actions">
          <button className="new-folder-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="new-folder-confirm"
            onClick={handleSubmit}
            disabled={!folderName.trim()}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
};
