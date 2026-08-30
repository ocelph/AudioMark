import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { auth, db } from "../services/firebase";
import { doc, getDoc, collection, addDoc, updateDoc, deleteDoc, serverTimestamp, onSnapshot, query, orderBy } from "firebase/firestore";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import Spectrogram from "wavesurfer.js/dist/plugins/spectrogram.js";
import { Download, History, Share2, Maximize2, Search, Plus, X, Pencil, Trash2 } from "lucide-react";

// Default annotation classes shown in the "Annotation Class" picker.
// Custom classes added via "+ Create New Label" get a color from PALETTE.
const DEFAULT_CLASSES = [
  { name: "Default Label", color: "#22c55e" },
  { name: "Custom Label", color: "#3b82f6" },
  { name: "Miscellaneous", color: "#f97316" },
];
const PALETTE = ["#a855f7", "#ec4899", "#14b8a6", "#eab308", "#ef4444", "#06b6d4"];


const formatTimestamp = (seconds) => {
  const safeSeconds = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
  const totalMilliseconds = Math.round(safeSeconds * 1000);
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const secs = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
};

const splitTimestamp = (seconds) => {
  const safeSeconds = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
  const totalMilliseconds = Math.round(safeSeconds * 1000);

  return {
    hours: Math.floor(totalMilliseconds / 3600000),
    minutes: Math.floor((totalMilliseconds % 3600000) / 60000),
    seconds: Math.floor((totalMilliseconds % 60000) / 1000),
    milliseconds: totalMilliseconds % 1000,
  };
};

function TimestampInput({ label, value, onChange, hasError = false }) {
  const parts = splitTimestamp(value);

  const updatePart = (part, rawValue) => {
    let nextValue = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(nextValue)) nextValue = 0;

    if (part === "hours") nextValue = Math.max(0, nextValue);
    if (part === "minutes" || part === "seconds") nextValue = Math.min(59, Math.max(0, nextValue));
    if (part === "milliseconds") nextValue = Math.min(999, Math.max(0, nextValue));

    const next = { ...parts, [part]: nextValue };
    const totalSeconds =
      next.hours * 3600 +
      next.minutes * 60 +
      next.seconds +
      next.milliseconds / 1000;

    onChange(Number(totalSeconds.toFixed(3)));
  };

  const inputClass = `min-w-0 rounded-md border bg-white px-1 py-1.5 text-center text-sm tabular-nums outline-none focus:ring-2 focus:ring-indigo-300 ${hasError ? "border-red-400" : "border-slate-200"
    }`;

  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">{label}</label>
      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1.25fr] items-center gap-1">
        <input
          aria-label={`${label} hours`}
          title="Hours"
          type="number"
          min="0"
          value={parts.hours}
          onChange={(e) => updatePart("hours", e.target.value)}
          className={inputClass}
        />
        <span className="text-slate-400">:</span>
        <input
          aria-label={`${label} minutes`}
          title="Minutes"
          type="number"
          min="0"
          max="59"
          value={parts.minutes}
          onChange={(e) => updatePart("minutes", e.target.value)}
          className={inputClass}
        />
        <span className="text-slate-400">:</span>
        <input
          aria-label={`${label} seconds`}
          title="Seconds"
          type="number"
          min="0"
          max="59"
          value={parts.seconds}
          onChange={(e) => updatePart("seconds", e.target.value)}
          className={inputClass}
        />
        <span className="text-slate-400">.</span>
        <input
          aria-label={`${label} milliseconds`}
          title="Milliseconds"
          type="number"
          min="0"
          max="999"
          value={parts.milliseconds}
          onChange={(e) => updatePart("milliseconds", e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="mt-1 grid grid-cols-4 gap-2 text-center text-[10px] uppercase tracking-wide text-slate-400">
        <span>HH</span><span>MM</span><span>SS</span><span>MS</span>
      </div>
    </div>
  );
}

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
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioReady, setAudioReady] = useState(false);
  const [waveformError, setWaveformError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const waveformRef = useRef(null);
  const spectrogramRef = useRef(null);
  const wavesurferRef = useRef(null);
  const regionsRef = useRef(null);
  const activeRegionRef = useRef(null);
  const syncingRegionRef = useRef(false);

  // Temporary manual annotation creation (stand-in for waveform-drag creation)
  const [classes, setClasses] = useState(DEFAULT_CLASSES);
  const [classSearch, setClassSearch] = useState("");
  const [selectedClassIndex, setSelectedClassIndex] = useState(0);
  const [newLabelName, setNewLabelName] = useState("");
  const [createStart, setCreateStart] = useState(0);
  const [createEnd, setCreateEnd] = useState(0);
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

  // Initialise the shared WaveSurfer instance used by both visualisations.
  // The Spectrogram plugin is attached to the same instance, so its playback
  // position stays synchronised with the waveform automatically.
  useEffect(() => {
    if (!audioUrl || !waveformRef.current || !spectrogramRef.current || !uid) return;

    setAudioReady(false);
    setWaveformError("");
    setCurrentTime(0);
    setDuration(0);

    const regions = RegionsPlugin.create();
    const spectrogram = Spectrogram.create({
      container: spectrogramRef.current,
      labels: true,
      height: 180,
    });

    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: "rgba(99, 102, 241, 0.4)",
      progressColor: "#6366f1",
      cursorColor: "#1e1b4b",
      cursorWidth: 2,
      height: 130,
      barWidth: 2,
      barGap: 1,
      barRadius: 3,
      normalize: true,
      interact: true,
      url: audioUrl,
      plugins: [regions, spectrogram],
    });

    wavesurferRef.current = ws;

    regionsRef.current = regions;

    const unsubReady = ws.on("ready", (loadedDuration) => {
      setDuration(loadedDuration);
      setCurrentTime(0);
      setAudioReady(true);

      // Same WaveSurfer v7 pattern used in the standalone prototype:
      // drag across the waveform to create an annotation region.
      regions.enableDragSelection({
        color: "rgba(99, 102, 241, 0.25)",
      });
    });

    const unsubTime = ws.on("timeupdate", (time) => {
      setCurrentTime(time);
    });

    const syncCreateFormFromRegion = (region) => {
      if (!region || syncingRegionRef.current) return;

      activeRegionRef.current = region;
      setCreateStart(Number(region.start.toFixed(3)));
      setCreateEnd(Number(region.end.toFixed(3)));
      setCreateErrors({});
    };

    const unsubRegionCreated = regions.on("region-created", (region) => {
      // New-annotation mode keeps one active selection. If the user drags a
      // second region, discard the previous temporary selection.
      const previous = activeRegionRef.current;
      if (previous && previous !== region) {
        previous.remove();
      }

      syncCreateFormFromRegion(region);
    });

    const unsubRegionClicked = regions.on("region-clicked", (region, event) => {
      event?.stopPropagation?.();
      syncCreateFormFromRegion(region);
    });

    const unsubRegionUpdated = regions.on("region-updated", (region) => {
      syncCreateFormFromRegion(region);
    });

    const unsubPlay = ws.on("play", () => setIsPlaying(true));
    const unsubPause = ws.on("pause", () => setIsPlaying(false));
    const unsubFinish = ws.on("finish", () => {
      setIsPlaying(false);
      setCurrentTime(ws.getDuration());
    });

    const unsubError = ws.on("error", (err) => {
      console.error("WaveSurfer failed to load audio:", err);
      setAudioReady(false);
      setWaveformError("Unable to load the audio visualisation.");
    });

    return () => {
      unsubReady?.();
      unsubTime?.();
      unsubRegionCreated?.();
      unsubRegionClicked?.();
      unsubRegionUpdated?.();
      unsubPlay?.();
      unsubPause?.();
      unsubFinish?.();
      unsubError?.();
      activeRegionRef.current = null;
      regionsRef.current = null;
      wavesurferRef.current = null;
      ws.destroy();
    };
  }, [audioUrl, uid]);

  const handleStopPlayback = () => {
    const ws = wavesurferRef.current;
    if (!ws) return;

    ws.pause();
    ws.setTime(0);
    setCurrentTime(0);
    setIsPlaying(false);
  };

  const clampToDuration = (time) => {
    const numeric = Number(time);
    if (!Number.isFinite(numeric)) return 0;
    if (duration > 0) return Math.min(Math.max(0, numeric), duration);
    return Math.max(0, numeric);
  };

  const updateActiveRegionFromTimestamps = (nextStart, nextEnd) => {
    const region = activeRegionRef.current;
    if (!region || !audioReady) return;

    const start = clampToDuration(nextStart);
    const end = clampToDuration(nextEnd);

    // Do not ask WaveSurfer to render an invalid/zero-length selection.
    if (end <= start) return;

    syncingRegionRef.current = true;
    region.setOptions({ start, end });
    syncingRegionRef.current = false;
  };

  const handleCreateStartChange = (nextStart) => {
    const start = clampToDuration(nextStart);
    setCreateStart(start);
    setCreateErrors((prev) => ({ ...prev, start: undefined }));
    updateActiveRegionFromTimestamps(start, createEnd);
  };

  const handleCreateEndChange = (nextEnd) => {
    const end = clampToDuration(nextEnd);
    setCreateEnd(end);
    setCreateErrors((prev) => ({ ...prev, end: undefined }));
    updateActiveRegionFromTimestamps(createStart, end);
  };

  const handlePlaySelection = () => {
    const region = activeRegionRef.current;
    if (!region) {
      setCreateWarning("Drag across the waveform to select a region first.");
      return;
    }

    setCreateWarning("");
    region.play();
  };

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
      setCreateStart(0);
      setCreateEnd(0);
      setCreateComment("");
      setCreateErrors({});
      setCreateWarning("");

      // The selected waveform region represented the annotation being created.
      // Clear it after the annotation has been saved successfully.
      activeRegionRef.current?.remove();
      activeRegionRef.current = null;
    } catch (err) {
      console.error("Failed to create annotation:", err);
    }
  };

  const handleEditOpen = (annotation) => {
    setSelectedAnnotation(annotation);
    setEditLabel(annotation.label);
    setEditStart(annotation.startTime);
    setEditEnd(annotation.endTime);
    setEditComment(annotation.comment || "");
    setEditErrors({});
    setEditWarning("");
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
      setSelectedAnnotation(null);
      setIsEditing(false);
      setEditErrors({});
      setEditWarning("");
    } catch (err) {
      console.error("Failed to update annotation:", err);
    }
  };

  const handleCancelEdit = () => {
    setSelectedAnnotation(null);
    setIsEditing(false);
    setEditErrors({});
    setEditWarning("");
  };

  const handleClosePanel = () => {
    setSelectedAnnotation(null);
    setIsEditing(false);
    setEditErrors({});
    setEditWarning("");
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
          <div className="mb-4 space-y-3">
            <TimestampInput
              label="Start"
              value={createStart}
              onChange={handleCreateStartChange}
              hasError={Boolean(createErrors.start)}
            />
            <TimestampInput
              label="End"
              value={createEnd}
              onChange={handleCreateEndChange}
              hasError={Boolean(createErrors.end)}
            />
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
                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${selectedClassIndex === idx ? "bg-indigo-50 text-indigo-700" : "hover:bg-slate-50 text-slate-700"
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
            className={`mb-2 w-full rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${createErrors.comment ? "border-red-400" : "border-slate-200"
              }`}
            placeholder="Add a note about this annotation..."
          />
          {createErrors.comment && <p className="mb-2 text-xs text-red-500">{createErrors.comment}</p>}
          {createWarning && <p className="mb-2 text-xs text-amber-600">{createWarning}</p>}

          <button
            onClick={handleCreateAnnotation}
            className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition"
          >
            Save Annotation
          </button>
          <p className="mt-2 text-xs text-slate-400">
            Set the time precisely here. Waveform region selection will populate these fields in the next step.
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
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Audio visualisation
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  Click to seek, or drag across the waveform to select a new annotation region.
                </p>
              </div>
              <div className="whitespace-nowrap text-sm tabular-nums text-slate-500">
                {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
              </div>
            </div>

            {waveformError && (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                {waveformError}
              </div>
            )}

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              <div className="border-b border-slate-200 bg-white px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                Waveform
              </div>
              <div ref={waveformRef} className="w-full px-2 py-3" />

              <div className="border-y border-slate-200 bg-white px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                Spectrogram
              </div>
              <div ref={spectrogramRef} className="w-full overflow-hidden bg-slate-950" />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                onClick={() => wavesurferRef.current?.playPause()}
                disabled={!audioReady}
                className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
              >
                {isPlaying ? "⏸ Pause" : "▶ Play"}
              </button>
              <button
                onClick={handleStopPlayback}
                disabled={!audioReady}
                className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                ■ Stop
              </button>
              <button
                onClick={handlePlaySelection}
                disabled={!audioReady}
                className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                ▶ Play Selection
              </button>
              {!audioReady && !waveformError && (
                <span className="text-xs text-slate-400">Loading waveform and spectrogram…</span>
              )}
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
                            className="border-t border-slate-100 bg-white transition hover:bg-slate-50"
                          >
                            <td className="px-3 py-2 text-slate-700 tabular-nums">{formatTimestamp(ann.startTime)}</td>
                            <td className="px-3 py-2 text-slate-700 tabular-nums">{formatTimestamp(ann.endTime)}</td>
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
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handleEditOpen(ann)}
                                  className="rounded-lg p-1.5 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600 transition"
                                  title="Edit annotation"
                                  aria-label={`Edit ${ann.label || "annotation"}`}
                                >
                                  <Pencil className="h-4 w-4" />
                                </button>
                                <button
                                  onClick={() => handleDeleteClick(ann)}
                                  className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 transition"
                                  title="Delete annotation"
                                  aria-label={`Delete ${ann.label || "annotation"}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
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

        {/* selectedAnnotation && isEditing && */}
        {true && (
          <>
            {/* Drag handle — resize edit panel */}
            <div
              onMouseDown={() => (resizingRef.current = "right")}
              className="w-1.5 flex-shrink-0 cursor-col-resize bg-slate-100 hover:bg-indigo-200 transition"
            />

            {/* Right panel — only opens after Edit is selected from the annotation list */}
            <div style={{ width: rightWidth }} className="flex-shrink-0 overflow-y-auto border-l border-slate-200 bg-white px-4 py-4">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700">Edit Annotation</h2>
                <button onClick={handleClosePanel} className="text-slate-400 hover:text-slate-600 transition" aria-label="Close edit panel">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex flex-col gap-4">
                <TimestampInput
                  label="Start Time"
                  value={editStart}
                  onChange={setEditStart}
                  hasError={Boolean(editErrors.start)}
                />
                {editErrors.start && <p className="text-xs text-red-500">{editErrors.start}</p>}

                <TimestampInput
                  label="End Time"
                  value={editEnd}
                  onChange={setEditEnd}
                  hasError={Boolean(editErrors.end)}
                />
                {editErrors.end && <p className="text-xs text-red-500">{editErrors.end}</p>}

                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Label *</label>
                  <input
                    type="text"
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${editErrors.label ? "border-red-400" : "border-slate-200"
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
                    rows={4}
                    className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${editErrors.comment ? "border-red-400" : "border-slate-200"
                      }`}
                    placeholder="Add a note about this annotation..."
                  />
                  {editErrors.comment && <p className="mt-1 text-xs text-red-500">{editErrors.comment}</p>}
                </div>

                {editWarning && <p className="text-xs text-amber-600">{editWarning}</p>}

                <div className="flex gap-2 pt-2">
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
            </div>
          </>
        )}
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
