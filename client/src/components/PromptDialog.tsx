import React, { useEffect, useRef, useState } from "react";
import "./PromptDialog.css";

interface PromptDialogProps {
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Unique id/name for the input — distinguishes this dialog's field from others so browsers don't mistake it for a saved login field. */
  inputName: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/** Reusable modal replacement for window.prompt() */
export const PromptDialog: React.FC<PromptDialogProps> = ({
  title,
  label,
  placeholder,
  initialValue = "",
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  inputName,
  onConfirm,
  onCancel,
}) => {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <div
      className="prompt-dialog-overlay"
      onClick={onCancel}
      role="presentation"
    >
      <form
        className="prompt-dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-dialog-title"
      >
        <h3 className="prompt-dialog-title" id="prompt-dialog-title">
          {title}
        </h3>
        {label && (
          <label className="prompt-dialog-label" htmlFor={inputName}>
            {label}
          </label>
        )}
        <input
          ref={inputRef}
          id={inputName}
          name={inputName}
          type="text"
          className="prompt-dialog-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          data-form-type="other"
        />
        <div className="prompt-dialog-actions">
          <button
            type="button"
            className="prompt-dialog-cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            className="prompt-dialog-confirm"
            disabled={!value.trim()}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
};
