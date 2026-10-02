import { useEffect, useState } from "react";
import { Mail, Share2, X } from "lucide-react";
import { arrayRemove, arrayUnion, deleteDoc, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { db } from "../services/firebase";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ShareProjectModal({
  isOpen,
  onClose,
  projectId,
  ownerId,
  projectTitle,
  ownerName,
  sharedWith = [],
  sharedPermissions = [],
  onSharedWithChange,
}) {
  const [email, setEmail] = useState("");
  const [recipients, setRecipients] = useState(sharedWith);
  const [permissions, setPermissions] = useState(sharedPermissions);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRecipients(sharedWith || []);
    setPermissions(sharedPermissions || []);
  }, [sharedWith, sharedPermissions, isOpen]);

  if (!isOpen) return null;

  const projectRef = doc(db, "users", ownerId, "projects", projectId);
  const accessRef = (recipient) =>
    doc(db, "shared_projects", recipient, "projects", `${ownerId}_${projectId}`);

  const addRecipient = async (event) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();

    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      setError("Enter a valid email address.");
      return;
    }

    if (recipients.includes(normalizedEmail)) {
      setError("This email has already been added.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const newPermission = { email: normalizedEmail, role: "viewer" };
      await updateDoc(projectRef, {
        shared_with: arrayUnion(normalizedEmail),
        shared_permissions: arrayUnion(newPermission),
      });
      const projectSnapshot = await getDoc(projectRef);
      const projectData = projectSnapshot.data();
      delete projectData.last_accessed_by;
      delete projectData.last_accessed_at;
      await setDoc(accessRef(normalizedEmail), {
        ...projectData,
        ownerId,
        projectId,
        projectTitle,
        owner_name: ownerName,
        role: "viewer",
      });
      const nextRecipients = [...recipients, normalizedEmail];
      const nextPermissions = [...permissions, newPermission];
      setRecipients(nextRecipients);
      setPermissions(nextPermissions);
      onSharedWithChange?.(nextRecipients, nextPermissions);
      setEmail("");
    } catch (err) {
      console.error("Error sharing project:", err);
      setError("Unable to share this project right now.");
    } finally {
      setSaving(false);
    }
  };

  const removeRecipient = async (recipient) => {
    setSaving(true);
    setError("");
    try {
      const permission = permissions.find((item) => item.email === recipient);
      await updateDoc(projectRef, {
        shared_with: arrayRemove(recipient),
        ...(permission && { shared_permissions: arrayRemove(permission) }),
      });
      await deleteDoc(accessRef(recipient));
      const nextRecipients = recipients.filter((item) => item !== recipient);
      const nextPermissions = permissions.filter((item) => item.email !== recipient);
      setRecipients(nextRecipients);
      setPermissions(nextPermissions);
      onSharedWithChange?.(nextRecipients, nextPermissions);
    } catch (err) {
      console.error("Error removing project share:", err);
      setError("Unable to remove this email right now.");
    } finally {
      setSaving(false);
    }
  };

  const updateRole = async (recipient, role) => {
    const nextPermission = { email: recipient, role };

    setSaving(true);
    setError("");
    try {
      const nextPermissions = [
        ...permissions.filter((item) => item.email !== recipient),
        nextPermission,
      ];
      await updateDoc(projectRef, {
        shared_permissions: nextPermissions,
      });
      await updateDoc(accessRef(recipient), { role });
      setPermissions(nextPermissions);
      onSharedWithChange?.(recipients, nextPermissions);
    } catch (err) {
      console.error("Error updating project permission:", err);
      setError("Unable to update this permission right now.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Share project</h2>
            <p className="mt-1 max-w-xs truncate text-sm text-slate-500">{projectTitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close share project dialog"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          <form onSubmit={addRecipient} className="space-y-2">
            <label htmlFor="share-email" className="block text-sm font-medium text-slate-700">
              Add people by email
            </label>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="share-email"
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setError("");
                  }}
                  placeholder="name@example.com"
                  disabled={saving}
                  className="w-full rounded-lg border border-slate-200 py-2.5 pl-9 pr-3 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <button
                type="submit"
                disabled={saving || !email.trim()}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Share2 className="h-4 w-4" />
                Add
              </button>
            </div>
          </form>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div>
            <h3 className="mb-2 text-sm font-medium text-slate-700">People with access</h3>
            {recipients.length === 0 ? (
              <p className="text-sm text-slate-500">No one has access yet.</p>
            ) : (
              <ul className="max-h-48 space-y-2 overflow-y-auto">
                {recipients.map((recipient) => (
                  <li
                    key={recipient}
                    className="flex min-w-0 items-center gap-3 rounded-lg bg-slate-50 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 break-words text-sm text-slate-700">{recipient}</span>
                    <select
                      aria-label={`Permission for ${recipient}`}
                      value={permissions.find((item) => item.email === recipient)?.role || "viewer"}
                      onChange={(event) => updateRole(recipient, event.target.value)}
                      disabled={saving}
                      className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removeRecipient(recipient)}
                      disabled={saving}
                      className="shrink-0 text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
