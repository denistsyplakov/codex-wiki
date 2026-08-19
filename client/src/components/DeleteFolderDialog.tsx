import React, { useEffect, useState } from "react";
import { AlertTriangle, Calendar, FileText, Folder, Loader2 } from "lucide-react";
import { FolderInfo } from "../types";
import { api } from "../services/api";
import "./DeleteFolderDialog.css";

interface DeleteFolderDialogProps {
  folderPath: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const formatDate = (isoDate: string): string => {
  const date = new Date(isoDate);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/** Confirmation modal for deleting a folder, showing details about its contents */
export const DeleteFolderDialog: React.FC<DeleteFolderDialogProps> = ({
  folderPath,
  onConfirm,
  onCancel,
}) => {
  const [info, setInfo] = useState<FolderInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const folderName = folderPath.split("/").pop() ?? folderPath;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    api
      .getFolderInfo(folderPath)
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((err) => {
        if (!cancelled) {
          const msg =
            err instanceof Error ? err.message : "Failed to load folder details";
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folderPath]);

  const handleConfirm = () => {
    setIsDeleting(true);
    onConfirm();
  };

  return (
    <div
      className="delete-folder-overlay"
      onClick={isDeleting ? undefined : onCancel}
      role="presentation"
    >
      <div
        className="delete-folder-dialog"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-folder-title"
      >
        <div className="delete-folder-header">
          <AlertTriangle
            size={20}
            className="delete-folder-warning-icon"
            aria-hidden="true"
          />
          <h3 className="delete-folder-title" id="delete-folder-title">
            Delete "{folderName}"?
          </h3>
        </div>

        <p className="delete-folder-message">
          This will permanently delete the folder and all its contents. This
          action cannot be undone.
        </p>

        {isLoading && (
          <div className="delete-folder-loading">
            <Loader2
              size={14}
              className="delete-folder-spinner"
              aria-hidden="true"
            />
            Loading folder details...
          </div>
        )}

        {!isLoading && error && (
          <p className="delete-folder-error" role="alert">
            {error}
          </p>
        )}

        {!isLoading && info && (
          <dl className="delete-folder-details">
            <div className="delete-folder-detail-row">
              <dt>
                <Folder size={14} aria-hidden="true" /> Path
              </dt>
              <dd>{folderPath}</dd>
            </div>
            <div className="delete-folder-detail-row">
              <dt>
                <FileText size={14} aria-hidden="true" /> Contents
              </dt>
              <dd>
                {info.fileCount} page{info.fileCount === 1 ? "" : "s"},{" "}
                {info.folderCount} subfolder{info.folderCount === 1 ? "" : "s"}
              </dd>
            </div>
            <div className="delete-folder-detail-row">
              <dt>
                <Calendar size={14} aria-hidden="true" /> Created
              </dt>
              <dd>{formatDate(info.createdAt)}</dd>
            </div>
          </dl>
        )}

        <div className="delete-folder-actions">
          <button
            type="button"
            className="delete-folder-cancel"
            onClick={onCancel}
            disabled={isDeleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="delete-folder-confirm"
            onClick={handleConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? "Deleting..." : "Delete Folder"}
          </button>
        </div>
      </div>
    </div>
  );
};
