import React, { useState, useEffect, useRef, useMemo } from "react";
import { FolderNode } from "../types";
import { api } from "../services/api";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { PromptDialog } from "./PromptDialog";
import { DeleteFolderDialog } from "./DeleteFolderDialog";
import "./FolderTree.css";

interface FolderTreeProps {
  node: FolderNode;
  onSelectFolder: (path: string) => void;
  selectedFolder: string | null;
  onRefresh: () => void;
  expandedFolders?: Set<string>;
  keyboardSelectedPath?: string | null;
  onFolderHover?: (path: string) => void;
  onRequestMove?: (sourcePath: string) => void;
  deletingPath?: string | null;
}

const FolderTreeItem: React.FC<FolderTreeProps> = ({
  node,
  onSelectFolder,
  selectedFolder,
  onRefresh,
  expandedFolders,
  keyboardSelectedPath,
  onFolderHover,
  onRequestMove,
  deletingPath,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const isSelected = selectedFolder === node.path;
  const isKeyboardSelected = keyboardSelectedPath === node.path;
  const hasChildren = node.children.length > 0;
  const isDeleting = deletingPath === node.path;
  const isBusy = isDeleting;

  // Sync with parent's expanded state if provided
  useEffect(() => {
    if (expandedFolders) {
      setIsExpanded(expandedFolders.has(node.path));
    }
  }, [expandedFolders, node.path]);

  const handleToggle = () => {
    setIsExpanded(!isExpanded);
  };

  const handleSelect = () => {
    onSelectFolder(node.path);
  };

  return (
    <div
      className="folder-tree-item"
      role="treeitem"
      aria-expanded={hasChildren ? isExpanded : undefined}
    >
      <div
        className={`folder-item ${isSelected ? "selected" : ""} ${isKeyboardSelected ? "keyboard-selected" : ""} ${isBusy ? "busy" : ""}`}
        onClick={handleSelect}
        onMouseEnter={() => onFolderHover?.(node.path)}
        role="button"
        tabIndex={-1}
        aria-label={`Folder: ${node.name}${isSelected ? " (selected)" : ""}`}
        aria-busy={isBusy}
      >
        <button
          className="folder-toggle"
          onClick={(e) => {
            e.stopPropagation();
            handleToggle();
          }}
          aria-label={
            hasChildren
              ? isExpanded
                ? "Collapse folder"
                : "Expand folder"
              : undefined
          }
          aria-hidden={!hasChildren}
          tabIndex={hasChildren ? 0 : -1}
        >
          <span aria-hidden="true">
            {hasChildren &&
              (isExpanded ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              ))}
            {!hasChildren && (
              <span style={{ width: "12px", display: "inline-block" }}></span>
            )}
          </span>
        </button>
        <span className="folder-name">
          {isDeleting ? (
            <Loader2
              size={14}
              className="loading-spinner"
              aria-hidden="true"
            />
          ) : (
            <Folder size={14} aria-hidden="true" />
          )}{" "}
          {node.name}
        </span>
      </div>
      {isExpanded && hasChildren && (
        <div className="folder-children" role="group">
          {node.children.map((child) => (
            <FolderTreeItem
              key={child.path}
              node={child}
              onSelectFolder={onSelectFolder}
              selectedFolder={selectedFolder}
              onRefresh={onRefresh}
              expandedFolders={expandedFolders}
              keyboardSelectedPath={keyboardSelectedPath}
              onFolderHover={onFolderHover}
              onRequestMove={onRequestMove}
              deletingPath={deletingPath}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/** Recursive folder picker — excludes the folder being moved and its descendants */
const renderPickerNodes = (
  node: FolderNode,
  excludePath: string,
  selectedPath: string,
  onSelect: (path: string) => void,
  indent: number,
): React.ReactNode => {
  return node.children.map((child) => {
    if (
      child.path === excludePath ||
      child.path.startsWith(`${excludePath}/`)
    ) {
      return null;
    }
    return (
      <React.Fragment key={child.path}>
        <button
          className={`move-picker-item ${selectedPath === child.path ? "selected" : ""}`}
          style={{ paddingLeft: `${indent * 16 + 8}px` }}
          onClick={() => onSelect(child.path)}
          role="option"
          aria-selected={selectedPath === child.path}
        >
          <Folder size={14} aria-hidden="true" /> {child.name}
        </button>
        {renderPickerNodes(
          child,
          excludePath,
          selectedPath,
          onSelect,
          indent + 1,
        )}
      </React.Fragment>
    );
  });
};

export const FolderTree: React.FC<
  Omit<FolderTreeProps, "node"> & { root: FolderNode }
> = ({ root, onSelectFolder, selectedFolder, onRefresh }) => {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set([root.path]),
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [keyboardSelectedPath, setKeyboardSelectedPath] = useState<
    string | null
  >(root.path);
  const [moveSource, setMoveSource] = useState<string | null>(null);
  const [moveDestination, setMoveDestination] = useState<string>("");
  const [isMoving, setIsMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [isFolderPromptOpen, setIsFolderPromptOpen] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [isRenamePromptOpen, setIsRenamePromptOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const treeRef = useRef<HTMLElement>(null);

  const canModifySelected = !!selectedFolder && selectedFolder !== "/";

  // Flatten visible folders for keyboard navigation
  const visibleFolders = useMemo(() => {
    const folders: string[] = [];
    const traverse = (node: FolderNode) => {
      folders.push(node.path);
      if (expandedFolders.has(node.path)) {
        node.children.forEach(traverse);
      }
    };
    traverse(root);
    return folders;
  }, [root, expandedFolders]);

  // Track expanded folders
  useEffect(() => {
    const getAllFolderPaths = (node: FolderNode): string[] => {
      return [node.path, ...node.children.flatMap(getAllFolderPaths)];
    };
    // Auto-expand all folders by default
    setExpandedFolders(new Set(getAllFolderPaths(root)));
  }, [root]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!treeRef.current?.contains(document.activeElement)) return;

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        const newIndex = Math.min(selectedIndex + 1, visibleFolders.length - 1);
        setSelectedIndex(newIndex);
        setKeyboardSelectedPath(visibleFolders[newIndex]);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        const newIndex = Math.max(selectedIndex - 1, 0);
        setSelectedIndex(newIndex);
        setKeyboardSelectedPath(visibleFolders[newIndex]);
      } else if (e.key === "Enter" && keyboardSelectedPath) {
        e.preventDefault();
        onSelectFolder(keyboardSelectedPath);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedIndex, visibleFolders, keyboardSelectedPath, onSelectFolder]);

  const handleFolderHover = (path: string) => {
    const index = visibleFolders.indexOf(path);
    if (index !== -1) {
      setSelectedIndex(index);
      setKeyboardSelectedPath(path);
    }
  };

  const handleRequestMove = (sourcePath: string) => {
    setMoveSource(sourcePath);
    setMoveDestination("");
    setMoveError(null);
  };

  const handleMoveConfirm = async () => {
    if (!moveSource) return;
    setIsMoving(true);
    setMoveError(null);
    try {
      await api.moveFolder(moveSource, moveDestination);
      setMoveSource(null);
      onRefresh();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : ((err as { response?: { data?: { message?: string } } })?.response
              ?.data?.message ?? "Failed to move folder");
      setMoveError(msg);
    } finally {
      setIsMoving(false);
    }
  };

  const handleToolbarCreateFolder = () => {
    setIsFolderPromptOpen(true);
  };

  const handleCreateFolderConfirm = async (folderName: string) => {
    setIsFolderPromptOpen(false);
    setIsCreatingFolder(true);
    try {
      const base =
        !selectedFolder || selectedFolder === "/" ? "" : selectedFolder;
      const newPath = base ? `${base}/${folderName}` : folderName;
      await api.createFolder(newPath);
      onRefresh();
    } catch (err) {
      console.error("Failed to create folder:", err);
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const handleToolbarRename = () => {
    if (!canModifySelected || !selectedFolder) return;
    setIsRenamePromptOpen(true);
  };

  const handleRenameConfirm = async (newName: string) => {
    setIsRenamePromptOpen(false);
    if (!selectedFolder) return;
    const currentName = selectedFolder.split("/").pop() ?? selectedFolder;
    if (newName !== currentName) {
      try {
        const parentPath = selectedFolder.split("/").slice(0, -1).join("/");
        const newPath = parentPath ? `${parentPath}/${newName}` : newName;
        await api.renameFolder(selectedFolder, newPath);
        onRefresh();
      } catch (err) {
        console.error("Failed to rename folder:", err);
      }
    }
  };

  const handleToolbarDelete = () => {
    if (!canModifySelected || !selectedFolder) return;
    setDeleteTarget(selectedFolder);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeletingPath(target);
    try {
      await api.deleteFolder(target);
      onRefresh();
      onSelectFolder("/");
    } catch (err) {
      console.error("Failed to delete folder:", err);
    } finally {
      setDeletingPath(null);
      setDeleteTarget(null);
    }
  };

  return (
    <nav
      ref={treeRef}
      className="folder-tree"
      aria-label="Folder navigation tree"
      role="tree"
      tabIndex={0}
    >
      <div className="folder-tree-header">
        <h3>Folders</h3>
        <button
          onClick={onRefresh}
          className="refresh-btn"
          aria-label="Refresh folders"
          title="Refresh folders"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="folder-tree-toolbar">
        <button
          className="folder-toolbar-btn"
          onClick={handleToolbarCreateFolder}
          disabled={isCreatingFolder}
          title="New folder"
          aria-label="New folder"
        >
          <FolderPlus size={14} aria-hidden="true" />
        </button>
        <button
          className="folder-toolbar-btn"
          onClick={handleToolbarRename}
          disabled={!canModifySelected}
          title="Rename folder"
          aria-label="Rename folder"
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
        <button
          className="folder-toolbar-btn"
          onClick={() => selectedFolder && handleRequestMove(selectedFolder)}
          disabled={!canModifySelected}
          title="Move to..."
          aria-label="Move to..."
        >
          <FolderInput size={14} aria-hidden="true" />
        </button>
        <button
          className="folder-toolbar-btn"
          onClick={handleToolbarDelete}
          disabled={!canModifySelected}
          title="Delete folder"
          aria-label="Delete folder"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="folder-tree-body">
        <FolderTreeItem
          node={root}
          onSelectFolder={onSelectFolder}
          selectedFolder={selectedFolder}
          onRefresh={onRefresh}
          expandedFolders={expandedFolders}
          keyboardSelectedPath={keyboardSelectedPath}
          onFolderHover={handleFolderHover}
          onRequestMove={handleRequestMove}
          deletingPath={deletingPath}
        />
      </div>
      {isFolderPromptOpen && (
        <PromptDialog
          title="New Folder"
          label="Folder name:"
          inputName="new-folder-name"
          confirmLabel="Create"
          onConfirm={handleCreateFolderConfirm}
          onCancel={() => setIsFolderPromptOpen(false)}
        />
      )}
      {isRenamePromptOpen && selectedFolder && (
        <PromptDialog
          title="Rename Folder"
          label="Folder name:"
          inputName="rename-folder-name"
          initialValue={selectedFolder.split("/").pop() ?? selectedFolder}
          confirmLabel="Rename"
          onConfirm={handleRenameConfirm}
          onCancel={() => setIsRenamePromptOpen(false)}
        />
      )}
      {deleteTarget && (
        <DeleteFolderDialog
          folderPath={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {moveSource && (
        <div
          className="move-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Move folder"
        >
          <div className="move-modal">
            <h3 className="move-modal-title">
              Move "{moveSource.split("/").pop()}"
            </h3>
            <p className="move-modal-subtitle">Select destination folder:</p>
            <div
              className="move-picker"
              role="listbox"
              aria-label="Destination folder"
            >
              <button
                className={`move-picker-item move-picker-root ${moveDestination === "" ? "selected" : ""}`}
                onClick={() => setMoveDestination("")}
                role="option"
                aria-selected={moveDestination === ""}
              >
                <Folder size={14} aria-hidden="true" /> Root (top level)
              </button>
              {renderPickerNodes(
                root,
                moveSource,
                moveDestination,
                setMoveDestination,
                1,
              )}
            </div>
            {moveError && (
              <p className="move-modal-error" role="alert">
                {moveError}
              </p>
            )}
            <div className="move-modal-actions">
              <button
                className="move-modal-cancel"
                onClick={() => setMoveSource(null)}
                disabled={isMoving}
              >
                Cancel
              </button>
              <button
                className="move-modal-confirm"
                onClick={handleMoveConfirm}
                disabled={isMoving || moveDestination === moveSource}
              >
                {isMoving ? "Moving..." : "Move Here"}
              </button>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
};
