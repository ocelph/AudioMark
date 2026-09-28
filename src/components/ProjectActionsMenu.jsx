import { useState, useRef, useEffect } from "react";
import { MoreHorizontal, Edit, Share2, Trash2 } from "lucide-react";

export default function ProjectActionsMenu({ projectId, projectTitle, onEdit, onShare, onDelete }) {
    const [isOpen, setIsOpen] = useState(false);
    const menuRef = useRef(null);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (menuRef.current && !menuRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleAction = (action) => {
        setIsOpen(false);
        action();
    };

    return (
        <div className="relative" ref={menuRef}>
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="rounded-xl border border-slate-200 bg-slate-50 p-2 text-slate-600 transition hover:bg-slate-100"
                aria-label="Project options"
            >
                <MoreHorizontal className="h-4 w-4" />
            </button>

            {isOpen && (
                <div className="absolute right-0 mt-2 w-48 rounded-lg border border-slate-200 bg-white shadow-lg z-40">
                    <button
                        type="button"
                        onClick={() => handleAction(onEdit)}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 border-b border-slate-100"
                    >
                        <Edit className="h-4 w-4 text-slate-500" />
                        Edit
                    </button>

                    <button
                        type="button"
                        onClick={() => handleAction(onShare)}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 border-b border-slate-100"
                    >
                        <Share2 className="h-4 w-4 text-slate-500" />
                        Share
                    </button>

                    <button
                        type="button"
                        onClick={() => handleAction(onDelete)}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50 rounded-b-lg"
                    >
                        <Trash2 className="h-4 w-4" />
                        Delete
                    </button>
                </div>
            )}
        </div>
    );
}
