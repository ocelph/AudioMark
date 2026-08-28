import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { auth, db } from "../services/firebase";
import { doc, getDoc, collection, addDoc, updateDoc, deleteDoc, serverTimestamp, onSnapshot, query, orderBy } from "firebase/firestore";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import { Download, History, Share2, Maximize2, Search, Plus, X } from "lucide-react";

// Default annotation classes shown in the "Annotation Class" picker.
// Custom classes added via "+ Create New Label" get a color from PALETTE.
const DEFAULT_CLASSES = [
  { name: "Default Class", color: "#22c55e" },
  { name: "Custom Label", color: "#3b82f6" },
  { name: "Miscellaneous Sound", color: "#f97316" },
];
const PALETTE = ["#a855f7", "#ec4899", "#14b8a6", "#eab308", "#ef4444", "#06b6d4"];

const getInitials = (nameOrEmail) => {
  if (!nameOrEmail) return "U";
  const base = nameOrEmail.includes("@") ? nameOrEmail.split("@")[0] : nameOrEmail;
  return base.slice(0, 2).toUpperCase();
};

// Shared validation for both the manual "create" form and the "edit" form.
// Checks required fields, a valid time range, length limits, and one hard
// edge case (exact duplicate time range — blocked).
const validateAnnotationFields = ({ label, start, end, comment }, { annotations, excludeId }) => {
  const errors = {};
  const trimmedLabel = (label || "").trim();

  if (!trimmedLabel) errors.label = "Label is required";
  else if (trimmedLabel.length > 100) errors.label = "Label must be under 100 characters";

  if (!Number.isFinite(start) || start < 0) errors.start = "Start time must be 0 or greater";
  if (!Number.isFinite(end) || end <= start) errors.end = "End time must be greater than start time";

  if (comment && comment.trim().length > 500) errors.comment = "Comment must be under 500 characters";

  if (!errors.start && !errors.end) {
    const duplicate = annotations.some(
      (a) => a.id !== excludeId && a.startTime === start && a.endTime === end
    );
    if (duplicate) errors.end = "An annotation with this exact time range already exists";
  }

  return errors;
};

// Soft edge case — overlapping ranges are allowed, but we warn about them.
const findOverlap = (annotations, start, end, excludeId) =>
  annotations.find((a) => a.id !== excludeId && start < a.endTime && end > a.startTime);

export default function AnnotationPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();

  const [uid, setUid] = useState(null);
  const [userInitials, setUserInitials] = useState("U");
  const [audioUrl, setAudioUrl] = useState(null);
  const [fileName, setFileName] = useState("");
  const [annotations, setAnnotations] = useState([]);
  const [selectedAnnotation, setSelectedAnnotation] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [editStart, setEditStart] = useState(0);
  const [editEnd, setEditEnd] = useState(0);
  const [editComment, setEditComment] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [annotationToDelete, setAnnotationToDelete] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const waveformRef = useRef(null);
  const wavesurferRef = useRef(null);

  // Temporary manual annotation creation (stand-in for waveform-drag creation)
  const [classes, setClasses] = useState(DEFAULT_CLASSES);
  const [classSearch, setClassSearch] = useState("");
  const [selectedClassIndex, setSelectedClassIndex] = useState(0);
  const [newLabelName, setNewLabelName] = useState("");
  const [createStart, setCreateStart] = useState("");
  const [createEnd, setCreateEnd] = useState("");
  const [createComment, setCreateComment] = useState("");
  const [createErrors, setCreateErrors] = useState({});
  const [createWarning, setCreateWarning] = useState("");
  const [editErrors, setEditErrors] = useState({});
  const [editWarning, setEditWarning] = useState("");
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(320);
  const resizingRef = useRef(null); // "left" | "right" | null

  // Load project (the project doc doubles as the "file" — one project = one recording)
  useEffect(() => {
    const loadProject = async () => {
      try {
        const user = auth.currentUser;
        if (!user) {
          navigate("/login");
          return;
        }
        const projectSnap = await getDoc(doc(db, "users", user.uid, "projects", projectId));
        if (projectSnap.exists()) {
          const data = projectSnap.data();
          setFileName(data.project_title);
          setAudioUrl(data.download_url);
          setUid(user.uid);
          setUserInitials(getInitials(user.displayName || user.email));
        } else {
          setError("Project not found.");
        }
      } catch (err) {
        console.error("Error loading project:", err);
        setError("Failed to load project.");
      } finally {
        setLoading(false);
      }
    };
    loadProject();
  }, [projectId, navigate]);

  // Load annotations in real time (only once we know the uid)
  useEffect(() => {
    if (!uid) return;
    const q = query(
      collection(db, "users", uid, "projects", projectId, "annotations"),
      orderBy("createdAt", "asc")
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAnnotations(data);
    });
    return () => unsubscribe();
  }, [uid, projectId]);

  // Init WaveSurfer — waveform rendering/region creation is a separate ticket;
  // this just wires the container up so it's ready.
  useEffect(() => {
    if (!audioUrl || !waveformRef.current || !uid) return;

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: "rgba(99, 102, 241, 0.4)",
      progressColor: "#6366f1",
      cursorColor: "#1e1b4b",
      height: 120,
      barWidth: 2,
      barGap: 1,
      barRadius: 3,
      url: audioUrl,
      plugins: [regions],
    });
    wavesurferRef.current = ws;
    ws.on("play", () => setIsPlaying(true));
    ws.on("pause", () => setIsPlaying(false));

    return () => ws.destroy();
  }, [audioUrl, uid]);

  // Panel resizing (ADP-84) — drag the dividers between panels
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (resizingRef.current === "left") {
        setLeftWidth(Math.min(480, Math.max(220, e.clientX)));
      } else if (resizingRef.current === "right") {
        setRightWidth(Math.min(480, Math.max(260, window.innerWidth - e.clientX)));
      }
    };
    const handleMouseUp = () => {
      resizingRef.current = null;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const handleAddClass = () => {
    const trimmed = newLabelName.trim();
    if (!trimmed) return;
    const color = PALETTE[classes.length % PALETTE.length];
    setClasses((prev) => [...prev, { name: trimmed, color }]);
    setSelectedClassIndex(classes.length);
    setNewLabelName("");
  };

  const handleCreateAnnotation = async () => {
    if (!uid) return;
    const start = parseFloat(createStart);
    const end = parseFloat(createEnd);
    const label = classes[selectedClassIndex]?.name || "";

    const errors = validateAnnotationFields(
      { label, start, end, comment: createComment },
      { annotations, excludeId: null }
    );
    setCreateErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const overlap = findOverlap(annotations, start, end, null);
    setCreateWarning(overlap ? `Heads up — this overlaps with "${overlap.label}".` : "");

    try {
      await addDoc(collection(db, "users", uid, "projects", projectId, "annotations"), {
        startTime: start,
        endTime: end,
        label,
        annotationClass: classes[selectedClassIndex],
        comment: createComment.trim(),
        createdAt: serverTimestamp(),
      });
      setCreateStart("");
      setCreateEnd("");
      setCreateComment("");
      setCreateErrors({});
    } catch (err) {
      console.error("Failed to create annotation:", err);
    }
  };

  const handleSelectAnnotation = (annotation) => {
    setSelectedAnnotation(annotation);
    setIsEditing(false);
  };

  const handleEditOpen = () => {
    setEditLabel(selectedAnnotation.label);
    setEditStart(selectedAnnotation.startTime);
    setEditEnd(selectedAnnotation.endTime);
    setEditComment(selectedAnnotation.comment || "");
    setIsEditing(true);
  };

  // Now persists to Firestore, then updates what's shown in the panel.
  const handleSaveEdit = async () => {
    const start = parseFloat(editStart);
    const end = parseFloat(editEnd);

    const errors = validateAnnotationFields(
      { label: editLabel, start, end, comment: editComment },
      { annotations, excludeId: selectedAnnotation.id }
    );
    setEditErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const overlap = findOverlap(annotations, start, end, selectedAnnotation.id);
    setEditWarning(overlap ? `Heads up — this overlaps with "${overlap.label}".` : "");

    try {
      await updateDoc(doc(db, "users", uid, "projects", projectId, "annotations", selectedAnnotation.id), {
        label: editLabel.trim(),
        startTime: start,
        endTime: end,
        comment: editComment.trim(),
      });
      setSelectedAnnotation({
        ...selectedAnnotation,
        label: editLabel.trim(),
        startTime: start,
        endTime: end,
        comment: editComment.trim(),
      });
      setIsEditing(false);
    } catch (err) {
      console.error("Failed to update annotation:", err);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleClosePanel = () => {
    setSelectedAnnotation(null);
    setIsEditing(false);
  };

  const handleDeleteClick = (annotation) => {
    setAnnotationToDelete(annotation);
    setShowDeleteConfirm(true);
  };

  const handleConfirmDelete = async () => {
    try {
      await deleteDoc(doc(db, "users", uid, "projects", projectId, "annotations", annotationToDelete.id));
      if (selectedAnnotation?.id === annotationToDelete.id) {
        setSelectedAnnotation(null);
        setIsEditing(false);
      }
      setShowDeleteConfirm(false);
      setAnnotationToDelete(null);
    } catch (err) {
      console.error("Failed to delete annotation:", err);
    }
  };

  const handleCancelDelete = () => {
    setShowDeleteConfirm(false);
    setAnnotationToDelete(null);
  };

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-slate-50">
      <p className="text-slate-500">Loading audio file...</p>
    </div>
  );

  if (error) return (
    <div className="flex h-screen items-center justify-center bg-slate-50">
      <p className="text-red-500">{error}</p>
    </div>
  );

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate("/dashboard")}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition"
          >
            ← Dashboard
          </button>
          <h1 className="text-lg font-semibold text-slate-800">{fileName}</h1>
        </div>

        <div className="flex items-center gap-2 text-sm text-slate-500">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
            {userInitials}
          </div>
          <span>1 collaborator</span>
        </div>

        {/* Non-functional placeholders — separate tickets */}
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition">
            <Download className="h-4 w-4" /> Download
          </button>
          <button className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition">
            <History className="h-4 w-4" /> Log History
          </button>
          <button className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition">
            <Share2 className="h-4 w-4" /> Share
          </button>
          <button className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition">
            <Maximize2 className="h-4 w-4" /> Expand All Annotations
          </button>
        </div>
      </div>

      {/* Main content — static-width panels for now; dragging to resize comes in a later commit (ADP-84) */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — temporary manual annotation creation (stand-in for waveform-drag creation) */}
        <div style={{ width: leftWidth }} className="flex-shrink-0 overflow-y-auto border-r border-slate-200 bg-white px-4 py-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Timestamps</h2>
          <div className="mb-4 grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Start (s)</label>
              <input
                type="number"
                step="0.1"
                value={createStart}
                onChange={(e) => setCreateStart(e.target.value)}
                className={`w-full rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${
                  createErrors.start ? "border-red-400" : "border-slate-200"
                }`}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">End (s)</label>
              <input
                type="number"
                step="0.1"
                value={createEnd}
                onChange={(e) => setCreateEnd(e.target.value)}
                className={`w-full rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${
                  createErrors.end ? "border-red-400" : "border-slate-200"
                }`}
              />
            </div>
          </div>
          {createErrors.start && <p className="mb-2 text-xs text-red-500">{createErrors.start}</p>}
          {createErrors.end && <p className="mb-2 text-xs text-red-500">{createErrors.end}</p>}

          <h2 className="mb-2 mt-2 text-sm font-semibold text-slate-700">Annotation Class</h2>
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              value={classSearch}
              onChange={(e) => setClassSearch(e.target.value)}
              placeholder="Search or select label"
              className="w-full text-sm outline-none"
            />
          </div>
          <div className="mb-2 flex flex-col gap-1">
            {classes
              .filter((c) => c.name.toLowerCase().includes(classSearch.trim().toLowerCase()))
              .map((c) => {
                const idx = classes.indexOf(c);
                return (
                  <button
                    key={c.name}
                    onClick={() => setSelectedClassIndex(idx)}
                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${
                      selectedClassIndex === idx ? "bg-indigo-50 text-indigo-700" : "hover:bg-slate-50 text-slate-700"
                    }`}
                  >
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.color }} />
                    {c.name}
                  </button>
                );
              })}
          </div>
          <div className="mb-4 flex gap-2">
            <input
              value={newLabelName}
              onChange={(e) => setNewLabelName(e.target.value)}
              placeholder="+ Create New Label"
              className="w-full rounded-lg border border-dashed border-slate-300 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-300"
              onKeyDown={(e) => e.key === "Enter" && handleAddClass()}
            />
            <button
              onClick={handleAddClass}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-slate-500 hover:bg-slate-50 transition"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Comments</label>
          <textarea
            value={createComment}
            onChange={(e) => setCreateComment(e.target.value)}
            rows={3}
            className={`mb-2 w-full rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${
              createErrors.comment ? "border-red-400" : "border-slate-200"
            }`}
            placeholder="Add a note about this annotation..."
          />
          {createErrors.comment && <p className="mb-2 text-xs text-red-500">{createErrors.comment}</p>}
          {createWarning && <p className="mb-2 text-xs text-amber-600">{createWarning}</p>}

          <button
            onClick={handleCreateAnnotation}
            className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition"
          >
            Create Annotation
          </button>
          <p className="mt-2 text-xs text-slate-400">
            Enter a time range manually to create an annotation. Dragging directly on the waveform is a separate feature.
          </p>
        </div>

        {/* Drag handle — resize left panel */}
        <div
          onMouseDown={() => (resizingRef.current = "left")}
          className="w-1.5 flex-shrink-0 cursor-col-resize bg-slate-100 hover:bg-indigo-200 transition"
        />

        {/* Center — waveform + annotation list */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-6 py-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-400">
              Click and drag on the waveform to create an annotation
            </p>
            <div ref={waveformRef} className="w-full rounded-xl bg-slate-50 p-2" />
            <div className="mt-3 flex gap-3">
              <button
                onClick={() => wavesurferRef.current?.playPause()}
                className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition"
              >
                {isPlaying ? "⏸ Pause" : "▶ Play"}
              </button>
              <button
                onClick={() => wavesurferRef.current?.stop()}
                className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-600 hover:bg-slate-50 transition"
              >
                ■ Stop
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="mb-3 flex items-center justify-between gap-4">
              <h2 className="text-sm font-semibold text-slate-700">
                Annotations ({annotations.length})
              </h2>
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
                <Search className="h-4 w-4 text-slate-400" />
                <input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search annotations..."
                  className="text-sm outline-none"
                />
              </div>
            </div>

            {annotations.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400">
                No annotations yet — use the form on the left to create one.
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Start Time</th>
                      <th className="px-3 py-2">End Time</th>
                      <th className="px-3 py-2">Label</th>
                      <th className="px-3 py-2">User</th>
                      <th className="px-3 py-2">Comments</th>
                      <th className="px-3 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {annotations
                      .filter((a) => {
                        const term = searchTerm.trim().toLowerCase();
                        if (!term) return true;
                        return (
                          (a.label || "").toLowerCase().includes(term) ||
                          (a.comment || "").toLowerCase().includes(term)
                        );
                      })
                      .map((ann) => {
                        const dotColor = ann.annotationClass?.color || "#94a3b8";
                        return (
                          <tr
                            key={ann.id}
                            onClick={() => handleSelectAnnotation(ann)}
                            className={`cursor-pointer border-t border-slate-100 transition hover:bg-slate-50 ${
                              selectedAnnotation?.id === ann.id ? "bg-indigo-50/60" : "bg-white"
                            }`}
                          >
                            <td className="px-3 py-2 text-slate-700">{ann.startTime}s</td>
                            <td className="px-3 py-2 text-slate-700">{ann.endTime}s</td>
                            <td className="px-3 py-2">
                              <span className="flex items-center gap-2 text-slate-800">
                                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: dotColor }} />
                                {ann.label}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700">
                                {userInitials}
                              </div>
                            </td>
                            <td className="max-w-[220px] truncate px-3 py-2 text-slate-500">{ann.comment}</td>
                            <td className="px-3 py-2">
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteClick(ann); }}
                                className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 transition"
                                title="Delete"
                              >
                                🗑
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Drag handle — resize right panel */}
        <div
          onMouseDown={() => (resizingRef.current = "right")}
          className="w-1.5 flex-shrink-0 cursor-col-resize bg-slate-100 hover:bg-indigo-200 transition"
        />

        {/* Right panel — Annotation Details */}
        <div style={{ width: rightWidth }} className="flex-shrink-0 overflow-y-auto border-l border-slate-200 bg-white px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Annotation Details</h2>
            {selectedAnnotation && (
              <button onClick={handleClosePanel} className="text-slate-400 hover:text-slate-600 transition">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {!selectedAnnotation ? (
            <p className="text-sm text-slate-400">Select an annotation from the table to view its details.</p>
          ) : !isEditing ? (
            <div className="flex flex-col gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Start Time</label>
                <p className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800">{selectedAnnotation.startTime}s</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">End Time</label>
                <p className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800">{selectedAnnotation.endTime}s</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Label</label>
                <p className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800">{selectedAnnotation.label}</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Comments</label>
                <p className="min-h-[72px] rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800">
                  {selectedAnnotation.comment || "—"}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleEditOpen}
                  className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDeleteClick(selectedAnnotation)}
                  className="flex-1 rounded-lg border border-red-200 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition"
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Start Time</label>
                  <input
                    type="number"
                    step="0.1"
                    value={editStart}
                    onChange={(e) => setEditStart(e.target.value)}
                    className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${
                      editErrors.start ? "border-red-400" : "border-slate-200"
                    }`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">End Time</label>
                  <input
                    type="number"
                    step="0.1"
                    value={editEnd}
                    onChange={(e) => setEditEnd(e.target.value)}
                    className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${
                      editErrors.end ? "border-red-400" : "border-slate-200"
                    }`}
                  />
                </div>
              </div>
              {editErrors.start && <p className="text-xs text-red-500">{editErrors.start}</p>}
              {editErrors.end && <p className="text-xs text-red-500">{editErrors.end}</p>}

              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Label *</label>
                <input
                  type="text"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${
                    editErrors.label ? "border-red-400" : "border-slate-200"
                  }`}
                  placeholder="e.g. Koala bellow call"
                />
                {editErrors.label && <p className="mt-1 text-xs text-red-500">{editErrors.label}</p>}
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Comments</label>
                <textarea
                  value={editComment}
                  onChange={(e) => setEditComment(e.target.value)}
                  rows={3}
                  className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${
                    editErrors.comment ? "border-red-400" : "border-slate-200"
                  }`}
                  placeholder="Add a note about this annotation..."
                />
                {editErrors.comment && <p className="mt-1 text-xs text-red-500">{editErrors.comment}</p>}
              </div>

              {editWarning && <p className="text-xs text-amber-600">{editWarning}</p>}

              <div className="flex gap-2">
                <button
                  onClick={handleSaveEdit}
                  className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition"
                >
                  Save
                </button>
                <button
                  onClick={handleCancelEdit}
                  className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50 transition"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
          <div className="w-96 rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold text-slate-800">Delete Annotation</h3>
            <p className="mb-6 text-sm text-slate-500">
              Are you sure you want to delete{" "}
              <span className="font-medium text-slate-700">"{annotationToDelete?.label}"</span>? This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleConfirmDelete}
                className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-medium text-white hover:bg-red-700 transition"
              >
                Delete
              </button>
              <button
                onClick={handleCancelDelete}
                className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
