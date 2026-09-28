import { useEffect, useState } from "react";
import { Share2, X } from "lucide-react";

export default function ShareProjectModal({
    isOpen,
    onClose,
    projectTitle,
    onShare,
    loading = false,
}) {
    const [email, setEmail] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
        if (isOpen) {
            setEmail("");
            setError("");
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleSubmit = async (event) => {
        event.preventDefault();
        const trimmedEmail = email.trim().toLowerCase();

        if (!trimmedEmail) {
            setError("Enter a collaborator email address.");
            return;
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
            setError("Enter a valid email address.");
            return;
        }

        setError("");

        try {
            await onShare({ email: trimmedEmail, role: "editor" });
        } catch (err) {
            setError(err?.message || "Failed to share the project. Please try again.");
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/40 px-4 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-[26px] border border-slate-200 bg-white p-6 shadow-2xl">
                <div className="mb-5 flex items-start justify-between gap-4">
                    <div>
                        <div className="mb-2 flex items-center gap-2 text-indigo-600">
                            <Share2 className="h-5 w-5" />
                            <span className="text-sm font-bold uppercase tracking-wide">Share Project</span>
                        </div>
                        <h2 className="text-2xl font-black text-slate-900">Invite a collaborator</h2>
                        {projectTitle && (
                            <p className="mt-1 break-words text-sm text-slate-500">{projectTitle}</p>
                        )}
                    </div>

                    <button
                        type="button"
                        onClick={onClose}
                        disabled={loading}
                        className="rounded-xl p-2 text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"
                        aria-label="Close share project dialog"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                    <div>
                        <label htmlFor="share-email" className="mb-2 block text-sm font-semibold text-slate-700">
                            Collaborator email
                        </label>
                        <input
                            id="share-email"
                            type="email"
                            value={email}
                            onChange={(event) => {
                                setEmail(event.target.value);
                                if (error) setError("");
                            }}
                            placeholder="collaborator@example.com"
                            disabled={loading}
                            autoFocus
                            className="w-full rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100"
                        />
                    </div>

                    <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3">
                        <p className="text-sm font-semibold text-indigo-900">Permission: Editor</p>
                        <p className="mt-1 text-sm text-indigo-700">
                            Editors can view the project and create, edit, or delete annotations.
                        </p>
                    </div>

                    {error && (
                        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                            {error}
                        </p>
                    )}

                    <div className="flex justify-end gap-3">
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={loading}
                            className="rounded-xl border border-slate-300 px-4 py-2.5 font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={loading}
                            className="rounded-xl bg-indigo-600 px-4 py-2.5 font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {loading ? "Sharing..." : "Share Project"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
