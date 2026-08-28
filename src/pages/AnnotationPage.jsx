import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { auth, db } from "../services/firebase";
import { doc, getDoc, collection, addDoc, serverTimestamp, onSnapshot, query, orderBy } from "firebase/firestore";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import { Download, History, Share2, Maximize2, Search, Plus } from "lucide-react";

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

export default function AnnotationPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();

  const [uid, setUid] = useState(null);
  const [userInitials, setUserInitials] = useState("U");
  const [audioUrl, setAudioUrl] = useState(null);
  const [fileName, setFileName] = useState("");
  const [annotations, setAnnotations] = useState([]);
  const [selectedAnnotation, setSelectedAnnotation] = useState(null);
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
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    try {
      await addDoc(collection(db, "users", uid, "projects", projectId, "annotations"), {
        startTime: start,
        endTime: end,
        label: classes[selectedClassIndex]?.name || "Default Class",
        annotationClass: classes[selectedClassIndex],
        comment: createComment.trim(),
        createdAt: serverTimestamp(),
      });
      setCreateStart("");
      setCreateEnd("");
      setCreateComment("");
    } catch (err) {
      console.error("Failed to create annotation:", err);
    }
  };

  const handleSelectAnnotation = (annotation) => {
    setSelectedAnnotation(annotation);
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
        <div className="w-72 flex-shrink-0 overflow-y-auto border-r border-slate-200 bg-white px-4 py-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Timestamps</h2>
          <div className="mb-4 grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Start (s)</label>
              <input
                type="number"
                step="0.1"
                value={createStart}
                onChange={(e) => setCreateStart(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">End (s)</label>
              <input
                type="number"
                step="0.1"
                value={createEnd}
                onChange={(e) => setCreateEnd(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </div>
          </div>

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
            className="mb-4 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-300"
            placeholder="Add a note about this annotation..."
          />

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

        {/* Center — waveform + annotation list placeholder */}
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
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right panel — Annotation Details */}
        <div className="w-80 flex-shrink-0 border-l border-slate-200 bg-white px-4 py-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Annotation Details</h2>
          {!selectedAnnotation ? (
            <p className="text-sm text-slate-400">Select an annotation from the table to view its details.</p>
          ) : (
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
