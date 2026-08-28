import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { auth, db } from "../services/firebase";
import { doc, getDoc } from "firebase/firestore";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import { Download, History, Share2, Maximize2 } from "lucide-react";

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
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const waveformRef = useRef(null);
  const wavesurferRef = useRef(null);

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
        {/* Left panel — placeholder, real form added in the next commit */}
        <div className="w-72 flex-shrink-0 border-r border-slate-200 bg-white px-4 py-4">
          <p className="text-sm text-slate-400">Annotation creation form coming in the next commit.</p>
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
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Annotations</h2>
            <p className="text-sm text-slate-400">Annotation list coming in the next commit (ADP-74).</p>
          </div>
        </div>

        {/* Right panel — placeholder, real details added in a later commit (ADP-13) */}
        <div className="w-80 flex-shrink-0 border-l border-slate-200 bg-white px-4 py-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Annotation Details</h2>
          <p className="text-sm text-slate-400">Coming in a later commit.</p>
        </div>
      </div>
    </div>
  );
}
